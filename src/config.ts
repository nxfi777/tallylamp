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
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const raw = process.env.TALLYLAMP_DATA_DIR;
  // A Railway volume is the persistence root. Ignore relative leftovers such as
  // ./data from copying .env.example into service variables.
  if (volume) {
    if (!raw || raw === "data" || raw === "./data" || !path.isAbsolute(raw)) return volume;
    return raw;
  }
  if (raw) return path.resolve(raw);
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
  /** Deliberately shorter than idleTtlMs so an abandoned session cannot mask an idle browser. */
  get mcpSessionIdleMs() { return int("TALLYLAMP_MCP_SESSION_IDLE_SEC", 600) * 1000; },
  get mcpBridgeNodeOptions() { return str("TALLYLAMP_MCP_BRIDGE_NODE_OPTIONS", "--max-old-space-size=192 --max-semi-space-size=1"); },
  get humanLeaseTtlMs() { return int("TALLYLAMP_HUMAN_LEASE_TTL_SEC", 90) * 1000; },
  /**
   * Lending. An agent cannot be woken -- it only exists inside a turn -- so a request that
   * waits for an answer deadlocks against exactly the owners worth reclaiming from: the ones
   * that crashed. Idleness is the signal that does not need anybody to be alive, so a browser
   * its owner has not touched for this long, and which is explicitly marked lendable, is
   * handed over without an answer. Explicit approval is always faster; this is the floor.
   */
  get lendAutoGrantIdleMs() { return int("TALLYLAMP_LEND_AUTO_GRANT_IDLE_SEC", 120) * 1000; },
  /** How long a grant lasts. Short on purpose: a borrower renews by asking again. */
  get lendGrantTtlMs() { return int("TALLYLAMP_LEND_GRANT_TTL_SEC", 1800) * 1000; },
  /** How long an unanswered request stays in the queue before it expires itself. */
  get lendRequestTtlMs() { return int("TALLYLAMP_LEND_REQUEST_TTL_SEC", 600) * 1000; },
  /** What a waiting requester is told to sleep for before asking again. */
  get lendPollSec() { return int("TALLYLAMP_LEND_POLL_SEC", 30); },
  /** How long a loopback tunnel lives before it expires itself. */
  get tunnelTtlMs() { return int("TALLYLAMP_TUNNEL_TTL_SEC", 3600) * 1000; },
  get tunnelMaxTtlMs() { return int("TALLYLAMP_TUNNEL_MAX_TTL_SEC", 12 * 3600) * 1000; },
  get tunnelsPerBrowser() { return int("TALLYLAMP_TUNNELS_PER_BROWSER", 4); },
  /** Concurrent forwarded connections on one tunnel. A page opens several; a loop opens many. */
  get tunnelMaxStreams() { return int("TALLYLAMP_TUNNEL_MAX_STREAMS", 64); },
  get tunnelOpenTimeoutMs() { return int("TALLYLAMP_TUNNEL_OPEN_TIMEOUT_SEC", 10) * 1000; },
  get startupTimeoutMs() { return int("TALLYLAMP_STARTUP_TIMEOUT_SEC", 45) * 1000; },
  get shutdownTimeoutMs() { return int("TALLYLAMP_SHUTDOWN_TIMEOUT_SEC", 15) * 1000; },
  get sandbox() { return enumVal("TALLYLAMP_SANDBOX", ["auto", "on", "off"] as const, "auto"); },
  get gpu() { return enumVal("TALLYLAMP_GPU", ["auto", "software", "hardware"] as const, "auto"); },
  get chromeBin() { return detectChromeBin(); },
  get allowPrivateNetwork() { return bool("TALLYLAMP_ALLOW_PRIVATE_NETWORK", false); },
  get windowSize() { return str("TALLYLAMP_WINDOW_SIZE", "1280,800"); },
  /**
   * The Xvfb root window, deliberately larger than the Chrome window. It used to be exactly
   * the window size, which gave every browser screen.width === window.outerWidth — a pairing
   * realism.ts already probes and that almost no real desktop reports. It is also the ceiling
   * a control viewer can grow the window to, because a window bigger than its screen is a
   * worse tell than a letterboxed stage.
   */
  get xvfbScreen() { return str("TALLYLAMP_XVFB_SCREEN", "2560,1600"); },
  get interaction() { return enumVal("TALLYLAMP_INTERACTION", ["off", "natural"] as const, "off"); },
  get oauth() { return bool("TALLYLAMP_OAUTH", true); },
  get adminBearer() { return bool("TALLYLAMP_ADMIN_BEARER", false); },
  /**
   * Trusting X-Forwarded-For when nothing strips it lets any client forge req.ip and
   * walk straight through every IP rate limit. On by default only where a proxy is known
   * to be in front.
   */
  get trustProxy() { return bool("TALLYLAMP_TRUST_PROXY", Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN)); },
  get oauthAccessTtlSec() { return int("TALLYLAMP_OAUTH_ACCESS_TTL_SEC", 3600); },
  get oauthRefreshTtlSec() { return int("TALLYLAMP_OAUTH_REFRESH_TTL_SEC", 30 * 86400); },
  get oauthMaxBrowsers() { return int("TALLYLAMP_OAUTH_MAX_BROWSERS", 2); },
  get oauthClientHosts() {
    return str("TALLYLAMP_OAUTH_CLIENT_HOSTS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  get xvfb() { return bool("TALLYLAMP_XVFB", process.platform === "linux"); },
  get fakeChrome() { return bool("TALLYLAMP_FAKE_CHROME", false); },
  get sessionTtlMs() { return int("TALLYLAMP_SESSION_TTL_SEC", 86400) * 1000; },
  get viewerTicketTtlMs() { return int("TALLYLAMP_VIEWER_TICKET_TTL_SEC", 60) * 1000; },
  /**
   * How often a viewer socket is asked whether it is still there. A laptop that slept, a
   * network that went away or a hard-killed tab never sends a close frame, so 'close' never
   * fires and the socket counts as a live viewer forever -- which pins ~1 GB of Chrome on the
   * long attached TTL with nobody watching. Two unanswered pings terminate it, so detection
   * takes at most twice this.
   */
  get viewerPingMs() { return int("TALLYLAMP_VIEWER_PING_SEC", 30) * 1000; },
  /**
   * Viewer stream quality. The screencast is clamped to the real window size by default so
   * the stage renders 1:1 instead of upscaling a downsampled frame. Lower these if the
   * deployment is bandwidth-bound; screencast frames are only emitted when the page
   * actually repaints, so a settled page costs nothing.
   */
  get viewerWatchQuality() { return int("TALLYLAMP_VIEWER_WATCH_QUALITY", 60); },
  get viewerControlQuality() { return int("TALLYLAMP_VIEWER_CONTROL_QUALITY", 70); },
  get viewerWatchEveryNthFrame() { return int("TALLYLAMP_VIEWER_WATCH_EVERY_NTH", 2); },
  /**
   * everyNthFrame counts compositor updates, so it gives no absolute bound: a busy page
   * pushed ~100 fps and 6.7 MB/s per viewer. These are a real floor on the interval.
   */
  get viewerWatchMinFrameMs() { return int("TALLYLAMP_VIEWER_WATCH_MIN_FRAME_MS", 100); },
  get viewerControlMinFrameMs() { return int("TALLYLAMP_VIEWER_CONTROL_MIN_FRAME_MS", 66); },
  /** Stop feeding a viewer that is not draining; screencast is lossy, so dropping is correct. */
  get viewerHighWaterBytes() { return int("TALLYLAMP_VIEWER_HIGH_WATER_BYTES", 2 * 1024 * 1024); },
  /**
   * Above this much queued on the socket the stream is losing the race and steps down a rung.
   * Well below viewerHighWaterBytes, which is the point at which frames start being dropped:
   * the aim is to shed bitrate before it gets there, because dropping frames is what judder
   * actually is.
   */
  get viewerCongestedBytes() { return int("TALLYLAMP_VIEWER_CONGESTED_BYTES", 384 * 1024); },
  /**
   * Cap the encoded frame, independent of how big the window is. Measured on a photo-heavy
   * page: 1440x800 at q70 is 143 KB a frame, which is 2.2 MB/s at 15fps before protocol
   * overhead — more than a link to a hosted container will carry, so it stutters. Clicks are
   * mapped through the frame's own reported size, so a smaller encode stays exact; it only
   * costs sharpness, and the settle-time refinement restores that the moment the page stops
   * moving.
   *
   * maxWidth/maxHeight are applied as a constraint on the capture surface, not through
   * Emulation, so the page cannot observe them. That makes this the one big byte lever with
   * no realism cost, which is why it is set below the common window width rather than at it.
   */
  get viewerMaxEncodedWidth() { return int("TALLYLAMP_VIEWER_MAX_ENCODED_WIDTH", 1280); },
  get viewerSize() {
    const [w, h] = config.windowSize.split(",").map((n) => Number(n.trim()));
    const width = int("TALLYLAMP_VIEWER_MAX_WIDTH", Number.isFinite(w) && w > 0 ? w : 1280);
    const height = int("TALLYLAMP_VIEWER_MAX_HEIGHT", Number.isFinite(h) && h > 0 ? h : 800);
    return { width, height };
  },
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
