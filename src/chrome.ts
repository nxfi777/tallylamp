import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { config } from "./config.js";
import { log } from "./log.js";

export type SandboxStatus = "sandboxed" | "disabled" | "fell-back" | "unknown";
export type GpuStatus = "hardware" | "software" | "unknown";

export type ChromeRuntime = {
  display: string | null;
  cdpPort: number;
  cdpUrl: string;
  xvfb?: ChildProcess;
  chrome: ChildProcess;
  pgid?: number;
  sandboxStatus: SandboxStatus;
  gpuStatus: GpuStatus;
  profileDir: string;
  downloadDir: string;
  /** The X root window this Chrome draws on. The ceiling for any viewer-driven resize. */
  screen: { width: number; height: number };
};

/** Parse a "W,H" config pair, falling back when either half is not a positive number. */
export function parseSize(pair: string, fallback: { width: number; height: number }): { width: number; height: number } {
  const [w, h] = pair.split(",").map((n) => Number(n.trim()));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fallback;
  return { width: Math.round(w), height: Math.round(h) };
}

const CHROME_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "FONTCONFIG_PATH",
  "SSL_CERT_FILE",
  "TMPDIR",
  "TMP",
  "TEMP",
]);

export function sanitizedChromeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (CHROME_ENV_ALLOW.has(k) && v !== undefined) env[k] = v;
  }
  Object.assign(env, extra);
  return env;
}

export function usernsSupported(): boolean {
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("unshare", ["--user", "--map-root-user", "true"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function decideSandbox(mode = config.sandbox): { args: string[]; status: SandboxStatus } {
  const supported = usernsSupported();
  if (mode === "off") return { args: ["--no-sandbox", "--disable-setuid-sandbox"], status: "disabled" };
  if (mode === "on") {
    if (!supported) throw new Error("TALLYLAMP_SANDBOX=on but unprivileged user namespaces are unavailable");
    return { args: [], status: "sandboxed" };
  }
  if (supported) return { args: [], status: "sandboxed" };
  log.warn("user namespaces unavailable; Chrome renderer sandbox disabled (--no-sandbox)");
  return { args: ["--no-sandbox", "--disable-setuid-sandbox"], status: "fell-back" };
}

/**
 * SwiftShader is gated behind --enable-unsafe-swiftshader in current Chrome, so without it
 * a GPU-less container has no WebGL at all: `canvas.getContext("webgl")` returns null and
 * any site with a 3D or shader-backed renderer hits its own error boundary.
 */
const SWIFTSHADER = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** A Linux host with no DRI node has no GPU to hand Chrome — the normal container case. */
function hasGpuDevice(): boolean {
  if (process.platform !== "linux") return true;
  return existsSync("/dev/dri");
}

export function gpuArgs(mode = config.gpu): { args: string[]; status: GpuStatus } {
  if (mode === "software") return { args: SWIFTSHADER, status: "software" };
  if (mode === "hardware") return { args: [], status: "hardware" };
  // auto: fall back to software WebGL where there is demonstrably no GPU, rather than
  // leaving Chrome with no working WebGL backend at all.
  if (!hasGpuDevice()) return { args: SWIFTSHADER, status: "software" };
  return { args: [], status: "unknown" };
}

function waitPort(port: number, host = "127.0.0.1", timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = createConnection({ host, port }, () => {
        sock.end();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`CDP port ${port} did not open in ${timeoutMs}ms`));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

export async function allocatePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("port alloc failed"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function nextDisplay(): string {
  const n = 100 + Math.floor(Math.random() * 4000);
  return `:${n}`;
}

export function clearSingletonLocks(profile: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(profile, name);
    try {
      rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function launchChrome(opts: {
  profileDir: string;
  downloadDir: string;
  proxyPort?: number;
  windowSize?: string;
}): Promise<ChromeRuntime> {
  mkdirSync(opts.profileDir, { recursive: true });
  mkdirSync(opts.downloadDir, { recursive: true });
  clearSingletonLocks(opts.profileDir);

  const cdpPort = await allocatePort();
  const sandbox = decideSandbox();
  const gpu = gpuArgs();
  const size = opts.windowSize ?? config.windowSize;
  const windowDims = parseSize(size, { width: 1280, height: 800 });
  // The screen must be at least the window, or Chrome opens larger than the display it is on.
  const screenDims = config.xvfb
    ? (() => {
        const s = parseSize(config.xvfbScreen, windowDims);
        return { width: Math.max(s.width, windowDims.width), height: Math.max(s.height, windowDims.height) };
      })()
    : windowDims;
  let display: string | null = process.env.DISPLAY ?? null;
  let xvfb: ChildProcess | undefined;

  if (config.xvfb) {
    display = nextDisplay();
    const xvfbSize = `${screenDims.width}x${screenDims.height}x24`;
    xvfb = spawn("Xvfb", [display, "-screen", "0", xvfbSize, "-nolisten", "tcp", "-ac"], {
      env: sanitizedChromeEnv(),
      stdio: "ignore",
      detached: true,
    });
    xvfb.unref();
    const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
    const start = Date.now();
    while (!existsSync(sock)) {
      if (Date.now() - start > 5000) throw new Error("Xvfb failed to start");
      await sleep(50);
    }
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${opts.profileDir}`,
    `--disk-cache-dir=${path.join(opts.profileDir, "Cache")}`,
    `--download-default-directory=${opts.downloadDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Chrome ships component extensions with background pages and spawns a renderer for
    // each. Measured: 7 renderers and ~1215 MB per browser without these, 5 and ~934 MB
    // with them. Deliberately NOT --renderer-process-limit (measured worse, and it
    // collapses site isolation) and NOT --memory-pressure-off (increases memory).
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-pings",
    "--mute-audio",
    "--disable-sync",
    "--disable-dev-shm-usage",
    `--window-size=${size}`,
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    ...sandbox.args,
    ...gpu.args,
  ];
  if (opts.proxyPort) {
    args.push(`--proxy-server=http://127.0.0.1:${opts.proxyPort}`);
    // <-loopback> removes the implicit localhost bypass so pages cannot reach
    // sibling CDP/viewer ports. Our process still talks to CDP directly.
    args.push("--proxy-bypass-list=<-loopback>");
  }
  args.push("about:blank");

  const env = sanitizedChromeEnv({
    HOME: opts.profileDir,
    ...(display ? { DISPLAY: display } : {}),
  });

  const chrome = spawn(config.chromeBin, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  chrome.stderr?.on("data", (d) => log.debug("chrome stderr", String(d).slice(0, 300)));
  chrome.on("exit", (code, signal) => {
    log.info("chrome exited", { code, signal, pid: chrome.pid });
  });

  try {
    await waitPort(cdpPort, "127.0.0.1", config.startupTimeoutMs);
  } catch (e) {
    killProcessTree(chrome.pid);
    xvfb?.kill("SIGTERM");
    throw e;
  }

  return {
    display,
    cdpPort,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    xvfb,
    chrome,
    pgid: chrome.pid,
    sandboxStatus: sandbox.status,
    gpuStatus: gpu.status,
    screen: screenDims,
    profileDir: opts.profileDir,
    downloadDir: opts.downloadDir,
  };
}

export function killProcessTree(pid?: number): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function closeChrome(rt: ChromeRuntime, timeoutMs: number): Promise<void> {
  const response = await fetch(`${rt.cdpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  const { webSocketDebuggerUrl } = await response.json() as { webSocketDebuggerUrl: string };
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Chrome close timed out")); }, timeoutMs);
    ws.once("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })));
    ws.once("message", () => { clearTimeout(timer); ws.terminate(); resolve(); });
    ws.once("close", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function stopRuntime(rt: ChromeRuntime, timeoutMs = config.shutdownTimeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Closing Chrome through CDP flushes cookies and profile storage. Killing its
  // process group or display first can lose writes made just before a stop.
  if (!exited(rt.chrome) && timeoutMs > 0) {
    try {
      await closeChrome(rt, Math.max(1, Math.min(1_000, Math.floor(timeoutMs / 3))));
    } catch {
      killProcessTree(rt.chrome.pid);
    }
  }
  while (!exited(rt.chrome) && Date.now() < deadline) {
    await sleep(50);
  }
  if (!exited(rt.chrome) && rt.chrome.pid) {
    try {
      process.kill(-rt.chrome.pid, "SIGKILL");
    } catch {
      try {
        process.kill(rt.chrome.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    const killedDeadline = Date.now() + 1_000;
    while (!exited(rt.chrome) && Date.now() < killedDeadline) await sleep(25);
  }
  if (rt.xvfb?.pid) {
    try {
      process.kill(rt.xvfb.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (!exited(rt.chrome)) throw new Error("Chrome did not exit; its profile remains locked");
  clearSingletonLocks(rt.profileDir);
}

export async function chromeVersion(bin = config.chromeBin): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

export async function withTempProfile<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tallylamp-ref-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeFirstRunAck(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, "First Run"), "");
}
