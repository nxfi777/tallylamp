import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config, downloadDir, profileDir, seedDir } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
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
import { activeGrant, grantsFor } from "./lending.js";
import { dropGuestsFor, guestIdFromController, guestLeaseEnd, noteGuestControlEnded, startGuestCooldown } from "./guests.js";
import { SiteDetector } from "./site-detection.js";
import {
  deleteSiteAccessForBrowser,
  listSeedSiteAccess,
  listSiteAccess,
  restoreSiteAccess,
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
};

export type ControlState = {
  controllerType: "agent" | "human" | "none";
  controllerId: string | null;
  expiresAt: string | null;
  leaseToken: string | null;
};

type SavedProfileResult = { id: string; path: string; resumed: boolean; resumeError?: string };

export class BrowserManager {
  private siteDetector = new SiteDetector();
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
  /** Notified when a browser stops or is destroyed, so the MCP bridge can be torn down. */
  private onGone?: (browserId: string) => Promise<void> | void;
  /**
   * One egress proxy per browser rather than one for the fleet. The proxy is where a tunnel
   * binding is matched, and a shared CONNECT listener cannot say *which* browser a socket
   * came from -- so per-browser is what makes "this browser may reach this address" a
   * statement the proxy can actually enforce. Chrome already took the port per launch.
   */
  private proxies = new Map<string, EgressProxy>();
  shuttingDown = false;

  constructor() {
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
  listVisible(p: Principal): Array<BrowserRow & { lentToMe: boolean }> {
    if (p.type === "admin") return this.list().map((r) => ({ ...r, lentToMe: false }));
    const owned = this.list({ ownerType: "agent", ownerId: p.id });
    const seen = new Set(owned.map((r) => r.id));
    const borrowed = (
      getDb()
        .prepare(
          `SELECT b.* FROM browsers b JOIN browser_grants g ON g.browser_id = b.id
           WHERE g.grantee_id = ? AND g.revoked_at IS NULL AND g.expires_at > ?
           ORDER BY b.created_at DESC`,
        )
        .all(p.id, nowIso()) as BrowserRow[]
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
      ...borrowed.map((r) => ({ ...r, lentToMe: true })),
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
      // A live grant is the only thing that opens someone else's browser, and it opens it
      // only for driving. Deleting a browser you were merely lent -- along with its profile,
      // and every login inside it -- stays impossible however generous the owner was feeling,
      // so `delete` never consults the grant table at all.
      if (kind !== "delete" && activeGrant(browser.id, p.id)) {
        requireScope(p, "browser:borrow");
        return;
      }
      throw Err.unauthorized("browser is owned by another principal");
    }
    const scope =
      kind === "read" ? "browser:read:own" : kind === "delete" ? "browser:delete:own" : "browser:control:own";
    if (!p.scopes.includes(scope) && !p.scopes.includes("*")) throw Err.unauthorized(`missing ${scope}`);
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
  }): BrowserRow {
    if (this.shuttingDown) throw Err.browserUnavailable("tallylamp is shutting down");
    const proxy = parseBrowserProxy(input.proxy);
    if (input.principal.type === "agent") {
      const own = this.list({ ownerType: "agent", ownerId: input.principal.id }).length;
      if (own >= input.principal.maxBrowsers) {
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
    mkdirSync(profile, { recursive: true });
    mkdirSync(downloadDir(id), { recursive: true });
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
          created_at, persistent, status, profile_path, seed_id, client_name, client_version, metadata_json, labels_json, proxy_json, agent_desktop_enabled, extensions_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.principal.type === "agent" && config.agentDesktopDefault ? 1 : 0,
        config.extensionsDefault ? 1 : 0,
      );
    if (input.seedId) restoreSiteAccess(input.seedId, id);
    audit({
      actorType: input.principal.type,
      actorId: input.principal.id,
      action: "browser.created",
      targetType: "browser",
      targetId: id,
      detail: { via: input.via, persistent, agentDesktopEnabled: input.principal.type === "agent" && config.agentDesktopDefault,
        extensionsEnabled: config.extensionsDefault },
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
    // else's machine and costs a listener, so it neither counts nor is refused.
    const kindOf = (b: string) => (getDb().prepare(`SELECT kind FROM browsers WHERE id = ?`).get(b) as { kind: string } | undefined)?.kind;
    const linked = kindOf(id) === "linked";
    for (const other of occupied) if (other !== id && kindOf(other) === "linked") occupied.delete(other);
    if (!linked && occupied.size >= config.maxBrowsers && !occupied.has(id)) {
      throw Err.fleetFull(`fleet is full (max ${config.maxBrowsers})`);
    }
    const p = this.start(id);
    this.starting.set(id, p);
    try {
      return await p;
    } finally {
      this.starting.delete(id);
    }
  }

  private async start(id: string): Promise<ChromeRuntime> {
    const row = this.row(id);
    this.setStatus(id, "starting");
    hub.emitEvent("browser.starting", {}, id);
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
      let version: string | null = null;
      try {
        // chromeVersion() reads the binary on this host, which says nothing about a browser
        // on somebody's laptop. The extension reported its own.
        version = row.kind === "linked" ? liveLink(id)?.product ?? null : await chromeVersion();
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
    }
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

  updateExtensions(id: string, enabled: boolean, principal: Principal): BrowserRow {
    if (principal.type !== "admin") throw Err.unauthorized("only the administrator can enable extensions");
    const row = this.row(id);
    if (enabled) this.assertManaged(id, "installing extensions");
    if (enabled && !config.fullBrowser) throw Err.invalid("extension support requires a real browser on a dedicated Xvfb display");
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
    if (enabled && !config.fullBrowser) throw Err.invalid("native browser access requires a dedicated Xvfb display");
    if (enabled && row.owner_type !== "agent") throw Err.invalid("native agent access can only be granted to an agent-owned browser");
    getDb().prepare("UPDATE browsers SET agent_desktop_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    audit({ actorType: principal.type, actorId: principal.id, action: "browser.desktop-access.updated", targetType: "browser", targetId: id, detail: { enabled } });
    hub.emitEvent("browser.desktop-access.updated", {}, id);
    return this.row(id);
  }

  updateMetadata(id: string, metadata: unknown, principal: Principal): BrowserRow {
    const row = this.row(id);
    if (principal.type !== "admin") this.assertAccess(principal, row, "control");
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
      if (page) {
        getDb()
          .prepare(`UPDATE browsers SET current_url = ?, current_title = ? WHERE id = ?`)
          .run(page.url, page.title, id);
        hub.emitEvent("browser.url_changed", { url: page.url, title: page.title }, id);
      }
    } catch {
      /* ignore */
    }
  }

  publicView(row: BrowserRow) {
    const control = this.controlState(row.id);
    const rt = this.runtimes.get(row.id);
    const metadata = JSON.parse(row.metadata_json || "{}") as BrowserMetadata;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: rt ? "running" : row.status === "running" ? "stopped" : row.status,
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
      lentTo: grantsFor(row.id).map((g) => ({ granteeId: g.grantee_id, expiresAt: g.expires_at })),
      mcpAttached: this.mcpCount(row.id),
      viewers: this.viewerCount(row.id),
      cdpBound: Boolean(rt),
    };
  }

  async recoverOnBoot(): Promise<void> {
    getDb().prepare(`UPDATE browsers SET status = 'stopped' WHERE status IN ('running', 'starting', 'stopping')`).run();
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
        await this.closeProxy(id);
        if (this.row(id).kind === "linked") {
          // linkDropped() normally gets here first. This is the backstop, and a laptop that
          // went to sleep has not crashed.
          this.shimClosers.delete(id);
          this.setStatus(id, "stopped");
          hub.emitEvent("browser.stopped", {}, id);
          continue;
        }
        this.setStatus(id, "crashed");
        hub.emitEvent("browser.crashed", { reason: "process exited" }, id);
        continue;
      }
      const row = this.row(id);
      const last = row.last_activity_at ? Date.parse(row.last_activity_at) : Date.parse(row.created_at);
      const attached =
        this.mcpCount(id) > 0 || this.viewerCount(id) > 0 || this.controlState(id).controllerType === "human";
      const ttl = attached ? config.attachedIdleTtlMs : config.idleTtlMs;
      if (ttl > 0 && now - last > ttl) {
        log.info("reaping idle browser", { id });
        await this.stop(id);
        if (row.persistent === 0) {
          // The row is about to go, taking with it the only handle anyone had on its
          // tunnels; they would otherwise stay bound to an id that no longer resolves.
          dropTunnelsFor(id);
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
