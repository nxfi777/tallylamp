import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
};

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

export function gpuArgs(mode = config.gpu): { args: string[]; status: GpuStatus } {
  if (mode === "software") {
    return { args: ["--use-gl=angle", "--use-angle=swiftshader"], status: "software" };
  }
  if (mode === "hardware") return { args: [], status: "hardware" };
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
  let display: string | null = process.env.DISPLAY ?? null;
  let xvfb: ChildProcess | undefined;

  if (config.xvfb) {
    display = nextDisplay();
    const xvfbSize = `${size.replace(",", "x")}x24`;
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

export async function stopRuntime(rt: ChromeRuntime, timeoutMs = config.shutdownTimeoutMs): Promise<void> {
  killProcessTree(rt.chrome.pid);
  if (rt.xvfb?.pid) killProcessTree(rt.xvfb.pid);
  const start = Date.now();
  while (rt.chrome.exitCode === null && Date.now() - start < timeoutMs) {
    await sleep(50);
  }
  if (rt.chrome.exitCode === null && rt.chrome.pid) {
    try {
      process.kill(-rt.chrome.pid, "SIGKILL");
    } catch {
      try {
        process.kill(rt.chrome.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  if (rt.xvfb?.pid) {
    try {
      process.kill(rt.xvfb.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
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
