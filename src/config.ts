import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedRelease: string | undefined;
/**
 * The release this process was built from, read from package.json beside src/ or dist/. It is
 * what a worker and the instance it joins compare: they call each other's internal API, so
 * they must be the same release.
 */
function releaseVersion(): string {
  if (cachedRelease !== undefined) return cachedRelease;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    cachedRelease = String((JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")) as { version?: string }).version ?? "unknown");
  } catch {
    cachedRelease = "unknown";
  }
  return cachedRelease;
}

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
  /** Unset or 0 means no fleet cap; any positive number caps running Chromes on this host. */
  get maxBrowsers(): number | null {
    const n = int("TALLYLAMP_MAX_BROWSERS", 0);
    return n > 0 ? n : null;
  },
  get idleTtlMs() { return int("TALLYLAMP_IDLE_TTL_SEC", 900) * 1000; },
  get attachedIdleTtlMs() { return int("TALLYLAMP_ATTACHED_IDLE_TTL_SEC", 14400) * 1000; },
  /**
   * The idle TTL for a browser whose only attachment is an MCP session. Every tool call resets
   * the idle clock, so this is how long a connected agent may go without calling one. A client
   * left open keeps its session alive for as long as it stays open (any request refreshes it,
   * reconnects included), so under attachedIdleTtlMs a browser last used at 01:55 ran to 05:55,
   * measured at ~11 vCPU for nothing. Watchers and human controllers keep attachedIdleTtlMs.
   */
  get mcpAttachedIdleTtlMs() { return int("TALLYLAMP_MCP_ATTACHED_IDLE_TTL_SEC", 1800) * 1000; },
  /** Drop the page cache a stopped Chrome leaves behind, which Railway bills as memory. See page-cache.ts. */
  get evictPageCache() { return bool("TALLYLAMP_EVICT_PAGE_CACHE", process.platform === "linux"); },
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
  /**
   * Asking costs an agent nothing and grants it nothing, so what bounds it is not a scope the
   * operator has to add first -- that would make the feature unreachable for exactly the agent
   * that needs to ask -- but a rate. These two are the whole defence against a daemon in a
   * retry loop turning the operator's inbox into a denial of service.
   */
  get lendRequestsPerMin() { return int("TALLYLAMP_LEND_REQUESTS_PER_MIN", 2); },
  get lendRequestBurst() { return int("TALLYLAMP_LEND_REQUEST_BURST", 5); },
  /** How many requests one agent may have outstanding across the whole fleet at once. */
  get lendMaxPendingPerAgent() { return int("TALLYLAMP_LEND_MAX_PENDING", 3); },
  /** The longest fixed grant an administrator can hand out from the dashboard, in seconds. */
  get lendMaxGrantSec() { return int("TALLYLAMP_LEND_MAX_GRANT_SEC", 30 * 86400); },
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
  /** Per-connector cap for a new OAuth grant; 0 means none. */
  get oauthMaxBrowsers() { return Math.max(0, int("TALLYLAMP_OAUTH_MAX_BROWSERS", 0)); },
  get oauthClientHosts() {
    return str("TALLYLAMP_OAUTH_CLIENT_HOSTS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  get xvfb() { return bool("TALLYLAMP_XVFB", process.platform === "linux"); },
  /** Host capability only. Administrators opt in through the dashboard, not an environment flag. */
  get fullBrowser() { return this.xvfb && !this.fakeChrome; },
  /** Creation-time policy only; saved per-browser revocations always win. */
  get agentDesktopDefault() { return bool("TALLYLAMP_AGENT_DESKTOP_DEFAULT", true); },
  /** Creation-time policy only, like agentDesktopDefault. Needs fullBrowser to mean anything. */
  get extensionsDefault() { return bool("TALLYLAMP_EXTENSIONS_DEFAULT", true) && this.fullBrowser; },
  get fakeChrome() { return bool("TALLYLAMP_FAKE_CHROME", false); },
  /** Where the cgroup pids controller is read (see host-limits.ts). Overridden by tests. */
  get cgroupDir() { return process.env.TALLYLAMP_CGROUP_DIR || "/sys/fs/cgroup"; },
  /** Where each browser's processes are counted (see host-limits.ts). Overridden by tests. */
  get procDir() { return process.env.TALLYLAMP_PROC_DIR || "/proc"; },
  /**
   * Host process accounting (capacity.ts). Only meaningful where the host sets a pids ceiling.
   *
   * browserThreads: what a start is assumed to need before this browser has ever been measured.
   * processHeadroom: kept free at all times, so ffmpeg, xdotool and a bridge can still start.
   * admissionWaitMs: how long a start waits for room before it is refused with fleet_full.
   * shedIdleMs: how long a browser has to go unused before it may be stopped to make room.
   *   0 turns shedding off. Pinned browsers are never shed.
   * unhealthyRestarts: automatic restarts of a broken browser allowed in 30 minutes.
   */
  get browserThreads() { return Math.max(1, int("TALLYLAMP_BROWSER_THREADS", 300)); },
  get processHeadroom() { return Math.max(0, int("TALLYLAMP_PROCESS_HEADROOM", 50)); },
  get admissionWaitMs() { return Math.max(0, int("TALLYLAMP_ADMISSION_WAIT_SEC", 30)) * 1000; },
  get shedIdleMs() { return Math.max(0, int("TALLYLAMP_SHED_IDLE_SEC", 300)) * 1000; },
  get unhealthyRestarts() { return Math.max(0, int("TALLYLAMP_UNHEALTHY_RESTARTS", 3)); },
  /**
   * Chrome thread reductions, off unless set.
   *
   * chromeCpus: run each Chrome under taskset on this many CPUs, rotating which ones, so its
   *   CPU-scaled thread pools size themselves to that rather than the 48 a Railway container
   *   reports. Measured on Railway with Chrome 154 over ten minutes on three heavy pages: a
   *   median of 346 threads unpinned, 234 on 8 CPUs and 203 on 4, with no crashed tab or
   *   failed reload in any run. It caps one browser at that many cores of CPU.
   * rendererProcessLimit: --renderer-process-limit. A soft cap that site isolation can exceed,
   *   and measured worse for memory here before (see chrome.ts). Not soak-tested.
   *
   * --in-process-gpu was an option in 0.9.x. Chrome 154 dies at launch with it here (SIGTRAP
   * before the debugging port opens), so it was removed rather than left to be tried.
   */
  get chromeCpus() { return Math.max(0, int("TALLYLAMP_CHROME_CPUS", 0)); },
  get rendererProcessLimit() { return Math.max(0, int("TALLYLAMP_RENDERER_PROCESS_LIMIT", 0)); },
  /**
   * Workers (worker.ts, workers.ts). A worker is this same image started with TALLYLAMP_JOIN:
   * it runs Chrome for another Tallylamp instance and serves nothing else.
   *
   * join: the token from Add worker on the main instance's dashboard. Setting it is what
   *   makes this process a worker.
   * workerUrl: where the main instance reaches this worker. Inferred on Railway from the
   *   service's private domain; required anywhere else.
   * workerName: shown in the dashboard. Defaults to the Railway service name.
   * placement: where a new browser goes when nobody says. "overflow" keeps it on the main
   *   instance while that has room for one, and otherwise puts it on the worker with the most
   *   room: a worker's browser cannot be saved as a saved profile, and everything it does
   *   crosses the private network, so it should not land there without a reason. "spread" always picks the host with the most room, the
   *   main instance included. "local" always keeps it on the main instance.
   */
  get join() { return (process.env.TALLYLAMP_JOIN ?? "").trim(); },
  get workerUrl() {
    const raw = (process.env.TALLYLAMP_WORKER_URL ?? "").trim().replace(/\/$/, "");
    if (raw) return raw;
    const domain = process.env.RAILWAY_PRIVATE_DOMAIN;
    return domain ? `http://${domain}:${int("PORT", 8080)}` : "";
  },
  get workerName() { return (process.env.TALLYLAMP_WORKER_NAME || process.env.RAILWAY_SERVICE_NAME || hostname()).slice(0, 80); },
  get placement() { return enumVal("TALLYLAMP_PLACEMENT", ["overflow", "spread", "local"] as const, "overflow"); },
  /** package.json's version. `version` below is the API's, and has never tracked releases. */
  get release() { return releaseVersion(); },
  get sessionTtlMs() { return int("TALLYLAMP_SESSION_TTL_SEC", 86400) * 1000; },
  get viewerTicketTtlMs() { return int("TALLYLAMP_VIEWER_TICKET_TTL_SEC", 60) * 1000; },
  /**
   * Guest links. A guest is a person handed one browser for one job (a sign-in, a 2FA prompt),
   * so every clock here is short by default and has a hard ceiling the grant cannot exceed.
   */
  get guestDefaultTtlMs() { return int("TALLYLAMP_GUEST_TTL_SEC", 3600) * 1000; },
  get guestMaxTtlMs() { return int("TALLYLAMP_GUEST_MAX_TTL_SEC", 24 * 3600) * 1000; },
  /** Longest a guest may hold control continuously before it goes back to the agent. */
  get guestMaxLeaseMs() { return int("TALLYLAMP_GUEST_MAX_LEASE_SEC", 1800) * 1000; },
  /** After that, how long before the same guest may take control again. */
  get guestLeaseCooldownMs() { return int("TALLYLAMP_GUEST_LEASE_COOLDOWN_SEC", 60) * 1000; },
  get guestsPerBrowser() { return int("TALLYLAMP_GUESTS_PER_BROWSER", 10); },
  /** Audit rows one guest link may cause over its life. Past this, its actions are refused. */
  get guestAuditBudget() { return int("TALLYLAMP_GUEST_AUDIT_BUDGET", 1000); },
  /** Live viewer sockets one guest may hold at once. */
  get guestMaxViewers() { return int("TALLYLAMP_GUEST_MAX_VIEWERS", 3); },
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
