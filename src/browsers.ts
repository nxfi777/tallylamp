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
import type { Principal } from "./auth.js";
import { launchChrome, stopRuntime, type ChromeRuntime, chromeVersion, clearSingletonLocks } from "./chrome.js";
import { browserWsUrl, listPages } from "./cdp.js";
import type { EgressProxy } from "./egress-proxy.js";
import { startFakeChrome } from "./fake-chrome.js";

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
};

export type ControlState = {
  controllerType: "agent" | "human" | "none";
  controllerId: string | null;
  expiresAt: string | null;
  leaseToken: string | null;
};

export class BrowserManager {
  private runtimes = new Map<string, ChromeRuntime>();
  private starting = new Map<string, Promise<ChromeRuntime>>();
  private mcpAttached = new Map<string, number>();
  private fakeClosers = new Map<string, () => Promise<void>>();
  proxy?: EgressProxy;
  shuttingDown = false;

  constructor(proxy?: EgressProxy) {
    this.proxy = proxy;
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

  mcpCount(id: string): number {
    return this.mcpAttached.get(id) ?? 0;
  }

  assertAccess(p: Principal, browser: BrowserRow, kind: "read" | "control" | "delete"): void {
    if (p.type === "admin") return;
    if (browser.owner_type !== "agent" || browser.owner_id !== p.id) {
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
      const seed = getDb().prepare(`SELECT path FROM seeds WHERE id = ?`).get(input.seedId) as { path: string } | undefined;
      if (!seed) throw Err.notFound("seed not found");
      cpSync(seed.path, profile, { recursive: true });
      clearSingletonLocks(profile);
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
    if (this.runtimes.size >= config.maxBrowsers && !this.runtimes.has(id)) {
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
        : await launchChrome({
            profileDir: row.profile_path,
            downloadDir: downloadDir(id),
            proxyPort: this.proxy?.port,
          });
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
      this.setStatus(id, "crashed");
      hub.emitEvent("browser.crashed", { error: (e as Error).message }, id);
      throw e;
    }
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
    }
    this.setStatus(id, "stopped");
    hub.emitEvent("browser.stopped", {}, id);
  }

  async destroy(id: string, principal: Principal): Promise<void> {
    const row = this.row(id);
    this.assertAccess(principal, row, "delete");
    await this.stop(id);
    getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
    getDb().prepare(`DELETE FROM activity_events WHERE browser_id = ?`).run(id);
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

  controlState(id: string): ControlState {
    const row = getDb()
      .prepare(`SELECT controller_type, controller_id, expires_at, lease_token FROM control_leases WHERE browser_id = ?`)
      .get(id) as
      | { controller_type: string; controller_id: string; expires_at: string; lease_token: string }
      | undefined;
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      if (row) getDb().prepare(`DELETE FROM control_leases WHERE browser_id = ?`).run(id);
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
      url: row.current_url,
      title: row.current_title,
      chromeVersion: row.chrome_version,
      sandboxStatus: row.sandbox_status,
      gpuStatus: row.gpu_status,
      lastActivityAt: row.last_activity_at,
      control,
      mcpAttached: this.mcpCount(row.id),
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
      if (rt.chrome.exitCode !== null) {
        this.runtimes.delete(id);
        this.setStatus(id, "crashed");
        hub.emitEvent("browser.crashed", { reason: "process exited" }, id);
        continue;
      }
      const row = this.row(id);
      const last = row.last_activity_at ? Date.parse(row.last_activity_at) : Date.parse(row.created_at);
      const attached = this.mcpCount(id) > 0 || this.controlState(id).controllerType === "human";
      const ttl = attached ? config.attachedIdleTtlMs : config.idleTtlMs;
      if (ttl > 0 && now - last > ttl) {
        log.info("reaping idle browser", { id });
        await this.stop(id);
        if (row.persistent === 0) {
          rmSync(row.profile_path, { recursive: true, force: true });
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
    return getDb().prepare(`SELECT id, name, path, created_from_browser_id, created_at, notes FROM seeds ORDER BY created_at DESC`).all();
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
  }

  async cdpWs(id: string): Promise<string> {
    const rt = await this.ensureRunning(id);
    return browserWsUrl(rt.cdpUrl);
  }
}

export function logToolActivity(browserId: string, tool: string): void {
  activity(browserId, tool, tool);
}
