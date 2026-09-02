import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name}=${raw} is not a number`);
  return n;
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? def : raw;
}

function bool(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`env ${name}=${process.env[name]} must be a boolean`);
}

function enumVal<T extends string>(name: string, allowed: readonly T[], def: T): T {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return def;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`env ${name}=${process.env[name]} must be one of ${allowed.join("|")}`);
}

function detectChromeBin(): string {
  const override = process.env.TALLYLAMP_CHROME_BIN;
  if (override) return override;
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/local/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "google-chrome";
}

function defaultDataDir(): string {
  if (process.env.TALLYLAMP_DATA_DIR) return path.resolve(process.env.TALLYLAMP_DATA_DIR);
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "tallylamp");
  }
  return path.resolve("data");
}

function defaultPublicUrl(port: number): string {
  if (process.env.TALLYLAMP_PUBLIC_URL) return process.env.TALLYLAMP_PUBLIC_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://127.0.0.1:${port}`;
}

export const config = {
  get host() { return str("HOST", "0.0.0.0"); },
  get port() { return int("PORT", 8080); },
  get publicUrl() { return defaultPublicUrl(int("PORT", 8080)); },
  get extraOrigins() {
    return str("TALLYLAMP_EXTRA_ORIGINS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get adminSecret() { return process.env.ADMIN_SECRET ?? ""; },
  get dataDir() { return defaultDataDir(); },
  get maxBrowsers() { return int("TALLYLAMP_MAX_BROWSERS", 4); },
  get idleTtlMs() { return int("TALLYLAMP_IDLE_TTL_SEC", 900) * 1000; },
  get attachedIdleTtlMs() { return int("TALLYLAMP_ATTACHED_IDLE_TTL_SEC", 14400) * 1000; },
  get humanLeaseTtlMs() { return int("TALLYLAMP_HUMAN_LEASE_TTL_SEC", 90) * 1000; },
  get startupTimeoutMs() { return int("TALLYLAMP_STARTUP_TIMEOUT_SEC", 45) * 1000; },
  get shutdownTimeoutMs() { return int("TALLYLAMP_SHUTDOWN_TIMEOUT_SEC", 15) * 1000; },
  get sandbox() { return enumVal("TALLYLAMP_SANDBOX", ["auto", "on", "off"] as const, "auto"); },
  get gpu() { return enumVal("TALLYLAMP_GPU", ["auto", "software", "hardware"] as const, "auto"); },
  get chromeBin() { return detectChromeBin(); },
  get allowPrivateNetwork() { return bool("TALLYLAMP_ALLOW_PRIVATE_NETWORK", false); },
  get windowSize() { return str("TALLYLAMP_WINDOW_SIZE", "1280,800"); },
  get interaction() { return enumVal("TALLYLAMP_INTERACTION", ["off", "natural"] as const, "off"); },
  get oauth() { return bool("TALLYLAMP_OAUTH", true); },
  get xvfb() { return bool("TALLYLAMP_XVFB", process.platform === "linux"); },
  get fakeChrome() { return bool("TALLYLAMP_FAKE_CHROME", false); },
  get sessionTtlMs() { return int("TALLYLAMP_SESSION_TTL_SEC", 86400) * 1000; },
  get viewerTicketTtlMs() { return int("TALLYLAMP_VIEWER_TICKET_TTL_SEC", 60) * 1000; },
  get home() { return process.env.HOME || homedir(); },
  version: "0.1.0",
};

export function profileDir(browserId: string): string {
  return path.join(config.dataDir, "profiles", browserId);
}

export function downloadDir(browserId: string): string {
  return path.join(config.dataDir, "downloads", browserId);
}

export function seedDir(seedId: string): string {
  return path.join(config.dataDir, "seeds", seedId);
}

export function dbPath(): string {
  return path.join(config.dataDir, "tallylamp.sqlite");
}

export function trustedOrigins(): string[] {
  const set = new Set<string>([config.publicUrl, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  for (const o of config.extraOrigins) set.add(o.replace(/\/$/, ""));
  return [...set];
}
