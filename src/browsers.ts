import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config, downloadDir, profileDir, seedDir } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { activity, audit } from "./audit.js";
import { isValidName, slugify } from "./names.js";
import { sanitizeMetadata, type BrowserMetadata } from "./metadata.js";
import { requireScope, type Principal } from "./auth.js";
import { launchChrome, stopRuntime, type ChromeRuntime, chromeVersion, clearSingletonLocks, parseSize } from "./chrome.js";
import { browserWsUrl, listPages, CdpClient } from "./cdp.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { dialTunnel, dropTunnelsFor } from "./tunnels.js";
import { startFakeChrome } from "./fake-chrome.js";
import { activeGrant, grantsFor } from "./lending.js";
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
};

export type ControlState = {
  controllerType: "agent" | "human" | "none";
  controllerId: string | null;
  expiresAt: string | null;
  leaseToken: string | null;
};

export class BrowserManager {
  private runtimes = new Map<string, ChromeRuntime>();
  private windowContents = new Map<string, { width: number; height: number }>();
  private starting = new Map<string, Promise<ChromeRuntime>>();
  private mcpAttached = new Map<string, number>();
  private viewers = new Map<string, number>();
  private fakeClosers = new Map<string, () => Promise<void>>();
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
    return [...owned.map((r) => ({ ...r, lentToMe: false })), ...borrowed.map((r) => ({ ...r, lentToMe: true }))];
  }

  /**
   * Opt this browser in to being handed over on idle alone, with no answer from the owner.
   * Owner-only, and never inferred: it is the difference between "I will lend this if asked"
   * and "lend this out when I go quiet", and only one of those is safe for a profile holding
   * a live login.
   */
  setLendable(id: string, lendable: boolean, principal: Principal): BrowserRow {
    const row = this.row(id);
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
    return this.runtimes.get(id)?.screen ?? config.viewerSize;
  }

  assertAccess(p: Principal, browser: BrowserRow, kind: "read" | "control" | "delete"): void {
    if (p.type === "admin") return;
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
    seedId?: string;
    clientName?: string;
    clientVersion?: string;
  }): BrowserRow {
    if (this.shuttingDown) throw Err.browserUnavailable("tallylamp is shutting down");
    if (input.principal.type === "agent") {
      const own = this.list({ ownerType: "agent", ownerId: input.principal.id }).length;
      if (own >= input.principal.maxBrowsers) {
        throw Err.fleetFull(`agent ${input.principal.name} is at max browsers (${input.principal.maxBrowsers})`);
      }
    }
    const metadata = sanitizeMetadata(input.metadata);
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
      if (input.principal.type === "agent") requireScope(input.principal, "seed:use");
      const seed = getDb().prepare(`SELECT path FROM seeds WHERE id = ?`).get(input.seedId) as { path: string } | undefined;
      if (!seed) throw Err.notFound("seed not found");
      cpSync(seed.path, profile, { recursive: true });
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
          created_at, persistent, status, profile_path, seed_id, client_name, client_version, metadata_json, labels_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?)`,
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
      );
    if (input.seedId) restoreSiteAccess(input.seedId, id);
    audit({
      actorType: input.principal.type,
      actorId: input.principal.id,
      action: "browser.created",
      targetType: "browser",
      targetId: id,
      detail: { via: input.via, persistent },
    });
    hub.emitEvent("browser.created", { name, slug, owner: input.principal.id }, id);
    return this.row(id);
  }

  async ensureRunning(id: string): Promise<ChromeRuntime> {
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
    if (this.runtimes.size + this.starting.size >= config.maxBrowsers && !this.runtimes.has(id)) {
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
      const rt = config.fakeChrome
        ? await (async () => {
            const fake = await startFakeChrome();
            this.fakeClosers.set(id, fake.close);
            return fake.runtime;
          })()
        : await (async () => {
            // A crash is only noticed by the 15s reaper, so a restart can arrive while the
            // previous listener is still open; overwriting the map entry would orphan it.
            await this.closeProxy(id);
            const proxy = await startEgressProxy({
              browserId: id,
              dial: (host, port) => dialTunnel(id, host, port),
            });
            this.proxies.set(id, proxy);
            try {
              return await launchChrome({
                profileDir: row.profile_path,
                downloadDir: downloadDir(id),
                proxyPort: proxy.port,
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
        version = await chromeVersion();
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
    const rt = this.runtimes.get(id);
    this.setStatus(id, "stopping");
    if (rt) {
      const fake = this.fakeClosers.get(id);
      if (fake) {
        await fake();
        this.fakeClosers.delete(id);
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
    getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
    getDb().prepare(`DELETE FROM activity_events WHERE browser_id = ?`).run(id);
    getDb().prepare(`DELETE FROM browser_tunnels WHERE browser_id = ?`).run(id);
    deleteSiteAccessForBrowser(id);
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
      .prepare(`SELECT controller_type, controller_id, expires_at, lease_token FROM control_leases WHERE browser_id = ?`)
      .get(id) as
      | { controller_type: string; controller_id: string; expires_at: string; lease_token: string }
      | undefined;
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      if (row) {
        getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
        // Expiry used to be silent, so a lease that simply lapsed left the browser in whatever
        // shape the human's viewer had put it. The row is already gone, so a nested
        // controlState() call from a listener returns without emitting again.
        hub.emitEvent("control.released", { reason: "expired" }, id);
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

  acquireControl(id: string, controllerType: "agent" | "human", controllerId: string, opts?: { force?: boolean }): ControlState {
    const cur = this.controlState(id);
    if (cur.controllerType !== "none" && !(cur.controllerType === controllerType && cur.controllerId === controllerId)) {
      if (!opts?.force) throw Err.alreadyControlled(`${cur.controllerType} ${cur.controllerId} holds control`);
      audit({
        actorType: controllerType,
        actorId: controllerId,
        action: "control.forced",
        targetType: "browser",
        targetId: id,
        detail: { previous: cur },
      });
    }
    const token = randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + config.humanLeaseTtlMs).toISOString();
    getDb()
      .prepare(
        `INSERT INTO control_leases(browser_id, controller_type, controller_id, lease_token, acquired_at, expires_at, forced)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(browser_id) DO UPDATE SET controller_type=excluded.controller_type, controller_id=excluded.controller_id,
           lease_token=excluded.lease_token, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, forced=excluded.forced`,
      )
      .run(id, controllerType, controllerId, token, nowIso(), expires, opts?.force ? 1 : 0);
    hub.emitEvent(controllerType === "human" ? "control.human" : "control.agent", { controllerId }, id);
    if (controllerType === "human") {
      audit({ actorType: "admin", actorId: controllerId, action: "human.takeover", targetType: "browser", targetId: id });
    }
    return this.controlState(id);
  }

  heartbeatControl(id: string, leaseToken: string): ControlState {
    const cur = this.controlState(id);
    if (cur.leaseToken !== leaseToken) throw Err.unauthorized("invalid control lease");
    const expires = new Date(Date.now() + config.humanLeaseTtlMs).toISOString();
    getDb().prepare(`UPDATE control_leases SET expires_at = ? WHERE browser_id = ?`).run(expires, id);
    return this.controlState(id);
  }

  releaseControl(id: string, principal?: Principal): ControlState {
    getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
    hub.emitEvent("control.released", {}, id);
    if (principal) {
      audit({
        actorType: principal.type,
        actorId: principal.id,
        action: "control.released",
        targetType: "browser",
        targetId: id,
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
      signedInSites: listSiteAccess(row.id),
      url: row.current_url,
      title: row.current_title,
      chromeVersion: row.chrome_version,
      sandboxStatus: row.sandbox_status,
      gpuStatus: row.gpu_status,
      lastActivityAt: row.last_activity_at,
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
    const now = Date.now();
    for (const [id, rt] of this.runtimes) {
      // A start in flight owns a freshly created proxy that is not yet paired with a runtime;
      // stopping underneath it would close the new listener and leave Chrome pointed at a
      // dead port.
      if (this.starting.has(id)) continue;
      if (rt.chrome.exitCode !== null) {
        this.runtimes.delete(id);
        this.windowContents.delete(id);
        await this.closeProxy(id);
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

  async snapshotSeed(browserId: string, name: string, principal: Principal): Promise<{ id: string; path: string }> {
    const row = this.row(browserId);
    if (this.runtimes.has(browserId)) {
      throw Err.invalid("stop the browser before snapshotting its profile");
    }
    const id = randomBytes(6).toString("hex");
    const dest = seedDir(id);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(row.profile_path, dest, { recursive: true });
    clearSingletonLocks(dest);
    getDb()
      .prepare(`INSERT INTO seeds(id, name, path, created_from_browser_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, dest, browserId, nowIso());
    snapshotSiteAccess(browserId, id);
    audit({
      actorType: principal.type,
      actorId: principal.id,
      action: "seed.created",
      targetType: "seed",
      targetId: id,
    });
    return { id, path: dest };
  }

  listSeeds() {
    const rows = getDb()
      .prepare(`SELECT id, name, path, created_from_browser_id, created_at, notes FROM seeds ORDER BY created_at DESC`)
      .all() as Array<{
        id: string;
        name: string;
        path: string;
        created_from_browser_id: string | null;
        created_at: string;
        notes: string | null;
      }>;
    return rows.map((row) => ({ ...row, signedInSites: listSeedSiteAccess(row.id) }));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
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
