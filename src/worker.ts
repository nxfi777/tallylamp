import express, { type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { log } from "./log.js";
import { chromeVersion, clearSingletonLocks, launchChrome, stopRuntime, type ChromeRuntime, type GpuStatus, type SandboxStatus } from "./chrome.js";
import { startFakeChrome } from "./fake-chrome.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { parseBrowserProxy } from "./browser-proxy.js";
import { browserUsage, readPidLimit, scanProcesses, type PidLimit } from "./host-limits.js";
import { forwardHttp, forwardUpgrade } from "./relay.js";

/**
 * A worker: this image started with TALLYLAMP_JOIN. It runs Chrome for another Tallylamp
 * instance (the main instance) and serves nothing else: no dashboard, no database, no MCP.
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
export type WorkerState = { version: string; name: string; pids: PidLimit | null; browsers: WorkerBrowserState[] };
export type WorkerStartRequest = { estimate?: number; extensionsEnabled?: boolean; proxy?: unknown };
export type WorkerStartResult = {
  sandboxStatus: SandboxStatus;
  gpuStatus: GpuStatus;
  screen: { width: number; height: number };
  chromeVersion: string | null;
};

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

export async function startWorker(opts: WorkerOptions): Promise<{ port: number; identity: Identity; close: () => Promise<void> }> {
  const profiles = path.join(opts.dataDir, "profiles");
  const downloads = path.join(opts.dataDir, "downloads");
  mkdirSync(profiles, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  const identityFile = path.join(opts.dataDir, "worker.json");

  let identity: Identity | null = null;
  const running = new Map<string, Entry>();
  const starting = new Map<string, { need: number; promise: Promise<Entry> }>();

  const drop = async (id: string): Promise<void> => {
    const e = running.get(id);
    if (!e) return;
    running.delete(id);
    try {
      if (e.closeFake) await e.closeFake();
      else await stopRuntime(e.rt);
    } finally {
      await e.proxy?.close().catch(() => undefined);
    }
  };

  const start = async (id: string, body: WorkerStartRequest): Promise<Entry> => {
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
      const room = pids.max - pids.current - config.processHeadroom - pending;
      if (room < need) {
        throw new Refused(429, "fleet_full",
          `Worker ${opts.name} is out of room: ${pids.current} of ${pids.max} processes and threads are in use, and this browser needs about ${need}. ` +
            `Stop a browser on this worker, or move this one to a host with more room.`, true);
      }
    }
    const promise = (async (): Promise<Entry> => {
      if (config.fakeChrome) {
        const fake = await startFakeChrome();
        return { rt: fake.runtime, closeFake: fake.close, startedAt: Date.now(), version: "FakeChrome/1.0" };
      }
      const upstream = parseBrowserProxy(body.proxy ?? null);
      // No tunnel dialler: a tunnel ends at the main instance, which a worker cannot reach into.
      const proxy = await startEgressProxy({ browserId: id, upstream });
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
    const procs = running.size ? scanProcesses() : null;
    return {
      version: config.release,
      name: opts.name,
      pids: readPidLimit(),
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

  app.post("/worker/v1/browsers/:id/start", express.json({ limit: "64kb" }), route(async (req, res) => {
    const e = await start(browserId(req), (req.body ?? {}) as WorkerStartRequest);
    const out: WorkerStartResult = { sandboxStatus: e.rt.sandboxStatus, gpuStatus: e.rt.gpuStatus, screen: e.rt.screen, chromeVersion: e.version };
    res.json(out);
  }));

  app.post("/worker/v1/browsers/:id/stop", route(async (req, res) => {
    await drop(browserId(req));
    res.json({ stopped: true });
  }));

  app.delete("/worker/v1/browsers/:id", route(async (req, res) => {
    const id = browserId(req);
    await drop(id);
    rmSync(path.join(profiles, id), { recursive: true, force: true });
    rmSync(path.join(downloads, id), { recursive: true, force: true });
    res.json({ deleted: true });
  }));

  // A profile leaves or arrives as a tar stream, and only while its browser is stopped: Chrome
  // holds the files open and half-written otherwise.
  const assertStopped = (id: string) => {
    if (running.has(id) || starting.has(id)) throw new Refused(409, "browser_unavailable", "stop the browser before moving its profile", true);
  };
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

  app.all("/worker/v1/browsers/:id/cdp/*", route((req, res) => {
    const id = browserId(req);
    const e = running.get(id);
    if (!e || e.rt.chrome.exitCode !== null) throw new Refused(409, "browser_unavailable", "that browser is not running on this worker", true);
    forwardHttp(req, res, { host: "127.0.0.1", port: e.rt.cdpPort, path: req.originalUrl.slice(`/worker/v1/browsers/${id}/cdp`.length) || "/", headers: { authorization: undefined } });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof Refused) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
      return;
    }
    log.warn("worker request failed", { error: (err as Error).message });
    res.status(500).json({ error: { code: "internal", message: (err as Error).message, retryable: true } });
  });

  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => {
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
  return { port, identity, close };
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
