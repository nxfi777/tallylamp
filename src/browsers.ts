import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config, downloadDir, profileDir, seedDir } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { Capacity } from "./capacity.js";
import { Workers } from "./workers.js";
import { PageCacheEvictor, type InUse } from "./page-cache.js";
import { activity, audit, type AuditActor } from "./audit.js";
import { isValidName, slugify } from "./names.js";
import { sanitizeMetadata, type BrowserMetadata } from "./metadata.js";
import { requireScope, type Principal } from "./auth.js";
import { launchChrome, stopRuntime, type ChromeRuntime, chromeVersion, clearSingletonLocks, parseSize } from "./chrome.js";
import { browserWsUrl, listPages, CdpClient } from "./cdp.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { parseBrowserProxy, proxyView } from "./browser-proxy.js";
import { dialTunnel, dropTunnelsFor } from "./tunnels.js";
import { startFakeChrome } from "./fake-chrome.js";
import { startLinkedRuntime } from "./linked-cdp.js";
import { dropLinksFor, linkedAllows, linkView, liveLink } from "./linked.js";
import { accessAllows, activeGrant, grantAccess, grantsFor, isPermanent, type GrantAccess } from "./lending.js";
import { dropGuestsFor, guestIdFromController, guestLeaseEnd, noteGuestControlEnded, startGuestCooldown } from "./guests.js";
import { SiteDetector } from "./site-detection.js";
import {
  deleteSiteAccessForBrowser,
  listSeedSiteAccess,
  listSiteAccess,
  removeSeedSiteAccess,
  restoreSiteAccess,
  setSeedSiteAccess,
  snapshotSiteAccess,
} from "./site-access.js";

export type BrowserRow = {
  id: string;
  name: string;
  slug: string;
  owner_type: string;
  owner_id: string;
  created_by_type: string;
  created_by_principal_id: string;
  created_via: string;
  created_at: string;
  persistent: number;
  ephemeral_ttl_sec: number | null;
  status: string;
  profile_path: string;
  seed_id: string | null;
  current_url: string | null;
  current_title: string | null;
  chrome_version: string | null;
  sandbox_status: string | null;
  gpu_status: string | null;
  last_activity_at: string | null;
  client_name: string | null;
  client_version: string | null;
  metadata_json: string;
  labels_json: string;
  lendable: number;
  /** Internal, may contain credentials. Never serialize the raw browser row. */
  proxy_json: string | null;
  extensions_enabled: number;
  agent_desktop_enabled: number;
  /** 'managed': a Chrome this process launched. 'linked': a person's own browser, via the extension. */
  kind: string;
  /** Room is held for it on a host with a process ceiling, and it is never stopped to make room. */
  pinned: number;
  /** Threads its process tree reached in the first minute of its last start, and over its last run. */
  launch_threads: number | null;
  peak_threads: number | null;
  /** Null: its Chrome and profile are on this instance. Otherwise the worker that has them (workers.ts). */
  worker_id: string | null;
};

/** Notes for whichever agent next makes a call on the browser. Kept for half an hour. */
type Notice = { seq: number; at: number; text: string };
const NOTICE_TTL_MS = 30 * 60_000;
/** Navigations that must fail with net::ERR_ABORTED in a row, across two or more hosts. */
const ABORTED_STREAK = 3;

export type ControlState = {
  controllerType: "agent" | "human" | "none";
  controllerId: string | null;
  expiresAt: string | null;
  leaseToken: string | null;
};

type SavedProfileResult = { id: string; path: string; resumed: boolean; resumeError?: string };

export class BrowserManager {
  private siteDetector = new SiteDetector();
  /** What each runtime was last seen showing, so the page poll can tell a change from a repeat. */
  private lastPage = new WeakMap<ChromeRuntime, string>();
  private runtimes = new Map<string, ChromeRuntime>();
  private windowContents = new Map<string, { width: number; height: number }>();
  private starting = new Map<string, Promise<ChromeRuntime>>();
  private profileSaves = new Map<string, Promise<SavedProfileResult>>();
  private savingSeeds = new Set<string>();
  private resumeReservations = new Set<string>();
  private snapshotCleanup = new Set<string>();
  private mcpAttached = new Map<string, number>();
  private viewers = new Map<string, number>();
  /** Runtimes that are a listener in this process rather than a Chrome to kill: the test fake, and a linked browser's CDP shim. */
  private shimClosers = new Map<string, () => Promise<void>>();
  private pageCache = new PageCacheEvictor(() => this.chromeInUse());
  /** Notified when a browser stops or is destroyed, so the MCP bridge can be torn down. */
  private onGone?: (browserId: string) => Promise<void> | void;
  /**
   * One egress proxy per browser rather than one for the fleet. The proxy is where a tunnel
   * binding is matched, and a shared CONNECT listener cannot say *which* browser a socket
   * came from -- so per-browser is what makes "this browser may reach this address" a
   * statement the proxy can actually enforce. Chrome already took the port per launch.
   */
  private proxies = new Map<string, EgressProxy>();
  /** Browsers found broken while their Chrome is still up. publicView reports them "unhealthy". */
  private unhealthy = new Map<string, { reason: string; since: string }>();
  /** Browsers whose profile is being copied to another host (moveTo). */
  private moving = new Set<string>();
  /** Where each of those is going and how far along it is, for the dashboard. */
  private movingNow = new Map<string, { to: string; phase: string; copied: number }>();
  private abortedNavs = new Map<string, { count: number; hosts: Set<string> }>();
  private notices = new Map<string, Notice[]>();
  private noticeSeq = 0;
  shuttingDown = false;
  readonly capacity: Capacity;
  readonly workers: Workers;

  constructor() {
    this.capacity = new Capacity(this);
    this.workers = new Workers(this);
    // A control viewer restores the window itself when it is still connected. This covers the
    // path where it is not: the operator closes the dashboard tab and the 90-second lease
    // simply lapses, which would otherwise leave the agent on a window the human had resized.
    hub.on("event", (ev: { type: string; browserId?: string }) => {
      if (ev.type !== "control.released" || !ev.browserId) return;
      const id = ev.browserId;
      setTimeout(() => {
        if (this.windowContents.has(id) && this.viewerCount(id) === 0) {
          void this.restoreWindowSize(id);
        }
      }, 1000).unref?.();
    });
  }

  /**
   * Put the window back to its launch geometry. Outer bounds, not content size: the launch
   * argument is outer geometry (chrome.ts --window-size), so it is the one number we know
   * exactly, whereas the content size at launch was never measured.
   */
  private async restoreWindowSize(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    // Existence is not enough: a crashed Chrome lingers in `runtimes` until it is reaped, and
    // going through cdpWs() would call ensureRunning() and relaunch a browser nobody asked for
    // just to resize a window that no longer exists.
    if (!this.windowContents.has(id) || !rt || rt.chrome.exitCode !== null) return;
    this.windowContents.delete(id);
    const launch = parseSize(config.windowSize, { width: 1280, height: 800 });
    let cdp: CdpClient | undefined;
    try {
      cdp = new CdpClient(await browserWsUrl(rt.cdpUrl));
      await cdp.connect();
      const { targetInfos } = (await cdp.send("Target.getTargets")) as {
        targetInfos: Array<{ targetId: string; type: string }>;
      };
      const page = targetInfos.find((t) => t.type === "page");
      if (!page) return;
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as {
        sessionId: string;
      };
      const { windowId } = (await cdp.send("Browser.getWindowForTarget", {}, sessionId)) as { windowId: number };
      await cdp.send(
        "Browser.setWindowBounds",
        { windowId, bounds: { width: launch.width, height: launch.height } },
        sessionId,
      );
    } catch (e) {
      log.warn("window restore failed", { browserId: id, error: (e as Error).message });
    } finally {
      await cdp?.close();
    }
  }

  row(id: string): BrowserRow {
    const r = getDb().prepare(`SELECT * FROM browsers WHERE id = ?`).get(id) as BrowserRow | undefined;
    if (!r) throw Err.notFound("browser not found");
    return r;
  }

  bySlug(slug: string): BrowserRow | null {
    return (getDb().prepare(`SELECT * FROM browsers WHERE slug = ?`).get(slug) as BrowserRow | undefined) ?? null;
  }

  list(filter?: { ownerType?: string; ownerId?: string }): BrowserRow[] {
    if (filter?.ownerType && filter.ownerId) {
      return getDb()
        .prepare(`SELECT * FROM browsers WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC`)
        .all(filter.ownerType, filter.ownerId) as BrowserRow[];
    }
    return getDb().prepare(`SELECT * FROM browsers ORDER BY created_at DESC`).all() as BrowserRow[];
  }

  /**
   * Everything this principal may touch: what it owns, plus what it has been lent. Ownership
   * and a loan are kept visibly distinct -- `lentToMe` is what stops a borrower from mistaking
   * a browser it is holding for one it can delete.
   */
  listVisible(p: Principal): Array<BrowserRow & { lentToMe: boolean; grantAccess?: GrantAccess }> {
    if (p.type === "admin") return this.list().map((r) => ({ ...r, lentToMe: false }));
    const owned = this.list({ ownerType: "agent", ownerId: p.id });
    const seen = new Set(owned.map((r) => r.id));
    const borrowed = (
      getDb()
        .prepare(
          `SELECT b.*, g.access AS grant_access FROM browsers b JOIN browser_grants g ON g.browser_id = b.id
           WHERE g.grantee_id = ? AND g.revoked_at IS NULL AND g.expires_at > ?
           ORDER BY b.created_at DESC`,
        )
        .all(p.id, nowIso()) as Array<BrowserRow & { grant_access: string }>
    ).filter((r) => !seen.has(r.id));
    for (const r of borrowed) seen.add(r.id);
    const linked = (
      getDb()
        .prepare(
          `SELECT DISTINCT b.* FROM browsers b JOIN linked_access a ON a.browser_id = b.id
           WHERE b.kind = 'linked' AND a.agent_id IN (?, '*') ORDER BY b.created_at DESC`,
        )
        .all(p.id) as BrowserRow[]
    ).filter((r) => !seen.has(r.id));
    return [
      ...owned.map((r) => ({ ...r, lentToMe: false })),
      // The level rides along with the row: an agent holding a read grant that is shown an
      // undifferentiated "borrowed" will try to drive it and be refused tool by tool.
      ...borrowed.map((r) => ({ ...r, lentToMe: true, grantAccess: grantAccess({ access: r.grant_access }) })),
      ...linked.map((r) => ({ ...r, lentToMe: false })),
    ];
  }

  /**
   * Opt this browser in to being handed over on idle alone, with no answer from the owner.
   * Owner-only, and never inferred: it is the difference between "I will lend this if asked"
   * and "lend this out when I go quiet", and only one of those is safe for a profile holding
   * a live login.
   */
  setLendable(id: string, lendable: boolean, principal: Principal): BrowserRow {
    const row = this.row(id);
    // Auto-lending hands a profile over because its owner went quiet. That is a judgement an
    // operator can make about a Chrome in a container, never about somebody's own browser.
    if (lendable) this.assertManaged(id, "lending");
    if (principal.type !== "admin") {
      if (row.owner_id !== principal.id) throw Err.unauthorized("browser is owned by another principal");
      requireScope(principal, "browser:lend");
    }
    getDb().prepare(`UPDATE browsers SET lendable = ? WHERE id = ?`).run(lendable ? 1 : 0, id);
    audit({
      actorType: principal.type,
      actorId: principal.id,
      action: lendable ? "browser.lendable.on" : "browser.lendable.off",
      targetType: "browser",
      targetId: id,
    });
    return this.row(id);
  }

  runningCount(): number {
    return this.runtimes.size;
  }

  runtime(id: string): ChromeRuntime | undefined {
    return this.runtimes.get(id);
  }

  /** Running browsers whose Chrome is on this host: not linked browsers, and not a worker's. */
  managedIds(): string[] {
    return [...this.runtimes.keys()].filter((id) => !this.shimClosers.has(id) || !this.offHost(id));
  }

  /** Its Chrome runs somewhere else: on a person's machine (linked), or on a worker. */
  private offHost(id: string): boolean {
    const r = getDb().prepare(`SELECT kind, worker_id FROM browsers WHERE id = ?`).get(id) as Pick<BrowserRow, "kind" | "worker_id"> | undefined;
    return Boolean(r && (r.kind === "linked" || r.worker_id));
  }

  /** A listener in this process standing in for Chrome (the test fake, a linked browser's shim). */
  isShim(id: string): boolean {
    return this.shimClosers.has(id);
  }

  /** Mid-start, mid-save or mid-restart: not something to stop underneath. */
  busy(id: string): boolean {
    return this.starting.has(id) || this.profileSaves.has(id) || this.unhealthy.has(id) || this.moving.has(id);
  }

  /**
   * How long nobody has used this browser, for deciding what may be stopped to make room. A
   * person watching or holding control is using it, whatever the clock says.
   */
  idleFor(id: string): number {
    if (this.viewerCount(id) > 0 || this.isHumanControlled(id)) return 0;
    const row = this.row(id);
    return Date.now() - Date.parse(row.last_activity_at ?? row.created_at);
  }

  pinnedRows(): BrowserRow[] {
    // This host's pinned browsers. One on a worker draws on that worker's ceiling, not this one.
    return getDb().prepare(`SELECT * FROM browsers WHERE pinned = 1 AND kind = 'managed' AND worker_id IS NULL`).all() as BrowserRow[];
  }

  recordThreads(id: string, launch: number | null, peak: number | null): void {
    getDb()
      .prepare(`UPDATE browsers SET launch_threads = COALESCE(?, launch_threads), peak_threads = COALESCE(?, peak_threads) WHERE id = ?`)
      .run(launch, peak, id);
  }

  /**
   * Hold room for this browser on a host with a process ceiling, and never stop it to make room
   * for another. The administrator's call alone: pinning one browser is what lets Tallylamp
   * stop somebody else's, so an agent must not be able to pin its own.
   */
  setPinned(id: string, pinned: boolean, principal: Principal): BrowserRow {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can pin a browser");
    if (pinned) this.assertManaged(id, "pinning");
    getDb().prepare(`UPDATE browsers SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id);
    audit({ actorType: principal.type, actorId: principal.id, action: pinned ? "browser.pinned" : "browser.unpinned",
      targetType: "browser", targetId: id });
    hub.emitEvent("browser.updated", {}, id);
    return this.row(id);
  }

  /**
   * Leave a note for whoever next makes a tool call on this browser. An agent cannot be
   * woken, so this is how it learns that its browser was stopped, restarted, or caught in the
   * host running out of processes: on the back of its next call (see McpGateway).
   */
  notice(id: string, text: string): void {
    const now = Date.now();
    const list = (this.notices.get(id) ?? []).filter((n) => now - n.at < NOTICE_TTL_MS).slice(-9);
    list.push({ seq: ++this.noticeSeq, at: now, text });
    this.notices.set(id, list);
  }

  noticesSince(id: string, seq: number): Notice[] {
    const now = Date.now();
    return (this.notices.get(id) ?? []).filter((n) => n.seq > seq && now - n.at < NOTICE_TTL_MS);
  }

  /**
   * Stop a browser to give its processes to another, and say so everywhere its owner or the
   * operator might look. Its profile and its tabs are kept: --restore-last-session brings the
   * tabs back on the next start, which is why this stops rather than closing tabs.
   */
  async shedStop(id: string, threads: number, idle: boolean, why: string): Promise<void> {
    const row = this.row(id);
    const clock = new Date().toISOString().slice(11, 19);
    const what = idle ? `after ${Math.round(this.idleFor(id) / 60_000)} idle minutes` : "while it was in use";
    log.warn("stopping a browser to free host processes", { id, name: row.name, threads, idle, why });
    activity(id, "shed", `stopped ${what} ${why}`);
    audit({ actorType: "system", actorId: "capacity", action: "browser.shed", targetType: "browser", targetId: id,
      detail: { threads, idle, why } });
    this.notice(
      id,
      `Tallylamp stopped this browser at ${clock} UTC, ${what}, ${why}. It was using ${threads} of the host's processes and threads. ` +
        `Its profile and tabs are kept, and your next call starts it again once there is room.`,
    );
    hub.emitEvent("browser.shed", { threads, idle, why }, id);
    await this.stop(id);
  }

  /**
   * What a navigation through the bridge came back with. A browser that has lost the ability
   * to start renderers fails every navigation with net::ERR_ABORTED after a few seconds, which
   * one site can also do on its own, so it takes a streak across more than one host.
   */
  noteNavigation(id: string, outcome: "ok" | "aborted" | "other", url?: string): void {
    if (outcome === "ok") {
      this.abortedNavs.delete(id);
      return;
    }
    if (outcome !== "aborted") return;
    const streak = this.abortedNavs.get(id) ?? { count: 0, hosts: new Set<string>() };
    streak.count++;
    try {
      if (url) streak.hosts.add(new URL(url).host);
    } catch {
      /* not a URL; still counts */
    }
    this.abortedNavs.set(id, streak);
    if (streak.count >= ABORTED_STREAK && streak.hosts.size >= 2) {
      this.abortedNavs.delete(id);
      void this.markUnhealthy(id, `every navigation fails with net::ERR_ABORTED (${streak.count} in a row, on ${[...streak.hosts].join(", ")})`)
        .catch((e) => log.warn("unhealthy browser handling failed", { id, error: (e as Error).message }));
    }
  }

  /**
   * A browser whose Chrome is up but cannot do its job. It is reported as unhealthy, not
   * running, and restarted, up to TALLYLAMP_UNHEALTHY_RESTARTS times in half an hour; past
   * that it is left for a person to look at, rather than restarted in a loop.
   */
  async markUnhealthy(id: string, reason: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt || rt.chrome.exitCode !== null || this.shuttingDown || this.busy(id)) return;
    const row = this.row(id);
    if (row.kind === "linked" || row.status !== "running") return;
    const clock = new Date().toISOString().slice(11, 19);
    this.unhealthy.set(id, { reason, since: nowIso() });
    this.setStatus(id, "unhealthy");
    log.warn("browser unhealthy", { id, name: row.name, reason });
    activity(id, "unhealthy", reason);
    hub.emitEvent("browser.unhealthy", { reason }, id);
    if (!this.capacity.takeRestart(id)) {
      this.notice(id, `This browser is broken (${reason}). Tallylamp has restarted it ${config.unhealthyRestarts} times in the last 30 minutes, ` +
        `so it has left it running for a person to look at. Tell the user, or stop another browser and restart this one.`);
      return;
    }
    this.notice(id, `This browser broke at ${clock} UTC (${reason}), so Tallylamp restarted it. ` +
      `Its tabs from before are restored; check the page you were on before carrying on.`);
    audit({ actorType: "system", actorId: "health", action: "browser.restarted", targetType: "browser", targetId: id, detail: { reason } });
    try {
      await this.stopInternal(id);
      await this.ensureRunningInternal(id);
      hub.emitEvent("browser.restarted", { reason }, id);
    } catch (e) {
      log.warn("restarting an unhealthy browser failed", { id, error: (e as Error).message });
      this.notice(id, `Tallylamp could not restart this browser: ${(e as Error).message}`);
    } finally {
      this.unhealthy.delete(id);
    }
  }

  attachMcp(id: string): void {
    this.mcpAttached.set(id, (this.mcpAttached.get(id) ?? 0) + 1);
  }

  detachMcp(id: string): void {
    const n = (this.mcpAttached.get(id) ?? 1) - 1;
    if (n <= 0) this.mcpAttached.delete(id);
    else this.mcpAttached.set(id, n);
  }

  /** Drop every MCP session bound to this browser without stopping it. */
  async dropSessions(id: string): Promise<void> {
    await this.onGone?.(id);
  }

  onBrowserGone(fn: (browserId: string) => Promise<void> | void): void {
    this.onGone = fn;
  }

  mcpCount(id: string): number {
    return this.mcpAttached.get(id) ?? 0;
  }

  /**
   * A human with the watch page open is using the browser just as much as an agent driving
   * it, so a live viewer counts as attachment. It deliberately does not claim the control
   * lease: watching still cannot inject input.
   */
  attachViewer(id: string): void {
    this.viewers.set(id, (this.viewers.get(id) ?? 0) + 1);
  }

  detachViewer(id: string): void {
    const n = (this.viewers.get(id) ?? 1) - 1;
    if (n <= 0) this.viewers.delete(id);
    else this.viewers.set(id, n);
  }

  viewerCount(id: string): number {
    return this.viewers.get(id) ?? 0;
  }

  /** Profiles a real Chrome has open or is starting on. Shims hold no files, so they never count. */
  private chromeInUse(): InUse {
    const dirs: string[] = [];
    for (const [id, rt] of this.runtimes) {
      if (!this.shimClosers.has(id)) dirs.push(rt.profileDir);
    }
    let starting = 0;
    for (const id of this.starting.keys()) {
      if (this.runtimes.has(id)) continue;
      const row = getDb().prepare(`SELECT kind, profile_path FROM browsers WHERE id = ?`).get(id) as
        | Pick<BrowserRow, "kind" | "profile_path">
        | undefined;
      if (row?.kind === "linked") continue;
      starting++;
      if (row) dirs.push(row.profile_path);
    }
    return { dirs, idle: dirs.length === 0 && starting === 0 };
  }

  /**
   * The content size a control viewer last asked Chrome for. It lives here, not on the viewer
   * socket, because two dashboards on one browser are last-writer-wins: a per-socket "original
   * bounds" would have them restoring over each other. Null means untouched since launch.
   */
  setWindowContent(id: string, size: { width: number; height: number } | null): void {
    if (size) this.windowContents.set(id, size);
    else this.windowContents.delete(id);
  }

  windowContent(id: string): { width: number; height: number } | undefined {
    return this.windowContents.get(id);
  }

  /**
   * The X screen the browser is drawing on. A window larger than its screen is a harder
   * fingerprint tell than a letterboxed viewer, so every resize request is clamped to this.
   */
  screenSize(id: string): { width: number; height: number } {
    const screen = this.runtimes.get(id)?.screen;
    // A linked browser has no X screen to measure; its shim reports 0x0.
    return screen && screen.width > 0 ? screen : config.viewerSize;
  }

  assertAccess(p: Principal, browser: BrowserRow, kind: "read" | "control" | "delete"): void {
    if (p.type === "admin") return;
    // A person's own browser. The agents ticked for it in the dashboard may use it, and that is
    // all they may do: deleting it would also revoke the person's link, which is theirs to do.
    if (browser.kind === "linked") {
      if (kind === "delete") throw Err.unauthorized("only the administrator can delete a linked browser");
      if (!linkedAllows(browser.id, p.id)) {
        throw Err.unauthorized("this linked browser has not been shared with this agent; its owner can add it on the browser's page in the dashboard");
      }
      const scope = kind === "read" ? "browser:read:own" : "browser:control:own";
      if (!p.scopes.includes(scope) && !p.scopes.includes("*")) throw Err.unauthorized(`missing ${scope}`);
      return;
    }
    if (browser.owner_type !== "agent" || browser.owner_id !== p.id) {
      // A live grant is the only thing that opens someone else's browser. Deleting a browser
      // you were merely lent -- along with its profile, and every login inside it -- stays
      // impossible however generous the owner was feeling, so `delete` never consults the
      // grant table at all.
      const needed: GrantAccess | null = kind === "delete" ? null : kind;
      const grant = needed ? activeGrant(browser.id, p.id) : null;
      if (grant && needed) {
        const held = grantAccess(grant);
        if (!accessAllows(held, needed)) {
          throw Err.grantLevel(
            `your grant on this browser is "read", which permits looking at pages and nothing else. ` +
              `Ask for "control" with tallylamp_request_browser (access: "control"); the administrator ` +
              `answers that, and your read access stays in force meanwhile.`,
          );
        }
        // `browser:borrow` gates agent-to-agent lending and keeps doing so: borrowing a peer's
        // profile hands over its live logins and the scope is the opt-in for that.
        //
        // A grant the ADMINISTRATOR issued on their own browser stands on its own. Requiring a
        // scope there would mean an approval that does not actually grant anything -- the
        // operator would click approve and the agent would still be refused until they went and
        // edited its scopes, which is a second, invisible approval step and a support ticket.
        if (browser.owner_type === "agent") requireScope(p, "browser:borrow");
        return;
      }
      throw Err.unauthorized("browser is owned by another principal");
    }
    const scope =
      kind === "read" ? "browser:read:own" : kind === "delete" ? "browser:delete:own" : "browser:control:own";
    if (!p.scopes.includes(scope) && !p.scopes.includes("*")) throw Err.unauthorized(`missing ${scope}`);
  }

  /**
   * Refuse an action whose only authorisation would be a grant.
   *
   * `assertAccess(..., "control")` admits a borrower, which is right for driving and wrong for
   * everything that changes the resource rather than the page: stopping it, renaming it,
   * editing its metadata, recording a signed-in site against it. Those belong to whoever owns
   * the profile, and a loan -- at either level, however it was issued -- is not ownership.
   *
   * Deletion is not on this list because it never consulted the grant table in the first place.
   */
  assertNotBorrowed(p: Principal, browser: BrowserRow, what: string): void {
    if (p.type === "admin") return;
    if (browser.kind === "linked") return; // linked browsers keep their own access-list route
    if (browser.owner_type === "agent" && browser.owner_id === p.id) return;
    if (activeGrant(browser.id, p.id)) {
      throw Err.unauthorized(`${what} is owner-only; being lent this browser is not permission to do it`);
    }
  }

  create(input: {
    principal: Principal;
    via: "dashboard" | "control_api" | "mcp";
    name?: string;
    persistent?: boolean;
    metadata?: unknown;
    proxy?: unknown;
    seedId?: string;
    clientName?: string;
    clientVersion?: string;
    /** Where it runs: a worker's id, null for this instance, undefined to let placement decide. */
    workerId?: string | null;
  }): BrowserRow {
    if (this.shuttingDown) throw Err.browserUnavailable("tallylamp is shutting down");
    const proxy = parseBrowserProxy(input.proxy);
    let workerId: string | null;
    if (input.workerId !== undefined) {
      // Which container a profile sits in is the operator's call, like pinning.
      if (input.principal.type !== "admin") throw Err.unauthorized("only the administrator can choose where a browser runs");
      workerId = input.workerId;
      if (workerId) {
        const problem = this.workers.unusable(this.workers.row(workerId));
        if (problem) throw Err.browserUnavailable(problem);
        if (input.seedId) throw Err.invalid("a browser made from a saved profile starts on the main instance, where saved profiles are kept; move it to a worker afterwards");
      }
    } else {
      // A saved profile is copied from this instance's disk, so its browser starts here.
      workerId = input.seedId ? null : this.workers.pick();
    }
    if (input.principal.type === "agent") {
      const own = this.list({ ownerType: "agent", ownerId: input.principal.id }).length;
      // 0 is no per-agent cap.
      if (input.principal.maxBrowsers > 0 && own >= input.principal.maxBrowsers) {
        throw Err.fleetFull(`agent ${input.principal.name} is at max browsers (${input.principal.maxBrowsers})`);
      }
    }
    // Saved profiles are independent copies, with reusable descriptive metadata.
    // Authorize before reading or copying any saved authenticated state.
    let seed: { path: string; metadata_json: string } | undefined;
    if (input.seedId) {
      if (input.principal.type === "agent") requireScope(input.principal, "seed:use");
      seed = getDb().prepare(`SELECT path, metadata_json FROM seeds WHERE id = ?`).get(input.seedId) as typeof seed;
      if (!seed) throw Err.notFound("saved profile not found");
    }
    const metadata = sanitizeMetadata({ ...(seed ? JSON.parse(seed.metadata_json) : {}), ...sanitizeMetadata(input.metadata) });
    const id = randomBytes(8).toString("hex");
    const name = input.name?.trim() || metadata.project || metadata.purpose || `browser-${id.slice(0, 6)}`;
    let slug = slugify(name, `b-${id.slice(0, 8)}`);
    if (this.bySlug(slug)) slug = `${slug}-${id.slice(0, 4)}`;
    if (!isValidName(slug)) slug = `b-${id.slice(0, 8)}`;
    const persistent = input.persistent !== false;
    const profile = profileDir(id);
    // On a worker the profile is made there, at its first start. Nothing is kept here.
    if (!workerId) {
      mkdirSync(profile, { recursive: true });
      mkdirSync(downloadDir(id), { recursive: true });
    }
    if (input.seedId) {
      // A seed is a whole authenticated profile, so cloning one is a credential transfer and
      // is gated separately from browser:create. Checked before the copy so a refusal cannot
      // leave a seeded profile on disk.
      cpSync(seed!.path, profile, { recursive: true });
      clearSingletonLocks(profile);
      audit({
        actorType: input.principal.type,
        actorId: input.principal.id,
        action: "seed.used",
        targetType: "seed",
        targetId: input.seedId,
        detail: { browserId: id },
      });
    }
    getDb()
      .prepare(
        `INSERT INTO browsers(
          id, name, slug, owner_type, owner_id, created_by_type, created_by_principal_id, created_via,
          created_at, persistent, status, profile_path, seed_id, client_name, client_version, metadata_json, labels_json, proxy_json, agent_desktop_enabled, extensions_enabled, worker_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name.slice(0, 80),
        slug,
        input.principal.type,
        input.principal.id,
        input.principal.type,
        input.principal.id,
        input.via,
        nowIso(),
        persistent ? 1 : 0,
        profile,
        input.seedId ?? null,
        input.clientName ?? null,
        input.clientVersion ?? null,
        JSON.stringify(metadata),
        JSON.stringify(metadata.labels ?? {}),
        proxy ? JSON.stringify(proxy) : null,
        // Native desktop access and extensions both need this host's X display.
        input.principal.type === "agent" && config.agentDesktopDefault ? 1 : 0,
        config.extensionsDefault ? 1 : 0,
        workerId,
      );
    if (input.seedId) restoreSiteAccess(input.seedId, id);
    audit({
      actorType: input.principal.type,
      actorId: input.principal.id,
      action: "browser.created",
      targetType: "browser",
      targetId: id,
      detail: { via: input.via, persistent, agentDesktopEnabled: input.principal.type === "agent" && config.agentDesktopDefault,
        extensionsEnabled: config.extensionsDefault, worker: workerId },
    });
    hub.emitEvent("browser.created", { name, slug, owner: input.principal.id }, id);
    return this.row(id);
  }

  /**
   * A row for a browser this process will never launch. It still gets a (permanently empty)
   * profile directory: recoverOnBoot and destroy both touch `profile_path`, and an empty
   * string there is one refactor away from an rm -rf on the wrong path.
   */
  createLinked(input: { approvedBy: Principal; name: string }): BrowserRow {
    if (this.shuttingDown) throw Err.browserUnavailable("tallylamp is shutting down");
    const id = randomBytes(8).toString("hex");
    const name = input.name.trim().slice(0, 80) || `linked-${id.slice(0, 6)}`;
    let slug = slugify(name, `b-${id.slice(0, 8)}`);
    if (this.bySlug(slug)) slug = `${slug}-${id.slice(0, 4)}`;
    if (!isValidName(slug)) slug = `b-${id.slice(0, 8)}`;
    const profile = profileDir(id);
    mkdirSync(profile, { recursive: true });
    getDb()
      .prepare(
        `INSERT INTO browsers(
          id, name, slug, owner_type, owner_id, created_by_type, created_by_principal_id, created_via,
          created_at, persistent, status, profile_path, metadata_json, labels_json, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dashboard', ?, 1, 'stopped', ?, ?, '{}', 'linked')`,
      )
      .run(
        id,
        name,
        slug,
        input.approvedBy.type,
        input.approvedBy.id,
        input.approvedBy.type,
        input.approvedBy.id,
        nowIso(),
        profile,
        JSON.stringify(sanitizeMetadata({ purpose: "A person's own browser, shared tab by tab through the Tallylamp extension" })),
      );
    audit({
      actorType: input.approvedBy.type,
      actorId: input.approvedBy.id,
      action: "browser.created",
      targetType: "browser",
      targetId: id,
      detail: { via: "dashboard", kind: "linked" },
    });
    hub.emitEvent("browser.created", { name, slug, owner: input.approvedBy.id }, id);
    return this.row(id);
  }

  /** Things that need launch flags, a profile on this disk, or an X display. */
  assertManaged(id: string, what: string): void {
    if (this.row(id).kind === "linked") {
      throw Err.invalid(`${what} is not available on a linked browser: Tallylamp did not launch it and does not hold its profile`);
    }
  }

  /**
   * Things that need this host's disk, which a browser on a worker does not have here: saving
   * its profile as a saved profile, which is kept on this instance. Refused by name until it
   * crosses to workers too. Everything else reaches a worker (workers.ts).
   */
  assertLocal(id: string, what: string): void {
    const row = this.row(id);
    if (!row.worker_id) return;
    let name = "a worker";
    try {
      name = this.workers.row(row.worker_id).name;
    } catch {
      /* the worker was removed; the sentence still holds */
    }
    throw Err.invalid(`${what} is not available yet for a browser on a worker, and ${row.name} is on ${name}. Move it to the main instance first.`);
  }

  /**
   * Move a browser to another host, profile and all, in one step. Null is this instance.
   *
   * A running browser is stopped for the copy, since Chrome holds its profile open, and
   * started again on the new host once the copy lands. If the copy fails it stays where it
   * was, and is started again there, so a failed move never leaves a browser down that was up.
   * Only the administrator: it decides which container a signed-in profile sits in.
   */
  async moveTo(id: string, workerId: string | null, principal: Principal): Promise<BrowserRow & { restarted: boolean }> {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can move a browser");
    const row = this.row(id);
    this.assertManaged(id, "moving");
    if (row.worker_id === workerId) return { ...row, restarted: false };
    if (this.moving.has(id)) throw Err.browserUnavailable("this browser is already being moved");
    if (this.starting.has(id) || this.profileSaves.has(id)) {
      throw Err.browserUnavailable("this browser is starting or saving its profile; move it when that finishes");
    }
    const hostName = (w: string | null) => {
      if (!w) return "the main instance";
      try {
        return this.workers.row(w).name;
      } catch {
        return "a removed worker";
      }
    };
    const from = hostName(row.worker_id);
    const to = hostName(workerId);
    // Checked before anything stops: a move that cannot happen must not cost a restart.
    if (workerId) {
      const problem = this.workers.unusable(this.workers.row(workerId));
      if (problem) throw Err.browserUnavailable(problem);
    }
    const rt = this.runtimes.get(id);
    const wasRunning = Boolean(rt && rt.chrome.exitCode === null);
    this.moving.add(id);
    const progress = { to, phase: "stopping", copied: 0 };
    this.movingNow.set(id, progress);
    let lastEmit = 0;
    const emit = (force = false) => {
      if (!force && Date.now() - lastEmit < 1000) return;
      lastEmit = Date.now();
      hub.emitEvent("browser.moving", { ...progress }, id);
    };
    emit(true);
    let restarted = false;
    try {
      if (wasRunning) {
        this.notice(id, `The administrator is moving this browser to ${to}. It stops for the copy and starts again there; a call made meanwhile is refused as retryable.`);
        await this.stopInternal(id);
        this.setStatus(id, "moving");
      }
      progress.phase = "copying";
      emit(true);
      try {
        await this.workers.move(this.row(id), workerId, principal, (copied) => {
          progress.copied = copied;
          emit();
        });
      } catch (e) {
        if (wasRunning) {
          this.moving.delete(id);
          await this.ensureRunningInternal(id).catch(() => undefined);
        }
        const back = wasRunning && this.runtimes.get(id) ? `, and running again` : "";
        throw Err.browserUnavailable(`Could not move ${row.name} to ${to}: ${(e as Error).message}. It is still on ${from}${back}.`);
      }
      const onWorker = workerId ? " Everything works there as before, apart from saving it as a saved profile." : "";
      this.notice(id, `The administrator moved this browser from ${from} to ${to} at ${new Date().toISOString().slice(11, 19)} UTC. Its tabs and logins came with it.${onWorker}`);
      if (wasRunning) {
        progress.phase = "starting";
        emit(true);
        this.moving.delete(id);
        await this.ensureRunningInternal(id);
        restarted = true;
      }
    } finally {
      this.moving.delete(id);
      this.movingNow.delete(id);
      if (this.row(id).status === "moving") this.setStatus(id, "stopped");
      hub.emitEvent("browser.moved", { to, restarted }, id);
    }
    return { ...this.row(id), restarted };
  }

  /**
   * The extension's socket went away: the laptop slept, the browser quit, the link was
   * revoked. Not a crash, and nothing to clean up on the far side, which is already gone.
   */
  async linkDropped(id: string): Promise<void> {
    if (!this.runtimes.has(id)) return;
    await this.stopInternal(id).catch((e) => log.warn("linked browser stop failed", { id, error: (e as Error).message }));
  }

  async ensureRunning(id: string): Promise<ChromeRuntime> {
    if (this.profileSaves.has(id)) throw Err.browserUnavailable("profile is being saved; retry when saving finishes");
    return this.ensureRunningInternal(id);
  }

  private async ensureRunningInternal(id: string): Promise<ChromeRuntime> {
    if (this.shuttingDown) throw Err.browserUnavailable("tallylamp is shutting down");
    if (this.moving.has(id)) throw Err.browserUnavailable("this browser is being moved to another host; retry when that finishes");
    const existing = this.runtimes.get(id);
    if (existing && existing.chrome.exitCode === null) return existing;
    const inflight = this.starting.get(id);
    if (inflight) return inflight;
    // `runtimes` alone was a time-of-check race, not a cap: start() only lands in it once
    // launchChrome has resolved (startupTimeoutMs is 45s), and the check above runs
    // synchronously, so N concurrent calls for N distinct ids all read a size below the cap
    // and all launched. Counting the in-flight starts is what makes the number mean anything.
    // Between runtimes.set() and the finally below an id sits in both maps, so the cap is
    // briefly one stricter than asked -- the safe direction to be wrong in.
    const occupied = new Set([...this.runtimes.keys(), ...this.starting.keys(), ...this.resumeReservations]);
    // The cap is a memory budget for Chromes on this host. A linked browser runs on somebody
    // else's machine, and a worker's on the worker: each costs a listener here, so it neither
    // counts nor is refused.
    const linked = this.offHost(id);
    for (const other of occupied) if (other !== id && this.offHost(other)) occupied.delete(other);
    const cap = config.maxBrowsers;
    if (cap !== null && !linked && occupied.size >= cap && !occupied.has(id)) {
      throw Err.fleetFull(`fleet is full (max ${cap})`);
    }
    // The ceiling that actually bites on a container is processes, not memory. Past it Chrome
    // cannot start renderers, and the tabs that crash are the other browsers' as much as this
    // one's. So a start waits for room, on this browser's own measured launch peak, and is
    // registered in `starting` before it waits: a second call for the same browser joins this
    // one instead of launching a second Chrome on the same profile.
    const before = this.row(id).status;
    const p = (async () => {
      if (!linked) {
        await this.capacity.admit(id, (need, free) => {
          this.setStatus(id, "queued");
          hub.emitEvent("browser.queued", { need, free }, id);
        });
      }
      return this.start(id);
    })();
    this.starting.set(id, p);
    try {
      return await p;
    } catch (e) {
      if (this.row(id).status === "queued") this.setStatus(id, before === "queued" ? "stopped" : before);
      throw e;
    } finally {
      this.starting.delete(id);
      this.capacity.release(id);
    }
  }

  private async start(id: string): Promise<ChromeRuntime> {
    const row = this.row(id);
    this.setStatus(id, "starting");
    hub.emitEvent("browser.starting", {}, id);
    let remoteVersion: string | null = null;
    try {
      const rt = row.kind === "linked"
        ? await (async () => {
            // "Start" cannot launch anything here. Either the extension is dialled in or it
            // is not, and the agent needs to be told which so it can ask the right person.
            const peer = liveLink(id);
            if (!peer) {
              throw Err.browserUnavailable(
                `${row.name} is a linked browser and it is offline. Ask its owner to open it and check the Tallylamp extension says Connected.`,
              );
            }
            const shim = await startLinkedRuntime(peer);
            this.shimClosers.set(id, shim.close);
            return shim.runtime;
          })()
        : row.worker_id
        ? await (async () => {
            // Its Chrome starts on the worker, which checks its own ceiling. What comes back
            // is a local endpoint relaying to it, so from here on it is a runtime like any.
            const remote = await this.workers.startRuntime(row);
            this.shimClosers.set(id, remote.close);
            remoteVersion = remote.chromeVersion;
            return remote.runtime;
          })()
        : config.fakeChrome
        ? await (async () => {
            const fake = await startFakeChrome();
            this.shimClosers.set(id, fake.close);
            return fake.runtime;
          })()
        : await (async () => {
            // A crash is only noticed by the 15s reaper, so a restart can arrive while the
            // previous listener is still open; overwriting the map entry would orphan it.
            await this.closeProxy(id);
            const proxy = await startEgressProxy({
              browserId: id,
              dial: (host, port) => dialTunnel(id, host, port),
              upstream: parseBrowserProxy(row.proxy_json ? JSON.parse(row.proxy_json) : null),
            });
            this.proxies.set(id, proxy);
            try {
              return await launchChrome({
                profileDir: row.profile_path,
                downloadDir: downloadDir(id),
                proxyPort: proxy.port,
                upstreamProxy: Boolean(row.proxy_json),
                extensionsEnabled: Boolean(row.extensions_enabled) && config.fullBrowser,
              });
            } catch (e) {
              // Chrome never came up, so nothing will ever use this listener.
              this.proxies.delete(id);
              await proxy.close().catch(() => undefined);
              throw e;
            }
          })();
      this.runtimes.set(id, rt);
      if (row.kind !== "linked" && !row.worker_id) this.capacity.launched(id);
      let version: string | null = null;
      try {
        // chromeVersion() reads the binary on this host, which says nothing about a browser
        // on somebody's laptop or on a worker. Each of those reported its own.
        version = row.kind === "linked" ? liveLink(id)?.product ?? null : row.worker_id ? remoteVersion : await chromeVersion();
      } catch {
        /* ignore */
      }
      getDb()
        .prepare(
          `UPDATE browsers SET status = 'running', chrome_version = ?, sandbox_status = ?, gpu_status = ?, last_activity_at = ? WHERE id = ?`,
        )
        .run(version, rt.sandboxStatus, rt.gpuStatus, nowIso(), id);
      hub.emitEvent("browser.running", { sandbox: rt.sandboxStatus, cdpPort: rt.cdpPort }, id);
      this.refreshPageInfo(id).catch(() => undefined);
      return rt;
    } catch (e) {
      await this.closeProxy(id);
      if (row.kind === "linked") {
        // Offline is the ordinary state of a laptop, not a fault to page anybody about.
        this.setStatus(id, "stopped");
        throw e;
      }
      this.setStatus(id, "crashed");
      hub.emitEvent("browser.crashed", { error: (e as Error).message }, id);
      throw e;
    }
  }

  /**
   * A listener without its Chrome is an open loopback port that a tunnel could still be
   * dialled through, so every path that loses a runtime has to come through here -- the
   * crash path included, which is the one that does not go through stop().
   */
  private async closeProxy(id: string): Promise<void> {
    const proxy = this.proxies.get(id);
    if (!proxy) return;
    this.proxies.delete(id);
    await proxy.close().catch((e) => log.warn("egress proxy close failed", { id, error: (e as Error).message }));
  }

  async stop(id: string): Promise<void> {
    if (this.profileSaves.has(id)) throw Err.browserUnavailable("profile is being saved; retry when saving finishes");
    return this.stopInternal(id);
  }

  private async stopInternal(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    this.setStatus(id, "stopping");
    if (rt) {
      const fake = this.shimClosers.get(id);
      // Stopping a linked browser hands every shared tab back. Closing only the listener
      // would leave the debugger attached and Chrome's "is debugging this browser" bar up,
      // with nothing on this side able to drive it: the worst of both. Best effort, because
      // the usual reason for being here is that the far end has already gone.
      await liveLink(id)?.call("unshare.all", { reason: "stopped from Tallylamp" }).catch(() => undefined);
      if (fake) {
        await fake();
        this.shimClosers.delete(id);
      } else {
        await stopRuntime(rt);
      }
      this.runtimes.delete(id);
      this.windowContents.delete(id);
      this.capacity.stopped(id);
      if (!fake) this.pageCache.stopped(rt.profileDir);
    }
    this.unhealthy.delete(id);
    this.abortedNavs.delete(id);
    await this.closeProxy(id);
    this.setStatus(id, "stopped");
    hub.emitEvent("browser.stopped", {}, id);
    try {
      await this.onGone?.(id);
    } catch (e) {
      log.warn("browser-gone hook failed", { id, error: (e as Error).message });
    }
  }

  async destroy(id: string, principal: Principal): Promise<void> {
    const row = this.row(id);
    this.assertAccess(principal, row, "delete");
    await this.stop(id);
    // Before anything here is deleted: a profile left on a worker still holds every login,
    // so the worker has to confirm it is gone, or the browser stays.
    if (row.worker_id) await this.workers.deleteBrowser(row);
    // Bindings survive a stop/start -- a restart is routine and the tunnel is to a machine,
    // not to Chrome -- but they must not outlive the browser they were scoped to.
    dropTunnelsFor(id);
    // Revoked before the row goes: the extension's token must stop working the moment the
    // browser it was scoped to stops existing, not at the next sweep.
    dropLinksFor(id, "browser deleted");
    // Before the lease row goes, so a guest viewer told to close finds nothing left to hold.
    dropGuestsFor(id);
    getDb().prepare(`DELETE FROM browser_links WHERE browser_id = ?`).run(id);
    getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
    getDb().prepare(`DELETE FROM activity_events WHERE browser_id = ?`).run(id);
    getDb().prepare(`DELETE FROM browser_tunnels WHERE browser_id = ?`).run(id);
    deleteSiteAccessForBrowser(id);
    this.siteDetector.forget(id);
    getDb().prepare(`DELETE FROM browsers WHERE id = ?`).run(id);
    rmSync(row.profile_path, { recursive: true, force: true });
    rmSync(downloadDir(id), { recursive: true, force: true });
    audit({
      actorType: principal.type,
      actorId: principal.id,
      action: "browser.deleted",
      targetType: "browser",
      targetId: id,
    });
    hub.emitEvent("browser.deleted", {}, id);
  }

  async restart(id: string): Promise<ChromeRuntime> {
    await this.stop(id);
    return this.ensureRunning(id);
  }

  setStatus(id: string, status: string): void {
    getDb().prepare(`UPDATE browsers SET status = ? WHERE id = ?`).run(status, id);
  }

  touch(id: string): void {
    getDb().prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  recordClient(id: string, name?: string, version?: string): void {
    if (!name && !version) return;
    getDb()
      .prepare(`UPDATE browsers SET client_name = COALESCE(?, client_name), client_version = COALESCE(?, client_version) WHERE id = ?`)
      .run(name ?? null, version ?? null, id);
  }

  updateProxy(id: string, input: unknown, principal: Principal): BrowserRow {
    const row = this.row(id);
    this.assertManaged(id, "a proxy");
    this.assertAccess(principal, row, "control");
    // A loan grants driving, not permission to change the owner's network route.
    if (principal.type !== "admin" && (row.owner_type !== "agent" || row.owner_id !== principal.id)) {
      throw Err.unauthorized("only the owner can change a browser proxy");
    }
    // Stops the owning agent rerouting a browser under the operator. The operator is the admin,
    // so holding control must not lock them out of their own setting.
    if (principal.type !== "admin" && this.isHumanControlled(id)) throw Err.humanControlling();
    if (this.runtimes.has(id) || this.starting.has(id) || this.profileSaves.has(id) ||
        !["stopped", "crashed"].includes(row.status)) {
      throw Err.browserUnavailable("stop the browser before changing its proxy");
    }
    const proxy = parseBrowserProxy(input);
    getDb().prepare(`UPDATE browsers SET proxy_json = ? WHERE id = ?`).run(proxy ? JSON.stringify(proxy) : null, id);
    audit({ actorType: principal.type, actorId: principal.id, action: "browser.proxy.updated", targetType: "browser", targetId: id,
      detail: { configured: proxy !== null } });
    hub.emitEvent("browser.updated", {}, id);
    return this.row(id);
  }

  /** Whether the host this browser's Chrome runs on gives it an X display: here, or its worker. */
  private hostHasDisplay(row: BrowserRow): boolean {
    return row.worker_id ? this.workers.fullBrowser(row.worker_id) : config.fullBrowser;
  }

  updateExtensions(id: string, enabled: boolean, principal: Principal): BrowserRow {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can enable extensions");
    const row = this.row(id);
    if (enabled) this.assertManaged(id, "installing extensions");
    if (enabled && !this.hostHasDisplay(row)) throw Err.invalid("extension support requires a real browser on a dedicated Xvfb display");
    // No human-control check: only the admin gets this far, the admin is who holds that lease,
    // and the flag is read on the next start. A lease outlives a stop, so checking it locked the
    // operator out of a stopped browser until they pressed Return to agent.
    if (this.runtimes.has(id) || this.starting.has(id) || this.profileSaves.has(id) ||
        !["stopped", "crashed"].includes(row.status)) {
      throw Err.browserUnavailable("stop the browser before changing extension support");
    }
    getDb().prepare("UPDATE browsers SET extensions_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    audit({ actorType: principal.type, actorId: principal.id, action: "browser.extensions.updated", targetType: "browser", targetId: id,
      detail: { enabled } });
    hub.emitEvent("browser.updated", {}, id);
    return this.row(id);
  }

  updateAgentDesktop(id: string, enabled: boolean, principal: Principal): BrowserRow {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can grant native browser access");
    const row = this.row(id);
    if (enabled) this.assertManaged(id, "native desktop access");
    if (enabled && !this.hostHasDisplay(row)) throw Err.invalid("native browser access requires a dedicated Xvfb display");
    if (enabled && row.owner_type !== "agent") throw Err.invalid("native agent access can only be granted to an agent-owned browser");
    getDb().prepare("UPDATE browsers SET agent_desktop_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    audit({ actorType: principal.type, actorId: principal.id, action: "browser.desktop-access.updated", targetType: "browser", targetId: id, detail: { enabled } });
    hub.emitEvent("browser.desktop-access.updated", {}, id);
    return this.row(id);
  }

  updateMetadata(id: string, metadata: unknown, principal: Principal): BrowserRow {
    const row = this.row(id);
    if (principal.type !== "admin") {
      this.assertAccess(principal, row, "control");
      this.assertNotBorrowed(principal, row, "changing browser metadata");
    }
    const md = sanitizeMetadata(metadata);
    getDb()
      .prepare(`UPDATE browsers SET metadata_json = ?, labels_json = ? WHERE id = ?`)
      .run(JSON.stringify(md), JSON.stringify(md.labels ?? {}), id);
    audit({
      actorType: principal.type,
      actorId: principal.id,
      action: "metadata.edited",
      targetType: "browser",
      targetId: id,
    });
    return this.row(id);
  }

  updateName(id: string, input: unknown, principal: Principal): BrowserRow {
    const row = this.row(id);
    if (principal.type !== "admin") {
      // A lending grant permits driving the browser, not rewriting the owner's profile
      // identity. Keep this owner-only just like deletion and lendability changes.
      if (row.owner_type !== "agent" || row.owner_id !== principal.id) {
        throw Err.unauthorized("browser is owned by another principal");
      }
      requireScope(principal, "browser:control:own");
    }
    const name = String(input ?? "").trim();
    if (!name) throw Err.invalid("browser name is required");
    if (name.length > 80) throw Err.invalid("browser name is longer than 80 characters");
    getDb().prepare(`UPDATE browsers SET name = ? WHERE id = ?`).run(name, id);
    audit({
      actorType: principal.type,
      actorId: principal.id,
      action: "browser.renamed",
      targetType: "browser",
      targetId: id,
      detail: { from: row.name, to: name },
    });
    hub.emitEvent("browser.renamed", { name }, id);
    return this.row(id);
  }

  controlState(id: string): ControlState {
    const row = getDb()
      .prepare(`SELECT controller_type, controller_id, acquired_at, expires_at, lease_token FROM control_leases WHERE browser_id = ?`)
      .get(id) as
      | { controller_type: string; controller_id: string; acquired_at: string; expires_at: string; lease_token: string }
      | undefined;
    // A guest's lease is only as good as the grant behind it, and it has a ceiling a heartbeat
    // cannot push past. Checked here, where every reader of the lease already comes, so no
    // path -- REST, viewer socket, MCP -- can see a guest lease that should have ended.
    const guestId = row ? guestIdFromController(row.controller_id) : null;
    const guestEnd = row && guestId ? guestLeaseEnd(guestId, id, row.acquired_at) : null;
    if (!row || Date.parse(row.expires_at) < Date.now() || guestEnd) {
      if (row) {
        getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
        if (guestId) noteGuestControlEnded(guestId);
        if (guestId && guestEnd === "max_age") {
          startGuestCooldown(guestId);
          audit({ actorType: "guest", actorId: guestId, action: "guest.control.max_age", targetType: "browser", targetId: id });
        }
        // Expiry used to be silent, so a lease that simply lapsed left the browser in whatever
        // shape the human's viewer had put it. The row is already gone, so a nested
        // controlState() call from a listener returns without emitting again.
        hub.emitEvent("control.released", { reason: guestEnd ?? "expired" }, id);
      }
      return { controllerType: "none", controllerId: null, expiresAt: null, leaseToken: null };
    }
    return {
      controllerType: row.controller_type as "agent" | "human",
      controllerId: row.controller_id,
      expiresAt: row.expires_at,
      leaseToken: row.lease_token,
    };
  }

  /**
   * `force` displaces anyone and is the administrator's alone. `preemptAgent` is the ordinary
   * human-takeover rule -- a person may take the browser off an agent, never off another
   * person -- and is what a guest gets. `actor` is who the audit log names.
   */
  acquireControl(
    id: string,
    controllerType: "agent" | "human",
    controllerId: string,
    opts?: { force?: boolean; preemptAgent?: boolean; actor?: AuditActor },
  ): ControlState {
    const cur = this.controlState(id);
    const actor: AuditActor = opts?.actor ?? { type: controllerType === "human" ? "admin" : controllerType, id: controllerId };
    const same = cur.controllerType === controllerType && cur.controllerId === controllerId;
    if (cur.controllerType !== "none" && !same) {
      const preempts = Boolean(opts?.preemptAgent) && controllerType === "human" && cur.controllerType === "agent";
      if (!opts?.force && !preempts) throw Err.alreadyControlled(`${cur.controllerType} ${cur.controllerId} holds control`);
      const displacedGuest = guestIdFromController(cur.controllerId);
      if (displacedGuest) noteGuestControlEnded(displacedGuest);
      audit({
        actorType: actor.type,
        actorId: actor.id,
        action: opts?.force ? "control.forced" : "control.preempted",
        targetType: "browser",
        targetId: id,
        detail: { ...actor.detail, previous: { controllerType: cur.controllerType, controllerId: cur.controllerId } },
      });
    }
    const token = randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + config.humanLeaseTtlMs).toISOString();
    // Re-taking a lease you already hold keeps its start time: that is what a guest's maximum
    // continuous hold is measured from, and re-acquiring must not reset it.
    getDb()
      .prepare(
        `INSERT INTO control_leases(browser_id, controller_type, controller_id, lease_token, acquired_at, expires_at, forced)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(browser_id) DO UPDATE SET
           acquired_at=CASE WHEN control_leases.controller_type = excluded.controller_type
                             AND control_leases.controller_id = excluded.controller_id
                            THEN control_leases.acquired_at ELSE excluded.acquired_at END,
           controller_type=excluded.controller_type, controller_id=excluded.controller_id,
           lease_token=excluded.lease_token, expires_at=excluded.expires_at, forced=excluded.forced`,
      )
      .run(id, controllerType, controllerId, token, nowIso(), expires, opts?.force ? 1 : 0);
    hub.emitEvent(controllerType === "human" ? "control.human" : "control.agent", { controllerId }, id);
    if (controllerType === "human") {
      audit({ actorType: actor.type, actorId: actor.id, action: "human.takeover", targetType: "browser", targetId: id, detail: actor.detail });
    }
    return this.controlState(id);
  }

  /**
   * Renew a lease. The token alone used to be enough, so anyone who had seen it -- it is in
   * every publicView -- could keep a lease alive. It now also has to come from the side that
   * holds it: an administrator renews only an administrator's lease, a guest only its own.
   */
  heartbeatControl(id: string, leaseToken: string, by: "admin" | { guestId: string }): ControlState {
    const cur = this.controlState(id);
    const holderGuest = guestIdFromController(cur.controllerId);
    const mine = by === "admin" ? cur.controllerType === "human" && !holderGuest : holderGuest === by.guestId;
    if (!leaseToken || cur.leaseToken !== leaseToken || !mine) {
      throw Err.unauthorized("invalid control lease");
    }
    const expires = new Date(Date.now() + config.humanLeaseTtlMs).toISOString();
    getDb().prepare(`UPDATE control_leases SET expires_at = ? WHERE browser_id = ?`).run(expires, id);
    return this.controlState(id);
  }

  releaseControl(id: string, actor?: AuditActor): ControlState {
    const held = getDb().prepare(`SELECT controller_id FROM control_leases WHERE browser_id = ?`).get(id) as
      | { controller_id: string }
      | undefined;
    const heldByGuest = guestIdFromController(held?.controller_id);
    getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
    if (heldByGuest) noteGuestControlEnded(heldByGuest);
    hub.emitEvent("control.released", {}, id);
    if (actor) {
      audit({
        actorType: actor.type,
        actorId: actor.id,
        action: "control.released",
        targetType: "browser",
        targetId: id,
        detail: actor.detail,
      });
    }
    return this.controlState(id);
  }

  isHumanControlled(id: string): boolean {
    return this.controlState(id).controllerType === "human";
  }

  async refreshPageInfo(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    try {
      const pages = await listPages(rt.cdpUrl);
      void this.siteDetector.scan(id, pages, () => this.runtimes.get(id) === rt);
      const page = pages.find((p) => p.type === "page") ?? pages[0];
      if (!page) return;
      // Polled every four seconds for every running browser, and each emit here has every open
      // dashboard refetch the fleet and ask for a fresh thumbnail of every running browser --
      // for a linked browser, a screenshot of its owner's own tab, taken on their laptop. So
      // only a change is written or announced. Remembered per runtime rather than read back
      // from the row: a new runtime always reports once, which is what brings the row into
      // step with it.
      const showing = `${page.url}\n${page.title}`;
      if (this.lastPage.get(rt) === showing) return;
      this.lastPage.set(rt, showing);
      getDb()
        .prepare(`UPDATE browsers SET current_url = ?, current_title = ? WHERE id = ?`)
        .run(page.url, page.title, id);
      hub.emitEvent("browser.url_changed", { url: page.url, title: page.title }, id);
    } catch {
      /* ignore */
    }
  }

  publicView(row: BrowserRow) {
    const control = this.controlState(row.id);
    const rt = this.runtimes.get(row.id);
    const metadata = JSON.parse(row.metadata_json || "{}") as BrowserMetadata;
    const sick = this.unhealthy.get(row.id);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      // "running" said only that Chrome's own process was up. A Chrome that has lost its
      // renderer zygote is up and can load nothing, and it used to be listed as running.
      status: this.movingNow.has(row.id) ? "moving" : rt ? (sick ? "unhealthy" : "running") : row.status === "running" ? "stopped" : row.status,
      // Where a move is taking it, what it is doing ("stopping", "copying", "starting") and the
      // bytes of profile copied so far. Null when it is not being moved.
      moving: this.movingNow.get(row.id) ?? null,
      health: sick ? { state: "unhealthy", reason: sick.reason, since: sick.since } : null,
      pinned: row.pinned === 1,
      // Null when its Chrome runs on this instance. Otherwise the worker that has it.
      worker: this.workerView(row),
      // Processes and threads this browser's whole tree holds against the host's ceiling. Null
      // when it is not running or the host cannot be measured.
      ...this.threadView(row),
      persistent: row.persistent === 1,
      owner: { type: row.owner_type, id: row.owner_id },
      provenance: {
        createdByType: row.created_by_type,
        createdByPrincipalId: row.created_by_principal_id,
        createdVia: row.created_via,
        createdAt: row.created_at,
      },
      reportedClient: row.client_name ? { name: row.client_name, version: row.client_version } : null,
      metadata,
      proxy: proxyView(parseBrowserProxy(row.proxy_json ? JSON.parse(row.proxy_json) : null)),
      extensionsEnabled: Boolean(row.extensions_enabled),
      agentDesktopEnabled: Boolean(row.agent_desktop_enabled),
      savedProfileId: this.linkedProfile(row.id)?.id ?? null,
      savingProfile: this.profileSaves.has(row.id),
      signedInSites: listSiteAccess(row.id),
      url: row.current_url,
      title: row.current_title,
      chromeVersion: row.chrome_version,
      sandboxStatus: row.sandbox_status,
      gpuStatus: row.gpu_status,
      lastActivityAt: row.last_activity_at,
      kind: row.kind === "linked" ? "linked" : "managed",
      // Null for a managed browser. For a linked one this is what "can I use it right now"
      // turns on: whether its extension is dialled in, and which tabs its owner has shared.
      link: row.kind === "linked" ? linkView(row.id) : null,
      control,
      lendable: row.lendable === 1,
      // Who is currently holding a loan of this browser. Provenance stays the authenticated
      // principal, so a borrower is shown as a borrower and never as the owner.
      lentTo: grantsFor(row.id).map((g) => ({
        grantId: g.id,
        granteeId: g.grantee_id,
        access: grantAccess(g),
        // Null, not the year 9999. The sentinel is a storage detail; what the operator is being
        // told is that this one does not lapse on its own and only they can end it.
        expiresAt: isPermanent(g.expires_at) ? null : g.expires_at,
        grantedBy: g.granted_by,
      })),
      mcpAttached: this.mcpCount(row.id),
      viewers: this.viewerCount(row.id),
      cdpBound: Boolean(rt),
    };
  }

  private workerView(row: BrowserRow): { id: string; name: string; online: boolean; fullBrowser: boolean } | null {
    if (!row.worker_id) return null;
    try {
      return {
        id: row.worker_id,
        name: this.workers.row(row.worker_id).name,
        online: this.workers.online(row.worker_id),
        fullBrowser: this.workers.fullBrowser(row.worker_id),
      };
    } catch {
      return { id: row.worker_id, name: "removed worker", online: false, fullBrowser: false };
    }
  }

  private threadView(row: BrowserRow): { threads: number | null; peakThreads: number | null; launchThreads: number | null } {
    if (row.kind === "linked") return { threads: null, peakThreads: null, launchThreads: null };
    if (row.worker_id) {
      return { threads: this.workers.usage(row.id)?.threads ?? null, peakThreads: row.peak_threads ?? null, launchThreads: row.launch_threads ?? null };
    }
    const { threads, peakThreads, launchThreads } = this.capacity.view(row.id);
    return { threads, peakThreads, launchThreads };
  }

  async recoverOnBoot(): Promise<void> {
    getDb().prepare(`UPDATE browsers SET status = 'stopped' WHERE status IN ('running', 'starting', 'stopping', 'queued', 'unhealthy', 'moving')`).run();
    // A browser's thread counts are only as good as the Chrome settings they were taken under.
    // On 30 September CPU pinning went on, and a browser that would now launch at about 400
    // was still sized from its unpinned 606 and refused. So when a setting that changes
    // Chrome's thread count changes, the old measurements go, and each browser is measured
    // again on its next start.
    const threadConfig = `cpus=${config.chromeCpus};renderers=${config.rendererProcessLimit}`;
    const seen = (getDb().prepare(`SELECT value FROM meta WHERE key = 'thread_config'`).get() as { value: string } | undefined)?.value;
    if (seen !== threadConfig) {
      // No record at all is an upgrade from a release that kept none: nothing is known to
      // have changed, so what has been measured stands.
      if (seen !== undefined) {
        const cleared = getDb().prepare(`UPDATE browsers SET launch_threads = NULL, peak_threads = NULL WHERE launch_threads IS NOT NULL OR peak_threads IS NOT NULL`).run();
        log.info("Chrome thread settings changed; browsers will be measured again", { from: seen, to: threadConfig, cleared: Number(cleared.changes) });
      }
      getDb().prepare(`INSERT INTO meta(key, value) VALUES ('thread_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(threadConfig);
    }
    const rows = this.list();
    for (const r of rows) {
      if (existsSync(r.profile_path)) clearSingletonLocks(r.profile_path);
    }
    log.info("recovered browser records", { count: rows.length });
  }

  async reapIdle(): Promise<void> {
    await this.cleanupDeletedProfiles();
    const now = Date.now();
    for (const [id, rt] of this.runtimes) {
      // A start in flight owns a freshly created proxy that is not yet paired with a runtime;
      // stopping underneath it would close the new listener and leave Chrome pointed at a
      // dead port.
      if (this.starting.has(id) || this.profileSaves.has(id)) continue;
      if (rt.chrome.exitCode !== null) {
        this.runtimes.delete(id);
        this.windowContents.delete(id);
        this.capacity.stopped(id);
        if (!this.shimClosers.has(id)) this.pageCache.stopped(rt.profileDir);
        this.unhealthy.delete(id);
        this.abortedNavs.delete(id);
        await this.closeProxy(id);
        if (this.row(id).kind === "linked") {
          // linkDropped() normally gets here first. This is the backstop, and a laptop that
          // went to sleep has not crashed.
          this.shimClosers.delete(id);
          this.setStatus(id, "stopped");
          hub.emitEvent("browser.stopped", {}, id);
          continue;
        }
        if (this.row(id).worker_id) {
          // Its Chrome died on the worker, or the worker went away. The listener that stood
          // in for it here is still open, and closing it also tells the worker to clean up.
          const close = this.shimClosers.get(id);
          this.shimClosers.delete(id);
          void close?.().catch(() => undefined);
          void this.onGone?.(id);
        }
        this.setStatus(id, "crashed");
        hub.emitEvent("browser.crashed", { reason: "process exited" }, id);
        continue;
      }
      const row = this.row(id);
      // A pinned browser is one the operator wants kept up, like a dashboard an agent reads
      // now and then. Idleness is not a reason to stop it.
      if (row.pinned === 1) continue;
      const last = row.last_activity_at ? Date.parse(row.last_activity_at) : Date.parse(row.created_at);
      const watched = this.viewerCount(id) > 0 || this.controlState(id).controllerType === "human";
      const ttl = watched
        ? config.attachedIdleTtlMs
        : this.mcpCount(id) > 0
          ? config.mcpAttachedIdleTtlMs
          : config.idleTtlMs;
      if (ttl > 0 && now - last > ttl) {
        log.info("reaping idle browser", { id });
        await this.stop(id);
        if (row.persistent === 0) {
          // The row is about to go, taking with it the only handle anyone had on its
          // tunnels; they would otherwise stay bound to an id that no longer resolves.
          dropTunnelsFor(id);
          if (row.worker_id) {
            // A temporary profile on a worker. If the worker cannot be asked now, keep the
            // record, so the next sweep tries again instead of forgetting the profile exists.
            try {
              await this.workers.deleteBrowser(row);
            } catch (e) {
              log.warn("could not delete a temporary profile on its worker; will retry", { id, error: (e as Error).message });
              continue;
            }
          }
          rmSync(row.profile_path, { recursive: true, force: true });
          getDb().prepare(`DELETE FROM browser_tunnels WHERE browser_id = ?`).run(id);
          deleteSiteAccessForBrowser(id);
          getDb().prepare(`DELETE FROM browsers WHERE id = ?`).run(id);
        }
      }
    }
  }

  async snapshotSeed(browserId: string, name: string, principal: Principal,
    options: { seedId?: string; metadata?: unknown } = {}): Promise<SavedProfileResult> {
    this.assertManaged(browserId, "saving a profile");
    this.assertLocal(browserId, "Saving a profile");
    // Publishing makes every login reusable. A loan grants driving, never export.
    // seed:write is an explicit grant to publish owned browsers and overwrite
    // their linked shared snapshot; seed:use alone is deliberately read-only.
    const source = this.row(browserId);
    if (principal.type !== "admin") {
      requireScope(principal, "seed:write");
      if (source.owner_type !== principal.type || source.owner_id !== principal.id) throw Err.unauthorized("only the browser owner can save its profile; borrowed browsers cannot be copied");
      this.assertAccess(principal, source, "control");
      if (this.isHumanControlled(browserId)) throw Err.humanControlling();
      if (options.seedId && this.linkedProfile(browserId)?.id !== options.seedId) throw Err.unauthorized("agents may update only the saved profile linked to their own browser");
    }
    if (this.shuttingDown) throw Err.browserUnavailable("tallylamp is shutting down");
    this.row(browserId);
    name = name.trim();
    if (!name || name.length > 80) throw Err.invalid("profile name must be between 1 and 80 characters");
    if (this.profileSaves.has(browserId) || this.starting.has(browserId) || this.row(browserId).status === "stopping") {
      throw Err.browserUnavailable("browser is busy; retry when its current operation finishes");
    }
    if (options.seedId && this.savingSeeds.has(options.seedId)) throw Err.browserUnavailable("saved profile is already being updated");
    const previous = options.seedId
      ? getDb().prepare(`SELECT path, metadata_json FROM seeds WHERE id = ?`).get(options.seedId) as { path: string; metadata_json: string } | undefined
      : undefined;
    if (options.seedId && !previous) throw Err.notFound("saved profile not found");
    const metadata = sanitizeMetadata(options.metadata ?? JSON.parse(previous?.metadata_json ?? source.metadata_json));
    const id = options.seedId ?? randomBytes(6).toString("hex");
    this.savingSeeds.add(id);
    // Publish a new immutable directory, then atomically move the DB pointer.
    // Readers continue using the old complete snapshot throughout an update.
    const dest = seedDir(`${id}-${randomBytes(6).toString("hex")}`);
    const wasRunning = !!this.runtimes.get(browserId) && this.runtimes.get(browserId)!.chrome.exitCode === null;
    if (wasRunning) this.resumeReservations.add(browserId);
    const work = Promise.resolve().then(async (): Promise<SavedProfileResult> => {
      let saved = false;
      let failure: unknown;
      let resumeError: string | undefined;
      try {
        if (wasRunning) {
          const runtime = this.runtimes.get(browserId)!;
          const fake = config.fakeChrome;
          // A save can happen immediately after sign-in, before periodic polling.
          // Refresh the inventory before closing Chrome; copy credentials even if
          // a page cannot be inspected (badges are observations, not the profile).
          try {
            await this.siteDetector.scan(browserId, await listPages(runtime.cdpUrl), () => this.runtimes.get(browserId) === runtime, true);
          } catch { log.warn("save-time site detection unavailable; keeping recorded sites", { browserId }); }
          await this.stopInternal(browserId);
          if (!fake && (runtime.chrome.signalCode !== null || runtime.chrome.exitCode !== 0)) {
            throw Err.browserUnavailable("Chrome did not close cleanly; no saved profile was published. Retry Save profile.");
          }
        }
        await this.copyProfile(this.row(browserId).profile_path, dest);
        clearSingletonLocks(dest);
        const db = getDb();
        db.exec("BEGIN IMMEDIATE");
        try {
          if (previous) {
            db.prepare(`UPDATE seeds SET name = ?, path = ?, created_from_browser_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`)
              .run(name, dest, browserId, JSON.stringify(metadata), nowIso(), id);
            db.prepare(`DELETE FROM seed_site_access WHERE seed_id = ?`).run(id);
          } else {
            db.prepare(`INSERT INTO seeds(id, name, path, created_from_browser_id, created_at, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(id, name, dest, browserId, nowIso(), JSON.stringify(metadata), nowIso());
          }
          snapshotSiteAccess(browserId, id);
          // Save as new switches this browser's save target. Normal Save then
          // updates this exact id, regardless of later browser/profile renames.
          db.prepare(`UPDATE browsers SET seed_id = ? WHERE id = ?`).run(id, browserId);
          db.exec("COMMIT");
          saved = true;
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        audit({ actorType: principal.type, actorId: principal.id, action: previous ? "seed.updated" : "seed.created", targetType: "seed", targetId: id });
        hub.emitEvent("profile.saved", { id, name }, browserId);
      } catch (e) { failure = e; }
      finally {
        if (wasRunning) {
          try { await this.ensureRunningInternal(browserId); }
          catch (e) { resumeError = (e as Error).message; }
        }
        this.resumeReservations.delete(browserId);
        if (!saved) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
        if (saved && previous) await rm(previous.path, { recursive: true, force: true }).catch(e => log.warn("old profile snapshot cleanup failed", { id, error: (e as Error).message }));
      }
      if (failure) {
        if (resumeError) throw Err.browserUnavailable(`Profile was not saved and the browser could not resume: ${resumeError}`);
        throw failure;
      }
      return { id, path: dest, resumed: wasRunning && !resumeError, ...(resumeError ? { resumeError } : {}) };
    });
    this.profileSaves.set(browserId, work);
    try { return await work; }
    finally { this.profileSaves.delete(browserId); this.savingSeeds.delete(id); }
  }

  protected async copyProfile(source: string, destination: string): Promise<void> {
    await cp(source, destination, { recursive: true, filter: file => !["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"].includes(path.basename(file)) });
  }

  linkedProfile(browserId: string): { id: string; name: string } | null {
    const row = this.row(browserId);
    if (row.seed_id) {
      return getDb().prepare(`SELECT id, name FROM seeds WHERE id = ?`).get(row.seed_id) as { id: string; name: string } | undefined ?? null;
    }
    return null;
  }

  async deleteSeed(id: string, confirmName: unknown, principal: Principal) {
    if (principal.type !== "admin") throw Err.unauthorized("only an administrator can delete shared saved profiles");
    const seed = getDb().prepare(`SELECT name, path FROM seeds WHERE id = ?`).get(id) as { name: string; path: string } | undefined;
    if (!seed) throw Err.notFound("saved profile not found");
    if (confirmName !== seed.name) throw Err.invalid("confirm the current saved profile name before deleting; reload if it changed");
    if (this.savingSeeds.has(id)) throw Err.browserUnavailable("saved profile is being updated; retry after saving finishes");
    this.assertSnapshotPath(seed.path);
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO deleted_profile_snapshots(id, path, created_at) VALUES (?, ?, ?)`).run(id, seed.path, nowIso());
      db.prepare(`UPDATE browsers SET seed_id = NULL WHERE seed_id = ?`).run(id);
      db.prepare(`DELETE FROM seed_site_access WHERE seed_id = ?`).run(id);
      db.prepare(`DELETE FROM seeds WHERE id = ?`).run(id);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    audit({ actorType: principal.type, actorId: principal.id, action: "seed.deleted", targetType: "seed", targetId: id });
    hub.emitEvent("profile.deleted", { id, name: seed.name });
    await this.cleanupDeletedProfiles(id);
    return { deleted: true, cleanupPending: !!getDb().prepare(`SELECT 1 FROM deleted_profile_snapshots WHERE id = ?`).get(id) };
  }

  /**
   * Correct what a saved profile says it carries, without republishing the snapshot.
   *
   * Until now the manifest could only be rewritten wholesale, by snapshotting a browser over the
   * profile — a heavy, destructive thing to do to fix one missed sign-in. The guards are
   * deleteSeed's, for the same reason: snapshotSeed deletes and reinserts this whole table
   * inside its transaction, so an edit landing mid-save would be silently thrown away.
   */
  editSeedSite(id: string, input: { origin: unknown; name?: unknown; state?: unknown }, principal: Principal) {
    this.assertSeedInventoryEditable(id, principal);
    return setSeedSiteAccess(id, input, principal);
  }

  removeSeedSite(id: string, origin: unknown, principal: Principal): boolean {
    this.assertSeedInventoryEditable(id, principal);
    return removeSeedSiteAccess(id, origin, principal);
  }

  private assertSeedInventoryEditable(id: string, principal: Principal): void {
    // A shared profile's inventory is how every other agent decides which logins it can reach.
    // seed:write is permission to publish a browser you own, not to relabel someone else's.
    if (principal.type !== "admin") throw Err.unauthorized("only an administrator can edit a shared saved profile's recorded sites");
    if (!getDb().prepare(`SELECT 1 FROM seeds WHERE id = ?`).get(id)) throw Err.notFound("saved profile not found");
    if (this.savingSeeds.has(id)) throw Err.browserUnavailable("saved profile is being updated; retry after saving finishes");
  }

  private assertSnapshotPath(snapshotPath: string): void {
    const relative = path.relative(seedDir(""), snapshotPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Err.invalid("saved snapshot path is outside profile storage");
  }

  protected async removeSnapshot(snapshotPath: string): Promise<void> {
    this.assertSnapshotPath(snapshotPath);
    await rm(snapshotPath, { recursive: true, force: true });
  }

  async cleanupDeletedProfiles(id?: string): Promise<void> {
    const jobs = getDb().prepare(`SELECT id, path FROM deleted_profile_snapshots ${id ? "WHERE id = ?" : ""} LIMIT 5`).all(...(id ? [id] : [])) as Array<{ id: string; path: string }>;
    for (const job of jobs) {
      if (this.snapshotCleanup.has(job.id)) continue;
      this.snapshotCleanup.add(job.id);
      try {
        await this.removeSnapshot(job.path);
        getDb().prepare(`DELETE FROM deleted_profile_snapshots WHERE id = ?`).run(job.id);
      } catch (e) { log.warn("deleted snapshot cleanup will retry", { id: job.id, error: (e as Error).message }); }
      finally { this.snapshotCleanup.delete(job.id); }
    }
  }

  async saveProfile(browserId: string, principal: Principal, options: { name?: string; metadata?: unknown; asNew?: boolean; profileId?: string; updateOnly?: boolean } = {}) {
    const row = this.row(browserId);
    // Do not disclose another browser's linkage/name before authorization.
    this.assertAccess(principal, row, "control");
    this.assertManaged(browserId, "saving a profile");
    this.assertLocal(browserId, "Saving a profile");
    const linked = this.linkedProfile(browserId);
    const profileId = options.asNew ? undefined : options.profileId ?? linked?.id;
    if (options.updateOnly && !profileId) throw Err.invalid("browser has no saved profile; use tallylamp_save_profile first");
    const existing = profileId ? this.listSeeds().find(s => s.id === profileId) : undefined;
    if (profileId && !existing) throw Err.notFound("saved profile not found");
    const result = await this.snapshotSeed(browserId, options.name ?? existing?.name ?? row.name, principal,
      { seedId: profileId, metadata: options.metadata });
    const saved = this.listSeeds().find(s => s.id === result.id)!;
    return { profile: { id: saved.id, name: saved.name, metadata: saved.metadata, signedInSites: saved.signedInSites },
      browserId, updated: !!profileId, resumed: result.resumed, ...(result.resumeError ? { resumeError: result.resumeError } : {}) };
  }

  listSeeds() {
    const rows = getDb()
      .prepare(`SELECT id, name, path, created_from_browser_id, created_at, notes, metadata_json, updated_at FROM seeds ORDER BY COALESCE(updated_at, created_at) DESC`)
      .all() as Array<{
        id: string;
        name: string;
        path: string;
        created_from_browser_id: string | null;
        created_at: string;
        notes: string | null;
        metadata_json: string;
        updated_at: string | null;
      }>;
    return rows.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) as BrowserMetadata, signedInSites: listSeedSiteAccess(row.id) }));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.capacity.stopSampling();
    this.workers.stopPolling();
    await Promise.allSettled([...this.profileSaves.values()]);
    const ids = [...this.runtimes.keys()];
    for (const id of ids) {
      try {
        await this.stop(id);
      } catch (e) {
        log.warn("shutdown stop failed", { id, error: (e as Error).message });
      }
    }
    // Anything whose Chrome died without going through stop() still owns a listener.
    for (const id of [...this.proxies.keys()]) await this.closeProxy(id);
  }

  async cdpWs(id: string): Promise<string> {
    const rt = await this.ensureRunning(id);
    return browserWsUrl(rt.cdpUrl);
  }
}

export function logToolActivity(browserId: string, tool: string): void {
  activity(browserId, tool, tool);
}
