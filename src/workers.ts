import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { config, downloadDir, profileDir } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { AppError, Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import type { ChromeRuntime } from "./chrome.js";
import type { Principal } from "./auth.js";
import { launchEstimate } from "./host-limits.js";
import { forwardHttp, forwardUpgrade, type RelayTarget } from "./relay.js";
import { makeJoinToken, MAX_UPLOAD_BYTES, receiveProfile, sha256, uploadStaging, type WorkerStartResult, type WorkerState } from "./worker.js";
import { MAX_CHUNK, serveTunnelDials } from "./tunnels.js";
import { remoteSpawner } from "./x11-remote.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLinkedBridgeTransport, LINKED_BRIDGE_THREADS } from "./linked-bridge.js";
import { bridgeResultFiles, prepareBridgeFiles, receiveBridgeFile, replaceBridgePaths } from "./bridge-files.js";
import type { BrowserManager, BrowserRow } from "./browsers.js";

export type WorkerRow = {
  id: string;
  name: string;
  url: string;
  /** Internal. Never serialize the raw row. */
  secret: string;
  version: string | null;
  created_at: string;
  last_seen_at: string | null;
};

const POLL_MS = 5_000;
const JOIN_TOKEN_TTL_MS = 60 * 60_000;
/** A worker's state counts as current for this long; past it the worker reads as offline. */
const FRESH_MS = 15_000;
/** Polls that must fail in a row before a worker's browsers are given up as gone. */
const GONE_AFTER = 3;
const LAUNCH_WINDOW_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;

type Live = { state: WorkerState | null; at: number; error: string | null; failures: number; seenWritten: number };
type RemoteBrowser = {
  workerId: string;
  exited: () => void;
  startedAt: number;
  launchPeak: number;
  peak: number;
  savedPeak: number;
  launchSaved: boolean;
};

/**
 * The main instance's view of its workers (see worker.ts for what a worker is).
 *
 * A browser with a worker_id has its Chrome and its profile on that worker. Here it is a
 * runtime like any other, whose debugging port happens to be a local listener that relays to
 * the worker with its secret, the same shape a linked browser already has. So the MCP bridge,
 * the live view and everything else that speaks CDP work without knowing the difference.
 * Linked browsers keep that connection on main and place each MCP bridge separately;
 * those transient assignments never change the browser's worker_id or profile ownership.
 *
 * What needs the host rather than the debugging port reaches the worker by its own path.
 * Full browser and the agent desktop tools run their ffmpeg and xdotool there
 * (x11-remote.ts), a tunnel's streams cross on one socket per browser (tunnels.ts,
 * serveTunnelDials), and a file for upload_file is copied across first (stageUploads).
 * What does not cross is saved profiles, which are
 * kept on the main instance and refused on a worker's browser by name. The room held for
 * pinned browsers is also per host: on a worker a start is checked against that worker's
 * ceiling, and nothing is stopped to make room for it.
 */
export class Workers {
  private live = new Map<string, Live>();
  private remote = new Map<string, RemoteBrowser>();
  private bridges = new Map<string, { workerId: string; close: () => Promise<void> }>();
  private timer: NodeJS.Timeout;

  constructor(private fleet: BrowserManager) {
    this.timer = setInterval(() => {
      void this.poll().catch((e) => log.warn("worker poll failed", { error: (e as Error).message }));
    }, POLL_MS);
    this.timer.unref?.();
  }

  stopPolling(): void {
    clearInterval(this.timer);
  }

  rows(): WorkerRow[] {
    return getDb().prepare(`SELECT * FROM workers ORDER BY created_at`).all() as WorkerRow[];
  }

  row(id: string): WorkerRow {
    const w = getDb().prepare(`SELECT * FROM workers WHERE id = ?`).get(id) as WorkerRow | undefined;
    if (!w) throw Err.notFound("worker not found");
    return w;
  }

  online(id: string): boolean {
    const l = this.live.get(id);
    return Boolean(l && l.state && !l.error && Date.now() - l.at < FRESH_MS);
  }

  /** Whether a worker can show its browsers' displays. It runs this image, so as this instance can until it says otherwise. */
  fullBrowser(id: string): boolean {
    return this.live.get(id)?.state?.fullBrowser ?? config.fullBrowser;
  }

  /** Why a worker cannot be given a browser right now, or null when it can. */
  unusable(w: WorkerRow): string | null {
    const l = this.live.get(w.id);
    const version = l?.state?.version ?? w.version;
    if (version && version !== config.release) {
      return `Worker ${w.name} runs ${version} and this instance runs ${config.release}. Deploy the same release on both.`;
    }
    if (l?.error && !this.online(w.id)) return `Worker ${w.name} cannot be reached at ${w.url}: ${l.error}`;
    return null;
  }

  view(w: WorkerRow) {
    const l = this.live.get(w.id);
    const pids = l?.state?.pids ?? null;
    const assigned = (getDb().prepare(`SELECT COUNT(*) AS n FROM browsers WHERE worker_id = ?`).get(w.id) as { n: number }).n;
    return {
      id: w.id,
      name: w.name,
      url: w.url,
      version: l?.state?.version ?? w.version,
      online: this.online(w.id),
      // One sentence an operator can act on: unreachable, or on the wrong release.
      problem: this.unusable(w),
      pids,
      browsers: assigned,
      running: l?.state?.browsers.filter((b) => b.running).length ?? 0,
      linkedBridges: l?.state?.linkedBridges?.length ?? 0,
      createdAt: w.created_at,
      lastSeenAt: l?.state && !l.error ? new Date(l.at).toISOString() : w.last_seen_at,
    };
  }

  list() {
    return this.rows().map((w) => this.view(w));
  }

  /** What a browser on a worker is using, from that worker's last report. */
  usage(browserId: string): { threads: number | null; processes: number | null } | null {
    const rec = this.remote.get(browserId);
    const b = rec ? this.live.get(rec.workerId)?.state?.browsers.find((x) => x.id === browserId) : undefined;
    return b ? { threads: b.threads, processes: b.processes } : null;
  }

  createJoinToken(principal: Principal): { token: string; expiresAt: string } {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can add a worker");
    const secret = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + JOIN_TOKEN_TTL_MS).toISOString();
    getDb()
      .prepare(`INSERT INTO worker_join_tokens(id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(randomBytes(8).toString("hex"), sha256(secret), nowIso(), expiresAt);
    audit({ actorType: principal.type, actorId: principal.id, action: "worker.join_token.created" });
    return { token: makeJoinToken(config.publicUrl, secret), expiresAt };
  }

  /** A worker presenting a join token. Unauthenticated by design: the token is the credential. */
  join(input: { token?: unknown; name?: unknown; url?: unknown; version?: unknown }): { workerId: string; secret: string } {
    const token = typeof input.token === "string" ? input.token : "";
    const about = this.about(input);
    const t = getDb().prepare(`SELECT id, expires_at, used_at FROM worker_join_tokens WHERE token_hash = ?`).get(sha256(token)) as
      | { id: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!t) throw Err.unauthorized("That join token is not from this instance. Copy it again from Add worker.");
    if (t.used_at) throw Err.unauthorized("That join token has already been used. A token adds one worker; make a new one with Add worker.");
    if (Date.parse(t.expires_at) < Date.now()) throw Err.unauthorized("That join token has expired. Make a new one with Add worker.");
    if (about.version !== config.release) {
      throw Err.conflict(`This worker runs ${about.version} and the main instance runs ${config.release}. Deploy the same release on both.`);
    }
    const id = `wkr_${randomBytes(6).toString("hex")}`;
    const secret = randomBytes(32).toString("hex");
    getDb()
      .prepare(`INSERT INTO workers(id, name, url, secret, version, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, about.name, about.url, secret, about.version, nowIso(), nowIso());
    getDb().prepare(`UPDATE worker_join_tokens SET used_at = ?, worker_id = ? WHERE id = ?`).run(nowIso(), id, t.id);
    audit({ actorType: "worker", actorId: id, action: "worker.joined", targetType: "worker", targetId: id, detail: { name: about.name, url: about.url } });
    hub.emitEvent("worker.joined", { id, name: about.name });
    void this.poll().catch(() => undefined);
    return { workerId: id, secret };
  }

  /** A worker that has restarted. Whatever it was running is gone, and its address may have changed. */
  hello(input: { workerId?: unknown; secret?: unknown; name?: unknown; url?: unknown; version?: unknown }): { ok: true } {
    const w = typeof input.workerId === "string"
      ? (getDb().prepare(`SELECT * FROM workers WHERE id = ?`).get(input.workerId) as WorkerRow | undefined)
      : undefined;
    const secret = typeof input.secret === "string" ? input.secret : "";
    if (!w || !timingSafeEqual(Buffer.from(sha256(secret), "hex"), Buffer.from(sha256(w.secret), "hex"))) {
      throw Err.unauthorized("This instance does not know that worker. It may have been removed.");
    }
    const about = this.about(input);
    getDb().prepare(`UPDATE workers SET name = ?, url = ?, version = ?, last_seen_at = ? WHERE id = ?`).run(about.name, about.url, about.version, nowIso(), w.id);
    for (const [id, rec] of this.remote) if (rec.workerId === w.id) this.gone(id, rec);
    hub.emitEvent("worker.updated", { id: w.id });
    void this.poll().catch(() => undefined);
    return { ok: true };
  }

  private about(input: { name?: unknown; url?: unknown; version?: unknown }): { name: string; url: string; version: string } {
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "worker";
    const url = typeof input.url === "string" ? input.url.replace(/\/$/, "") : "";
    const version = typeof input.version === "string" ? input.version.slice(0, 40) : "";
    if (!/^https?:\/\/[^/\s]+$/.test(url)) throw Err.invalid("a worker must say where it is reachable, as http://host:port");
    if (!version) throw Err.invalid("a worker must say which release it runs");
    return { name, url, version };
  }

  remove(id: string, principal: Principal): void {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can remove a worker");
    const w = this.row(id);
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM browsers WHERE worker_id = ?`).get(id) as { n: number }).n;
    if (n > 0) {
      throw Err.conflict(`${n === 1 ? "1 browser still lives" : `${n} browsers still live`} on ${w.name}. Move or delete ${n === 1 ? "it" : "them"} first.`);
    }
    for (const bridge of this.bridges.values()) if (bridge.workerId === id) void bridge.close();
    getDb().prepare(`DELETE FROM workers WHERE id = ?`).run(id);
    this.live.delete(id);
    audit({ actorType: principal.type, actorId: principal.id, action: "worker.removed", targetType: "worker", targetId: id, detail: { name: w.name } });
    hub.emitEvent("worker.removed", { id });
  }

  /**
   * Where a new browser goes when nobody says (config.placement). Null is this instance. A
   * host with no process ceiling has all the room there is, so a main instance off Railway
   * keeps its browsers under either policy.
   */
  pick(): string | null {
    const policy = config.placement;
    if (policy === "local") return null;
    const host = this.fleet.capacity.hostView();
    const localFree = "free" in host && host.pids ? (host.free ?? 0) - (host.headroom ?? 0) - (host.held ?? 0) : Infinity;
    if (policy === "overflow" && localFree >= config.browserThreads) return null;
    let best: { id: string | null; free: number } = { id: null, free: localFree };
    for (const w of this.rows()) {
      if (!this.online(w.id) || this.unusable(w)) continue;
      const pids = this.live.get(w.id)?.state?.pids;
      const free = pids ? pids.max - pids.current - config.processHeadroom : Infinity;
      if (free > best.free) best = { id: w.id, free };
    }
    return best.id;
  }

  /** Linked Chrome stays on its owner's machine; only the session's Node bridge moves. */
  async linkedBridge(cdpPort: number) {
    if (config.placement === "local") return null;
    const candidates = this.rows().flatMap((w) => {
      const live = this.live.get(w.id);
      if (!this.online(w.id) || this.unusable(w) || !live?.state?.linkedBridges || !live.state.linkedBridgeFilesRoot) return [];
      const held = [...this.bridges].filter(([, b]) => b.workerId === w.id).reduce((n, [id]) => {
        const reported = live.state!.linkedBridges!.find((b) => b.id === id);
        return n + Math.max(0, LINKED_BRIDGE_THREADS - (reported?.threads ?? 0));
      }, 0);
      const pids = live.state.pids;
      const free = (pids ? pids.max - pids.current - config.processHeadroom : Number.MAX_SAFE_INTEGER) - held;
      return free >= LINKED_BRIDGE_THREADS ? [{ w, free }] : [];
    }).sort((a, b) => b.free - a.free);
    for (const { w } of candidates) {
      const bridgeId = randomBytes(16).toString("hex");
      const url = w.url.replace(/^http/, "ws") + `/worker/v1/linked-bridges/${bridgeId}/mcp`;
      const transport = createLinkedBridgeTransport(url, w.secret, cdpPort);
      const client = new Client({ name: "tallylamp-bridge", version: config.version });
      const release = () => { this.bridges.delete(bridgeId); };
      client.onclose = release;
      this.bridges.set(bridgeId, { workerId: w.id, close: () => client.close() });
      try {
        await client.connect(transport);
        return { client, transport, workerId: w.id, bridgeId, release };
      } catch (e) {
        release();
        await client.close().catch(() => undefined);
        // Initialization runs no browser tools, so another host is safe to try here.
        log.warn("linked bridge worker unavailable", { worker: w.name, error: (e as Error).message });
      }
    }
    return null;
  }

  async callLinkedTool(bridge: { client: Client; workerId: string; bridgeId: string }, name: string, args: Record<string, unknown>, beforeCall: () => void) {
    const w = this.row(bridge.workerId);
    const root = this.live.get(w.id)?.state?.linkedBridgeFilesRoot;
    if (!root) throw Err.browserUnavailable("Worker does not report a control-bridge artifact directory.");
    const directory = path.posix.join(root, bridge.bridgeId);
    const prepared = await prepareBridgeFiles(directory, name, args);
    beforeCall();
    const result = await bridge.client.callTool({ name, arguments: prepared.args });
    if (result.isError) return replaceBridgePaths(result, prepared.files.map((f): [string, string] => [f.remote, f.local]));
    const replacements: Array<[string, string]> = [];
    for (const file of bridgeResultFiles(directory, result, prepared.files)) {
      const relative = path.posix.relative(directory, file.remote);
      const url = `${w.url}/worker/v1/linked-bridges/${bridge.bridgeId}/files?path=${encodeURIComponent(relative)}`;
      for (let attempt = 0; ; attempt++) {
        let transient = true;
        try {
          const response = await fetch(url, { headers: { authorization: `Bearer ${w.secret}` }, signal: AbortSignal.timeout(60_000) });
          if (!response.ok) {
            transient = response.status === 429 || response.status >= 500;
            await response.body?.cancel();
            throw new Error(`Worker artifact download returned HTTP ${response.status}`);
          }
          transient = false;
          replacements.push(await receiveBridgeFile(response, file));
          break;
        } catch (e) {
          transient ||= e instanceof TypeError || ["AbortError", "TimeoutError"].includes((e as Error).name);
          if (!transient || attempt >= 2) throw Err.browserUnavailable(`The tool ran, but its output file could not be copied from ${w.name}: ${(e as Error).message}. The tool has not been repeated.`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt * (0.5 + Math.random())));
        }
      }
    }
    return replaceBridgePaths(result, replacements);
  }

  private target(w: WorkerRow, p: string): RelayTarget {
    const u = new URL(w.url);
    return {
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      path: p,
      headers: { authorization: `Bearer ${w.secret}` },
    };
  }

  private unreachable(w: WorkerRow, e: unknown): AppError {
    return Err.browserUnavailable(
      `Worker ${w.name} cannot be reached at ${w.url}: ${(e as Error).message}. ` +
        `Check that it is running, and that it is in the same Railway project as this instance.`,
    );
  }

  private async call<T>(w: WorkerRow, method: string, p: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(w.url + p, {
        method,
        headers: { authorization: `Bearer ${w.secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw this.unreachable(w, e);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (res.ok) return json as T;
    throw this.refused(w, res.status, json);
  }

  private refused(w: WorkerRow, status: number, json: { error?: { code?: string; message?: string } }): AppError {
    const message = json.error?.message ?? `HTTP ${status}`;
    if (status === 401) {
      return Err.browserUnavailable(`Worker ${w.name} refused this instance. It may have joined another one; remove it here and add it again.`);
    }
    if (json.error?.code === "fleet_full") return Err.fleetFull(message);
    return Err.browserUnavailable(`Worker ${w.name}: ${message}`);
  }

  /** Start a browser's Chrome on its worker and stand a local debugging endpoint in front of it. */
  async startRuntime(row: BrowserRow): Promise<{ runtime: ChromeRuntime; close: () => Promise<void>; chromeVersion: string | null }> {
    const w = this.row(row.worker_id!);
    const problem = this.unusable(w);
    if (problem) throw Err.browserUnavailable(problem);
    const started = await this.call<WorkerStartResult>(
      w,
      "POST",
      `/worker/v1/browsers/${row.id}/start`,
      {
        estimate: launchEstimate(row.launch_threads),
        unmeasuredEstimate: config.browserThreads,
        extensionsEnabled: Boolean(row.extensions_enabled),
        proxy: row.proxy_json ? JSON.parse(row.proxy_json) : null,
      },
      config.startupTimeoutMs + 15_000,
    );
    const stopRemote = () =>
      this.call(w, "POST", `/worker/v1/browsers/${row.id}/stop`, undefined, config.shutdownTimeoutMs + 10_000).catch((e) =>
        log.warn("could not stop a browser on its worker", { id: row.id, worker: w.name, error: (e as Error).message }),
      );
    let shim: { port: number; close: () => Promise<void> };
    try {
      shim = await this.openShim(w, row.id);
    } catch (e) {
      await stopRemote();
      throw e;
    }
    // Nothing on this host to signal or wait for. `exitCode` is what the rest of Tallylamp
    // reads to tell a live runtime from a dead one, and the poll below is what sets it.
    const chrome = { pid: undefined, exitCode: null as number | null, signalCode: null, kill: () => true, unref: () => undefined };
    const rec: RemoteBrowser = {
      workerId: w.id,
      exited: () => { chrome.exitCode ??= 1; },
      startedAt: Date.now(),
      launchPeak: 0,
      peak: 0,
      savedPeak: row.peak_threads ?? 0,
      launchSaved: false,
    };
    this.remote.set(row.id, rec);
    const runtime: ChromeRuntime = {
      display: started.display,
      cdpPort: shim.port,
      cdpUrl: `http://127.0.0.1:${shim.port}`,
      chrome: chrome as unknown as ChildProcess,
      sandboxStatus: started.sandboxStatus,
      gpuStatus: started.gpuStatus,
      profileDir: row.profile_path,
      downloadDir: downloadDir(row.id),
      screen: started.screen,
      // Full browser and the desktop tools, run against the display on the worker.
      ...(started.display
        ? {
            desktopSpawn: remoteSpawner((body, signal) =>
              fetch(`${w.url}/worker/v1/browsers/${row.id}/x11`, {
                method: "POST",
                headers: { authorization: `Bearer ${w.secret}`, "content-type": "application/json" },
                body: JSON.stringify(body),
                signal,
              }),
            ),
          }
        : {}),
    };
    const stopTunnel = this.keepTunnel(w, row.id);
    const close = async () => {
      if (this.remote.get(row.id) === rec) this.remote.delete(row.id);
      stopTunnel();
      rmSync(uploadStaging(row.id), { recursive: true, force: true });
      await stopRemote();
      await shim.close();
    };
    return { runtime, close, chromeVersion: started.chromeVersion };
  }

  /**
   * Hold the socket a worker asks this instance's tunnels through, for as long as the browser
   * runs there, and open it again when it drops. It carries nothing until a page in that
   * browser dials a private address. Returns what stops it.
   */
  private keepTunnel(w: WorkerRow, id: string): () => void {
    const url = `${w.url.replace(/^http/, "ws")}/worker/v1/browsers/${id}/tunnel`;
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: NodeJS.Timeout | undefined;
    const connect = () => {
      if (stopped) return;
      const sock = new WebSocket(url, { headers: { authorization: `Bearer ${w.secret}` }, maxPayload: MAX_CHUNK + 64 * 1024 });
      ws = sock;
      sock.on("open", () => serveTunnelDials(sock, id));
      sock.on("error", () => undefined);
      sock.on("close", () => {
        if (stopped || ws !== sock) return;
        retry = setTimeout(connect, 2_000);
        retry.unref?.();
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.terminate();
    };
  }

  /**
   * upload_file for a browser on a worker. The bridge reads the path here and Chrome reads it
   * there, so each file is put at one path on both hosts, under a folder of its own, and the
   * paths the bridge is given are those.
   *
   * Only a file the bridge would have taken anyway is copied: one under this instance's temp
   * directory, which is where it accepts files from. Anything else goes through unchanged, and
   * the bridge refuses it with its own message, as it would for a browser here. Copying first
   * would let an agent upload any file on this instance, its database included.
   */
  async stageUploads(row: BrowserRow, filePaths: unknown): Promise<unknown> {
    if (!Array.isArray(filePaths) || filePaths.length > 16 || !filePaths.every((f) => typeof f === "string")) return filePaths;
    const w = this.row(row.worker_id!);
    const tmp = realpathSync(os.tmpdir());
    const staging = uploadStaging(row.id);
    const out: string[] = [];
    for (const asked of filePaths as string[]) {
      let real: string;
      try {
        real = realpathSync(path.resolve(asked));
      } catch {
        out.push(asked);
        continue;
      }
      // Already waiting on both hosts, from an earlier call.
      if (real.startsWith(staging + path.sep)) {
        out.push(real);
        continue;
      }
      // Not a file the bridge takes. It refuses it, with its own message.
      if (!real.startsWith(tmp + path.sep)) {
        out.push(asked);
        continue;
      }
      const st = statSync(real);
      if (!st.isFile()) throw Err.invalid(`${asked} is not a file`);
      if (st.size > MAX_UPLOAD_BYTES) throw Err.invalid(`${asked} is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB a browser on a worker can be sent`);
      const dir = randomBytes(6).toString("hex");
      const name = path.basename(real);
      const here = path.join(staging, dir, name);
      mkdirSync(path.dirname(here), { recursive: true });
      try {
        linkSync(real, here);
      } catch {
        copyFileSync(real, here);
      }
      let res: Response;
      try {
        res = await fetch(`${w.url}/worker/v1/browsers/${row.id}/uploads/${dir}/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${w.secret}`, "content-type": "application/octet-stream" },
          body: Readable.toWeb(createReadStream(here)) as ReadableStream<Uint8Array>,
          duplex: "half",
          signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        } as RequestInit);
      } catch (e) {
        throw this.unreachable(w, e);
      }
      const body = (await res.json().catch(() => ({}))) as { path?: string; error?: { code?: string; message?: string } };
      if (!res.ok) throw this.refused(w, res.status, body);
      if (body.path !== here) {
        throw Err.browserUnavailable(
          `Worker ${w.name} keeps uploads at ${body.path ?? "an unknown path"} and this instance at ${here}, so the file cannot be handed to its Chrome. Give both the same temp directory.`,
        );
      }
      out.push(here);
    }
    return out;
  }

  /**
   * A listener on this host that is the browser's debugging port as far as any client can
   * tell. Chrome's /json answers name its own address, which no client here can reach, so
   * those are rewritten to name this listener.
   */
  private openShim(w: WorkerRow, id: string): Promise<{ port: number; close: () => Promise<void> }> {
    const base = `/worker/v1/browsers/${id}/cdp`;
    let port = 0;
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (!url.startsWith("/json")) {
        forwardHttp(req, res, this.target(w, base + url));
        return;
      }
      fetch(w.url + base + url, { method: req.method, headers: { authorization: `Bearer ${w.secret}` }, signal: AbortSignal.timeout(10_000) })
        .then(async (r) => {
          const text = (await r.text()).replace(/(ws:\/\/|ws=)[^/"\s]+(\/devtools\/)/g, (_m, a: string, b: string) => `${a}127.0.0.1:${port}${b}`);
          res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
          res.end(text);
        })
        .catch((e) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        });
    });
    server.on("upgrade", (req, socket, head) => forwardUpgrade(req, socket, head, this.target(w, base + (req.url ?? "/"))));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          port,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections?.();
              server.close(() => done());
              setTimeout(done, 500).unref?.();
            }),
        });
      });
    });
  }

  /** Delete a browser's profile and downloads on its worker. Throws when the worker cannot confirm it. */
  async deleteBrowser(row: BrowserRow): Promise<void> {
    await this.call(this.row(row.worker_id!), "DELETE", `/worker/v1/browsers/${row.id}`);
  }

  /** Capacity.forget, for a browser running on a worker. */
  forget(id: string): void {
    const rec = this.remote.get(id);
    if (!rec) return;
    rec.launchPeak = 0;
    rec.launchSaved = true;
    rec.peak = 0;
    rec.savedPeak = 0;
  }

  private gone(id: string, rec: RemoteBrowser): void {
    if (this.remote.get(id) === rec) this.remote.delete(id);
    rec.exited();
  }

  /** Ask every worker what it is running, and square that with what this instance believes. */
  async poll(): Promise<void> {
    await Promise.all(this.rows().map((w) => this.pollOne(w)));
  }

  private async pollOne(w: WorkerRow): Promise<void> {
    const asked = Date.now();
    const prev = this.live.get(w.id);
    let state: WorkerState;
    try {
      state = await this.call<WorkerState>(w, "GET", "/worker/v1/state", undefined, 4_000);
    } catch (e) {
      const failures = (prev?.failures ?? 0) + 1;
      this.live.set(w.id, { state: prev?.state ?? null, at: prev?.at ?? 0, error: (e as Error).message, failures, seenWritten: prev?.seenWritten ?? 0 });
      if (failures === GONE_AFTER) {
        // Its browsers may well still be running over there, but nothing here can reach them.
        for (const [id, rec] of this.remote) if (rec.workerId === w.id) this.gone(id, rec);
      }
      if (!prev?.error) hub.emitEvent("worker.updated", { id: w.id });
      return;
    }
    const now = Date.now();
    let seenWritten = prev?.seenWritten ?? 0;
    if (now - seenWritten > 60_000 || state.version !== w.version) {
      getDb().prepare(`UPDATE workers SET last_seen_at = ?, version = ? WHERE id = ?`).run(nowIso(), state.version, w.id);
      seenWritten = now;
    }
    this.live.set(w.id, { state, at: now, error: null, failures: 0, seenWritten });
    if (!prev || prev.error) hub.emitEvent("worker.updated", { id: w.id });

    const reported = new Map(state.browsers.map((b) => [b.id, b]));
    for (const [id, rec] of this.remote) {
      if (rec.workerId !== w.id) continue;
      const b = reported.get(id);
      // Started after this poll was sent: the answer predates it, and says nothing about it.
      if (!b && rec.startedAt > asked - 1_000) continue;
      if (!b || !b.running) {
        this.gone(id, rec);
        continue;
      }
      if (b.threads === null) continue;
      rec.peak = Math.max(rec.peak, b.threads);
      if (now - rec.startedAt < LAUNCH_WINDOW_MS) {
        rec.launchPeak = Math.max(rec.launchPeak, b.threads);
      } else if (!rec.launchSaved) {
        rec.launchSaved = true;
        if (rec.launchPeak > 0) this.fleet.recordThreads(id, rec.launchPeak, null);
      }
      if (rec.peak >= rec.savedPeak * 1.1 + 10) {
        rec.savedPeak = rec.peak;
        this.fleet.recordThreads(id, null, rec.peak);
      }
    }
    // A Chrome this instance is not tracking: left over from a restart here. Nothing can
    // reach it, and it holds the worker's room, so it is stopped.
    for (const b of state.browsers) {
      if (this.remote.has(b.id) || this.fleet.busy(b.id)) continue;
      log.warn("stopping a browser this instance is not tracking", { id: b.id, worker: w.name });
      void this.call(w, "POST", `/worker/v1/browsers/${b.id}/stop`).catch(() => undefined);
    }
  }

  /**
   * Move a stopped browser's profile to another host: copy it, point the browser at the new
   * host, then delete the copy left behind. In that order, so a failure part-way leaves the
   * browser where it was, with its profile intact.
   */
  async move(row: BrowserRow, to: string | null, principal: Principal, onBytes: (copied: number) => void = () => undefined): Promise<void> {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can move a browser");
    const from = row.worker_id;
    if (from === to) return;
    const src = from ? this.row(from) : null;
    const dst = to ? this.row(to) : null;
    for (const w of [src, dst]) {
      const problem = w && this.unusable(w);
      if (problem) throw Err.browserUnavailable(problem);
    }
    const profilePath = `/worker/v1/browsers/${row.id}/profile`;
    const auth = (w: WorkerRow) => ({ authorization: `Bearer ${w.secret}` });
    const signal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
    const local = profileDir(row.id);

    // Every copy passes through this, so the dashboard can say how much has crossed so far.
    let copied = 0;
    const counted = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
      body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) {
          copied += chunk.byteLength;
          onBytes(copied);
          ctrl.enqueue(chunk);
        },
      }));
    const pull = async (w: WorkerRow): Promise<ReadableStream<Uint8Array> | null> => {
      let res: Response;
      try {
        res = await fetch(w.url + profilePath, { headers: auth(w), signal });
      } catch (e) {
        throw this.unreachable(w, e);
      }
      // Never started there: it has no profile yet, so there is nothing to bring.
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw this.refused(w, res.status, (await res.json().catch(() => ({}))) as { error?: { message?: string } });
      return res.body;
    };
    const push = async (w: WorkerRow, body: ReadableStream<Uint8Array>): Promise<void> => {
      let res: Response;
      try {
        res = await fetch(w.url + profilePath, {
          method: "PUT",
          headers: { ...auth(w), "content-type": "application/x-tar" },
          body,
          duplex: "half",
          signal,
        } as RequestInit);
      } catch (e) {
        throw this.unreachable(w, e);
      }
      if (!res.ok) throw this.refused(w, res.status, (await res.json().catch(() => ({}))) as { error?: { message?: string } });
    };

    if (src && dst) {
      const body = await pull(src);
      if (body) await push(dst, counted(body));
    } else if (src) {
      const body = await pull(src);
      mkdirSync(path.dirname(local), { recursive: true });
      if (body) await receiveProfile(Readable.fromWeb(counted(body) as import("node:stream/web").ReadableStream), path.dirname(local), row.id);
      else mkdirSync(local, { recursive: true });
    } else if (dst) {
      mkdirSync(local, { recursive: true });
      const tar = spawn("tar", ["-C", path.dirname(local), "-cf", "-", path.basename(local)], { stdio: ["ignore", "pipe", "pipe"] });
      const packed = new Promise<void>((resolve, reject) => {
        tar.on("error", reject);
        tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`could not pack the profile: tar exited ${code}`))));
      });
      try {
        await Promise.all([push(dst, counted(Readable.toWeb(tar.stdout) as ReadableStream<Uint8Array>)), packed]);
      } finally {
        tar.kill();
      }
    }

    getDb().prepare(`UPDATE browsers SET worker_id = ? WHERE id = ?`).run(to, row.id);
    audit({ actorType: principal.type, actorId: principal.id, action: "browser.moved", targetType: "browser", targetId: row.id,
      detail: { from: src?.name ?? "main", to: dst?.name ?? "main" } });
    hub.emitEvent("browser.updated", {}, row.id);

    // The copy that was moved from. A failure here costs disk on that host, not the browser.
    if (src) {
      await this.call(src, "DELETE", `/worker/v1/browsers/${row.id}`).catch((e) =>
        log.warn("moved a browser but could not delete its old profile", { id: row.id, worker: src.name, error: (e as Error).message }));
    } else if (existsSync(local)) {
      rmSync(local, { recursive: true, force: true });
    }
  }
}

export type WorkerView = ReturnType<Workers["view"]>;
