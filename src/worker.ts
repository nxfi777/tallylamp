import express, { type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { packArchive } from "./archive.js";
import { WebSocketServer } from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { log } from "./log.js";
import { chromeVersion, clearSingletonLocks, launchChrome, stopRuntime, type ChromeRuntime, type GpuStatus, type SandboxStatus } from "./chrome.js";
import { startFakeChrome } from "./fake-chrome.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { parseBrowserProxy } from "./browser-proxy.js";
import { browserUsage, readPidLimit, resetHint, scanProcesses, type PidLimit } from "./host-limits.js";
import { forwardHttp, forwardUpgrade } from "./relay.js";
import { hostLooksPrivate } from "./ssrf.js";
import { MAX_CHUNK, TunnelMux } from "./tunnels.js";
import { allowedFfmpeg, allowedXdotool, xFrame, X_ERROR, X_EXIT, X_STDOUT } from "./x11-remote.js";
import { acceptLinkedBridge, LINKED_BRIDGE_THREADS } from "./linked-bridge.js";
import { bridgeFilesDir } from "./bridge-files.js";

/**
 * A worker: this image started with TALLYLAMP_JOIN. It runs Chrome for another Tallylamp
 * instance (the main instance), with no dashboard, database or agent-facing MCP endpoint.
 * It also runs linked-browser control bridges over authenticated session channels.
 *
 * Why it exists. Railway caps a container at 1,000 processes and threads and will not raise
 * it, but the cap is per container. A worker is another container, so another 1,000, holding
 * browsers the main instance starts, drives and stops over the project's private network.
 *
 * What passes between them. The worker joins once, over the main instance's public URL, with
 * a one-time token; that returns a secret, kept on this volume. From then on the main instance
 * calls the worker: every request carries the secret, and a browser's debugging port is
 * reachable only through /worker/v1/browsers/ID/cdp with it. Both sides must be the same
 * release, since this API is internal and changes without notice.
 */

export type WorkerBrowserState = {
  id: string;
  running: boolean;
  threads: number | null;
  processes: number | null;
  rendererZygotes: number | null;
  startedAt: string;
};
export type WorkerState = { version: string; name: string; pids: PidLimit | null; fullBrowser: boolean; browsers: WorkerBrowserState[]; linkedBridges?: Array<{ id: string; threads: number | null }>; linkedBridgeFilesRoot?: string };
export type WorkerStartRequest = {
  estimate?: number;
  /** What the start would need had its thread counts been reset: the main instance's default. */
  unmeasuredEstimate?: number;
  extensionsEnabled?: boolean;
  proxy?: unknown;
};
export type WorkerStartResult = {
  sandboxStatus: SandboxStatus;
  gpuStatus: GpuStatus;
  screen: { width: number; height: number };
  chromeVersion: string | null;
  /** The browser's own X display on this worker, when it has one: Full browser and the desktop tools. */
  display: string | null;
};

/** The largest file upload_file may send to a worker, per file. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Where a file for upload_file waits, on the main instance and on the worker alike. The bridge
 * checks the path exists on the main instance and Chrome reads it on the worker, so both hosts
 * must spell it the same, and both keep it under their temp directory, the only place the
 * bridge accepts a file from.
 */
export function uploadStaging(browserId: string): string {
  return path.join(realpathSync(os.tmpdir()), "tallylamp-uploads", browserId);
}

const TOKEN_PREFIX = "tlw1.";
const BROWSER_ID = /^[0-9a-f]{16}$/;

export function makeJoinToken(controlUrl: string, secret: string): string {
  return TOKEN_PREFIX + Buffer.from(JSON.stringify({ u: controlUrl, t: secret })).toString("base64url");
}

export function parseJoinToken(token: string): { controlUrl: string; secret: string } {
  const bad = new Error("TALLYLAMP_JOIN is not a join token. Copy it again from Add worker on your Tallylamp dashboard.");
  if (!token.startsWith(TOKEN_PREFIX)) throw bad;
  try {
    const { u, t } = JSON.parse(Buffer.from(token.slice(TOKEN_PREFIX.length), "base64url").toString("utf8")) as { u?: unknown; t?: unknown };
    if (typeof u !== "string" || typeof t !== "string" || !/^https?:\/\//.test(u) || t.length < 32) throw bad;
    return { controlUrl: u.replace(/\/$/, ""), secret: t };
  } catch {
    throw bad;
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
}

type Identity = { controlUrl: string; workerId: string; secret: string; tokenHash: string };
type Entry = { rt: ChromeRuntime; proxy?: EgressProxy; closeFake?: () => Promise<void>; startedAt: number; version: string | null };

class Refused extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
  }
}

/** An error this worker cannot work past. The message is the whole explanation. */
export class WorkerFatal extends Error {}

export type WorkerOptions = {
  dataDir: string;
  host: string;
  port: number;
  join: string;
  /** Where the main instance reaches this worker: http://host:port. */
  selfUrl: string;
  name: string;
};

export async function startWorker(opts: WorkerOptions): Promise<{
  port: number;
  identity: Identity;
  close: () => Promise<void>;
  /** What a browser's egress proxy dials a tunnel with. Returned so tests can dial without a real Chrome. */
  dialTunnel: (id: string, host: string, port: number) => Promise<import("node:stream").Duplex | null>;
}> {
  const profiles = path.join(opts.dataDir, "profiles");
  const downloads = path.join(opts.dataDir, "downloads");
  mkdirSync(profiles, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  const identityFile = path.join(opts.dataDir, "worker.json");

  let identity: Identity | null = null;
  const running = new Map<string, Entry>();
  const starting = new Map<string, { need: number; promise: Promise<Entry> }>();
  const stopping = new Map<string, Promise<void>>();
  const uncleanStops = new Set<string>();
  const exporting = new Set<string>();
  const bridges = new Map<string, ReturnType<typeof acceptLinkedBridge>>();
  let closing = false;
  // Reserve the part of a starting bridge that has not appeared in the cgroup count yet.
  const bridgeHeadroom = () => {
    const procs = bridges.size ? scanProcesses() : null;
    return [...bridges.values()].reduce((n, b) => n + Math.max(0, LINKED_BRIDGE_THREADS - (procs?.find((p) => p.pid === b.pid)?.threads ?? 0)), 0);
  };

  // The main instance's socket for each running browser's tunnels (tunnels.ts, serveTunnelDials).
  const tunnels = new Map<string, TunnelMux>();
  // A tunnel's far end is connected to the main instance, so a dial it might answer goes
  // there. Only a private address can have a binding (tunnels.ts, normalizeAuthority), so
  // nothing else waits on the round trip. With no socket up, it reads as no binding: the
  // egress policy then refuses it, which is where the main instance would have ended too.
  const dialTunnel = async (id: string, host: string, port: number) =>
    hostLooksPrivate(host) ? (await tunnels.get(id)?.open(host, port)) ?? null : null;

  const performDrop = async (id: string): Promise<void> => {
    tunnels.get(id)?.shutdown("browser stopped");
    tunnels.delete(id);
    rmSync(uploadStaging(id), { recursive: true, force: true });
    const e = running.get(id);
    if (!e) return;
    running.delete(id);
    try {
      if (e.closeFake) await e.closeFake();
      else {
        try { await stopRuntime(e.rt); }
        catch (error) { uncleanStops.add(id); throw error; }
        if (e.rt.chrome.signalCode !== null || e.rt.chrome.exitCode !== 0) uncleanStops.add(id);
      }
    } finally {
      await e.proxy?.close().catch(() => undefined);
    }
  };

  const drop = async (id: string): Promise<void> => {
    const pending = stopping.get(id);
    if (pending) return pending;
    const work = performDrop(id);
    stopping.set(id, work);
    try { await work; }
    finally { stopping.delete(id); }
  };

  const start = async (id: string, body: WorkerStartRequest): Promise<Entry> => {
    if (exporting.has(id)) throw new Refused(409, "browser_unavailable", "this browser is being exported", true);
    uncleanStops.delete(id);
    const existing = running.get(id);
    if (existing && existing.rt.chrome.exitCode === null) return existing;
    if (existing) await drop(id);
    const inflight = starting.get(id);
    if (inflight) return inflight.promise;
    // The same check the main instance makes for its own browsers, against this container's
    // ceiling. Starts still in flight have spawned nothing yet, so they are counted by hand.
    const need = Math.max(1, Math.min(2000, Math.round(Number(body.estimate) || config.browserThreads)));
    const pids = readPidLimit();
    if (pids) {
      const pending = [...starting.values()].reduce((n, s) => n + s.need, 0);
      const room = pids.max - pids.current - config.processHeadroom - pending - bridgeHeadroom();
      if (room < need) {
        throw new Refused(429, "fleet_full",
          `Worker ${opts.name} is out of room: ${pids.current} of ${pids.max} processes and threads are in use, and this browser needs about ${need}. ` +
            resetHint(need, room, Number(body.unmeasuredEstimate) || config.browserThreads) +
            `Stop a browser on this worker, or move this one to a host with more room.`, true);
      }
    }
    const promise = (async (): Promise<Entry> => {
      if (config.fakeChrome) {
        const fake = await startFakeChrome();
        return { rt: fake.runtime, closeFake: fake.close, startedAt: Date.now(), version: "FakeChrome/1.0" };
      }
      const upstream = parseBrowserProxy(body.proxy ?? null);
      const proxy = await startEgressProxy({ browserId: id, upstream, dial: (host, port) => dialTunnel(id, host, port) });
      try {
        const rt = await launchChrome({
          profileDir: path.join(profiles, id),
          downloadDir: path.join(downloads, id),
          proxyPort: proxy.port,
          upstreamProxy: Boolean(upstream),
          extensionsEnabled: Boolean(body.extensionsEnabled) && config.fullBrowser,
        });
        return { rt, proxy, startedAt: Date.now(), version: await chromeVersion().catch(() => null) };
      } catch (e) {
        await proxy.close().catch(() => undefined);
        throw e;
      }
    })();
    starting.set(id, { need, promise });
    try {
      const entry = await promise;
      running.set(id, entry);
      return entry;
    } finally {
      starting.delete(id);
    }
  };

  const state = (): WorkerState => {
    const procs = running.size || bridges.size ? scanProcesses() : null;
    return {
      version: config.release,
      name: opts.name,
      pids: readPidLimit(),
      fullBrowser: config.fullBrowser,
      linkedBridges: [...bridges].map(([id, b]) => ({ id, threads: procs?.find((p) => p.pid === b.pid)?.threads ?? null })),
      linkedBridgeFilesRoot: bridgeFilesDir(""),
      browsers: [...running].map(([id, e]) => {
        const alive = e.rt.chrome.exitCode === null;
        // The test fake's "Chrome" is this very process; counting it would count the worker.
        const u = alive && procs && e.rt.chrome.pid && !e.closeFake
          ? browserUsage(procs, { chromePid: e.rt.chrome.pid, xvfbPid: e.rt.xvfb?.pid, cdpPort: e.rt.cdpPort })
          : null;
        return {
          id,
          running: alive,
          threads: u?.threads ?? null,
          processes: u?.processes ?? null,
          rendererZygotes: u?.rendererZygotes ?? null,
          startedAt: new Date(e.startedAt).toISOString(),
        };
      }),
    };
  };

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    if (identity) res.json({ status: "ok", role: "worker" });
    else res.status(503).json({ status: "joining", role: "worker" });
  });

  const authorized = (header: string | undefined): boolean => {
    const token = /^Bearer (.+)$/i.exec(header ?? "")?.[1];
    return Boolean(identity && token && sameSecret(token, identity.secret));
  };
  const browserId = (req: Request): string => {
    const id = req.params.id ?? "";
    if (!BROWSER_ID.test(id)) throw new Refused(400, "invalid_request", "not a browser id");
    return id;
  };
  const route = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve().then(() => fn(req, res)).catch(next);
    };

  app.use("/worker/v1", (req, res, next) => {
    if (authorized(req.header("authorization"))) return next();
    res.status(401).json({ error: { code: "unauthenticated", message: "this worker answers only the instance it joined", retryable: false } });
  });

  app.get("/worker/v1/state", (_req, res) => res.json(state()));

  app.get("/worker/v1/linked-bridges/:id/files", route(async (req, res) => {
    const id = req.params.id!;
    if (!/^[0-9a-f]{32}$/.test(id) || !bridges.has(id)) throw new Refused(404, "not_found", "control bridge is gone");
    if (typeof req.query.path !== "string") throw new Refused(400, "invalid_request", "missing artifact path");
    const directory = await realpath(bridgeFilesDir(id));
    const file = await realpath(path.resolve(directory, req.query.path));
    if (!file.startsWith(directory + path.sep) || !(await lstat(file)).isFile()) throw new Refused(403, "forbidden", "artifact is outside this control bridge");
    res.setHeader("X-Tallylamp-Extension", path.extname(file));
    res.sendFile(file);
  }));

  app.post("/worker/v1/browsers/:id/start", express.json({ limit: "64kb" }), route(async (req, res) => {
    const e = await start(browserId(req), (req.body ?? {}) as WorkerStartRequest);
    const out: WorkerStartResult = {
      sandboxStatus: e.rt.sandboxStatus,
      gpuStatus: e.rt.gpuStatus,
      screen: e.rt.screen,
      chromeVersion: e.version,
      display: config.fullBrowser && e.rt.xvfb && e.rt.display ? e.rt.display : null,
    };
    res.json(out);
  }));

  app.post("/worker/v1/browsers/:id/stop", route(async (req, res) => {
    const id = browserId(req);
    if (exporting.has(id)) throw new Refused(409, "browser_unavailable", "this browser is being exported", true);
    await drop(id);
    if (req.query.export === "1" && uncleanStops.has(id)) {
      throw new Refused(409, "browser_unavailable", "Chrome did not close cleanly; retry export after starting and stopping this browser", true);
    }
    res.json({ stopped: true });
  }));

  app.delete("/worker/v1/browsers/:id", route(async (req, res) => {
    const id = browserId(req);
    if (exporting.has(id)) throw new Refused(409, "browser_unavailable", "this browser is being exported", true);
    await drop(id);
    rmSync(path.join(profiles, id), { recursive: true, force: true });
    rmSync(path.join(downloads, id), { recursive: true, force: true });
    res.json({ deleted: true });
  }));

  // A profile leaves or arrives as a tar stream, and only while its browser is stopped: Chrome
  // holds the files open and half-written otherwise.
  const assertStopped = (id: string) => {
    if (running.has(id) || starting.has(id) || stopping.has(id) || exporting.has(id)) throw new Refused(409, "browser_unavailable", "stop the browser before moving its profile", true);
  };
  app.get("/worker/v1/browsers/:id/export", route(async (req, res) => {
    const id = browserId(req);
    assertStopped(id);
    if (uncleanStops.has(id)) throw new Refused(409, "browser_unavailable", "Chrome did not close cleanly; no profile export was created", true);
    const profilePresent = existsSync(path.join(profiles, id));
    const downloadsPresent = existsSync(path.join(downloads, id));
    exporting.add(id);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("X-Tallylamp-Profile-Present", String(profilePresent));
    res.setHeader("X-Tallylamp-Downloads-Present", String(downloadsPresent));
    const entries = [profilePresent ? `profiles/${id}` : null, downloadsPresent ? `downloads/${id}` : null]
      .filter((entry): entry is string => entry !== null);
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableFinished) abort.abort(new Error("worker export disconnected")); };
    res.once("close", disconnected);
    try {
      await packArchive({ root: opts.dataDir, sources: entries.map(source => ({ source, target: source })) }, res,
        AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000)]));
    } finally { res.off("close", disconnected); exporting.delete(id); }
  }));
  app.get("/worker/v1/browsers/:id/profile", route((req, res) => {
    const id = browserId(req);
    assertStopped(id);
    if (!existsSync(path.join(profiles, id))) throw new Refused(404, "not_found", "this worker has no profile for that browser");
    const tar = spawn("tar", ["-C", profiles, "-cf", "-", id], { stdio: ["ignore", "pipe", "pipe"] });
    res.setHeader("Content-Type", "application/x-tar");
    tar.stdout.pipe(res);
    tar.on("close", (code) => {
      if (code !== 0) res.destroy(new Error(`tar exited ${code}`));
    });
    tar.on("error", () => res.destroy());
    res.on("close", () => tar.kill());
  }));
  app.put("/worker/v1/browsers/:id/profile", route(async (req, res) => {
    const id = browserId(req);
    assertStopped(id);
    await receiveProfile(req, profiles, id);
    res.json({ received: true });
  }));

  // Full browser and the agent desktop tools (x11-remote.ts): one ffmpeg or xdotool command
  // against this browser's display. Its stdout and exit come back framed, and the command dies
  // when the main instance hangs up.
  const x11Runs = new Map<string, number>();
  app.post("/worker/v1/browsers/:id/x11", express.json({ limit: "64kb" }), route((req, res) => {
    const id = browserId(req);
    const e = running.get(id);
    const display = e && e.rt.chrome.exitCode === null && config.fullBrowser && e.rt.xvfb ? e.rt.display : null;
    if (!display) throw new Refused(409, "browser_unavailable", "that browser has no display on this worker", true);
    const { tool, args, stdout } = (req.body ?? {}) as { tool?: unknown; args?: unknown; stdout?: unknown };
    const list = Array.isArray(args) && args.length <= 64 && args.every((a) => typeof a === "string") ? (args as string[]) : null;
    const allowed = list && (tool === "xdotool" ? allowedXdotool(list) : tool === "ffmpeg" ? allowedFfmpeg(list, display) : false);
    if (!allowed) throw new Refused(400, "invalid_request", "this worker runs only the display commands Tallylamp sends");
    // A viewer holds one capture and one input at a time, and an agent one operation.
    const live = x11Runs.get(id) ?? 0;
    if (live >= 8) throw new Refused(429, "browser_unavailable", "too many display commands are running for this browser", true);
    x11Runs.set(id, live + 1);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    res.flushHeaders();
    const child = spawn(tool as string, list, {
      env: { PATH: process.env.PATH, DISPLAY: display, LANG: "C.UTF-8" },
      stdio: ["ignore", stdout === true ? "pipe" : "ignore", "ignore"],
    });
    let ended = false;
    const end = (type: number, body: unknown) => {
      if (ended) return;
      ended = true;
      res.end(xFrame(type, Buffer.from(JSON.stringify(body), "utf8")));
    };
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      const n = (x11Runs.get(id) ?? 1) - 1;
      if (n > 0) x11Runs.set(id, n);
      else x11Runs.delete(id);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (ended) return;
      // A slow reader on the main instance holds ffmpeg back rather than piling frames up here.
      if (!res.write(xFrame(X_STDOUT, chunk))) {
        child.stdout!.pause();
        res.once("drain", () => child.stdout?.resume());
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      uncount();
      end(X_ERROR, { code: err.code ?? "EFAIL", message: err.message });
    });
    child.on("close", (code, signal) => {
      uncount();
      end(X_EXIT, { code, signal });
    });
    res.on("close", () => {
      if (ended) return;
      ended = true;
      child.kill("SIGKILL");
    });
  }));

  // upload_file: a file the agent named on the main instance, waiting here at the same path.
  app.put("/worker/v1/browsers/:id/uploads/:dir/:name", route(async (req, res) => {
    const id = browserId(req);
    const { dir, name } = req.params as { dir: string; name: string };
    if (!/^[0-9a-f]{12}$/.test(dir) || !name || name === "." || name === ".." || /[/\\\0]/.test(name) || Buffer.byteLength(name) > 255) {
      throw new Refused(400, "invalid_request", "not an upload name");
    }
    const e = running.get(id);
    if (!e || e.rt.chrome.exitCode !== null) throw new Refused(409, "browser_unavailable", "that browser is not running on this worker", true);
    const folder = path.join(uploadStaging(id), dir);
    mkdirSync(folder, { recursive: true });
    const dest = path.join(folder, name);
    const part = `${dest}.${randomBytes(4).toString("hex")}.part`;
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES) return cb(new Refused(413, "invalid_request", "that file is too large to upload"));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limit, createWriteStream(part, { mode: 0o600 }));
      // Renamed into place, so a reader never sees half a file, and a file that already had
      // that name is replaced rather than written through.
      renameSync(part, dest);
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
    res.json({ path: dest });
  }));

  app.all("/worker/v1/browsers/:id/cdp/*", route((req, res) => {
    const id = browserId(req);
    const e = running.get(id);
    if (!e || e.rt.chrome.exitCode !== null) throw new Refused(409, "browser_unavailable", "that browser is not running on this worker", true);
    forwardHttp(req, res, { host: "127.0.0.1", port: e.rt.cdpPort, path: req.originalUrl.slice(`/worker/v1/browsers/${id}/cdp`.length) || "/", headers: { authorization: undefined } });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent || res.destroyed) { res.destroy(err as Error); return; }
    if (err instanceof Refused) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
      return;
    }
    log.warn("worker request failed", { error: (err as Error).message });
    res.status(500).json({ error: { code: "internal", message: (err as Error).message, retryable: true } });
  });

  const server = http.createServer(app);
  const tunnelSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CHUNK + 64 * 1024 });
  const bridgeSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const bridge = /^\/worker\/v1\/linked-bridges\/([0-9a-f]{32})\/mcp$/.exec(req.url ?? "");
    if (bridge) {
      const refuse = (status: number, message: string) => {
        socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (!authorized(req.headers.authorization)) return refuse(403, "Forbidden");
      if (closing) return refuse(503, "Service Unavailable");
      if (bridges.has(bridge[1]!)) return refuse(409, "Conflict");
      const pids = readPidLimit();
      const pending = [...starting.values()].reduce((n, s) => n + s.need, 0);
      if (pids && pids.max - pids.current - config.processHeadroom - pending - bridgeHeadroom() < LINKED_BRIDGE_THREADS) {
        return refuse(429, "Too Many Requests");
      }
      const directory = bridgeFilesDir(bridge[1]!);
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      } catch (error) {
        log.warn("could not prepare linked bridge directory", { error: (error as Error).message });
        return refuse(503, "Service Unavailable");
      }
      bridgeSockets.handleUpgrade(req, socket, head, (ws) => {
        const child = acceptLinkedBridge(ws, directory);
        bridges.set(bridge[1]!, child);
        void child.closed.then(async () => {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          if (bridges.get(bridge[1]!) === child) bridges.delete(bridge[1]!);
        });
      });
      return;
    }
    const t = /^\/worker\/v1\/browsers\/([0-9a-f]{16})\/tunnel$/.exec(req.url ?? "");
    if (t) {
      const id = t[1]!;
      const e = running.get(id);
      if (!authorized(req.headers.authorization) || !e || e.rt.chrome.exitCode !== null) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      tunnelSockets.handleUpgrade(req, socket, head, (ws) => {
        // A reconnect wins: a half-dead socket nobody has noticed must not keep the tunnel shut.
        tunnels.get(id)?.shutdown("replaced by a new connection");
        const mux = new TunnelMux(ws, { browserId: id });
        tunnels.set(id, mux);
        ws.on("close", () => {
          if (tunnels.get(id) === mux) tunnels.delete(id);
        });
      });
      return;
    }
    const m = /^\/worker\/v1\/browsers\/([0-9a-f]{16})\/cdp(\/.*)$/.exec(req.url ?? "");
    const e = m ? running.get(m[1]!) : undefined;
    if (!m || !authorized(req.headers.authorization) || !e || e.rt.chrome.exitCode !== null) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    forwardUpgrade(req, socket, head, { host: "127.0.0.1", port: e.rt.cdpPort, path: m[2]!, headers: { authorization: undefined } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  const close = async () => {
    closing = true;
    await Promise.all([...bridges.values()].map((b) => b.close()));
    bridgeSockets.close();
    for (const id of [...running.keys()]) await drop(id).catch((e) => log.warn("worker stop failed", { id, error: (e as Error).message }));
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  try {
    identity = await enrol(opts, identityFile);
  } catch (e) {
    await close();
    throw e;
  }
  log.info("worker ready", { name: opts.name, workerId: identity.workerId, main: identity.controlUrl, url: opts.selfUrl, release: config.release });
  return { port, identity, close, dialTunnel };
}

/** Unpack a tar stream into a fresh directory, then swap it in, so a broken upload leaves the old profile alone. */
export async function receiveProfile(stream: NodeJS.ReadableStream, profiles: string, id: string): Promise<void> {
  const incoming = path.join(profiles, `.incoming-${id}-${randomBytes(4).toString("hex")}`);
  mkdirSync(incoming, { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-xf", "-", "-C", incoming], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      tar.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-400); });
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`could not unpack the profile: ${stderr.trim() || `tar exited ${code}`}`))));
      stream.on("error", (e) => { tar.kill(); reject(e); });
      // A sender that stops early ends the stream; tar then fails on a truncated archive.
      tar.stdin.on("error", () => undefined);
      stream.pipe(tar.stdin);
    });
    const unpacked = path.join(incoming, id);
    if (!existsSync(unpacked)) throw new Error("the archive did not hold that browser's profile");
    const dest = path.join(profiles, id);
    rmSync(dest, { recursive: true, force: true });
    renameSync(unpacked, dest);
    clearSingletonLocks(dest);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; json: { error?: { message?: string } | string } & Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string } & Record<string, unknown>;
  return { status: res.status, json };
}

const refusal = (json: { error?: { message?: string } | string }) =>
  typeof json.error === "string" ? json.error : json.error?.message ?? "no reason given";

/** Transient failures only: a refusal (4xx) would fail the same way every time. */
async function withRetry<T>(what: string, attempts: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let n = 0; n < attempts; n++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof WorkerFatal) throw e;
      last = e;
      if (n < attempts - 1) await sleep(1000 * 2 ** n * (0.5 + Math.random()));
    }
  }
  throw new Error(`${what}: ${(last as Error).message}`);
}

/**
 * Become a worker of the main instance: join with the token the first time, and say hello
 * with the saved secret every time after. A token is one use, so a restart must not need it.
 */
async function enrol(opts: WorkerOptions, identityFile: string): Promise<Identity> {
  const { controlUrl, secret: joinSecret } = parseJoinToken(opts.join);
  const tokenHash = sha256(joinSecret);
  if (!/^https?:\/\/[^/]+$/.test(opts.selfUrl)) {
    throw new WorkerFatal(
      "This worker cannot tell where the main instance should reach it. On Railway that comes from the service's private domain. " +
        "Anywhere else, set TALLYLAMP_WORKER_URL to http://host:port as the main instance sees this worker.",
    );
  }
  const about = { name: opts.name, url: opts.selfUrl, version: config.release };
  let saved: Identity | null = null;
  try {
    saved = JSON.parse(readFileSync(identityFile, "utf8")) as Identity;
  } catch {
    /* first boot */
  }
  // A different token from the one this worker joined with means: join again, as asked.
  if (saved && saved.tokenHash === tokenHash) {
    const me = saved;
    try {
      const r = await withRetry("hello", 3, async () => {
        const out = await post(`${me.controlUrl}/api/v1/workers/hello`, { workerId: me.workerId, secret: me.secret, ...about });
        if (out.status >= 500) throw new Error(`HTTP ${out.status}`);
        return out;
      });
      if (r.status === 200) return me;
      throw new WorkerFatal(
        `The main instance at ${me.controlUrl} no longer accepts this worker: ${refusal(r.json)} ` +
          `Make a new join token with Add worker on its dashboard and set TALLYLAMP_JOIN to it.`,
      );
    } catch (e) {
      if (e instanceof WorkerFatal) throw e;
      // The main instance may simply be restarting. It knows this worker and will call it.
      log.warn("could not reach the main instance to say hello; carrying on", { main: me.controlUrl, error: (e as Error).message });
      return me;
    }
  }
  const r = await withRetry(`Could not reach the main instance at ${controlUrl} to join`, 5, async () => {
    const out = await post(`${controlUrl}/api/v1/workers/join`, { token: joinSecret, ...about });
    if (out.status >= 500) throw new Error(`HTTP ${out.status}`);
    return out;
  }).catch((e) => {
    throw e instanceof WorkerFatal ? e : new WorkerFatal(`${(e as Error).message}. Check that it is up and that the token came from its dashboard.`);
  });
  if (r.status !== 200 || typeof r.json.workerId !== "string" || typeof r.json.secret !== "string") {
    throw new WorkerFatal(`The main instance at ${controlUrl} refused this worker: ${refusal(r.json)}`);
  }
  const identity: Identity = { controlUrl, workerId: r.json.workerId, secret: r.json.secret, tokenHash };
  const tmp = `${identityFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(identity), { mode: 0o600 });
  renameSync(tmp, identityFile);
  return identity;
}

/** The process entry point for the worker role (index.ts). Exits on anything it cannot work past. */
export async function runWorker(): Promise<void> {
  // `::` takes IPv4 as well on Linux, and Railway's private network is IPv6 in older environments.
  const host = process.env.HOST || "::";
  let worker: Awaited<ReturnType<typeof startWorker>>;
  try {
    worker = await startWorker({ dataDir: config.dataDir, host, port: config.port, join: config.join, selfUrl: config.workerUrl, name: config.workerName });
  } catch (e) {
    // One plain line, then a failed start: the deploy shows as failed instead of as a worker
    // that is up and can do nothing.
    log.error("worker cannot start", (e as Error).message);
    process.exit(1);
  }
  const shutdown = async (signal: string) => {
    log.info("shutdown", { signal });
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
