import { randomBytes } from "node:crypto";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import type { Principal } from "./auth.js";
import { audit } from "./audit.js";
import { hub } from "./events.js";

export const SITE_ACCESS_STATES = ["confirmed", "expected", "needs_sign_in"] as const;
export type SiteAccessState = (typeof SITE_ACCESS_STATES)[number];

type SiteAccessRow = {
  id: string;
  browser_id: string;
  origin: string;
  name: string;
  state: SiteAccessState;
  reported_by_type: string;
  reported_by_id: string;
  reported_at: string;
  last_confirmed_at: string | null;
  inherited_from_seed_id: string | null;
};

export type SiteAccessView = {
  id: string;
  origin: string;
  name: string;
  state: SiteAccessState;
  reportedBy: { type: string; id: string };
  reportedAt: string;
  lastConfirmedAt: string | null;
  inheritedFromSeedId: string | null;
};

function view(row: SiteAccessRow): SiteAccessView {
  return {
    id: row.id,
    origin: row.origin,
    name: row.name,
    state: row.state,
    reportedBy: { type: row.reported_by_type, id: row.reported_by_id },
    reportedAt: row.reported_at,
    lastConfirmedAt: row.last_confirmed_at,
    inheritedFromSeedId: row.inherited_from_seed_id,
  };
}

/** Accept the forms people naturally paste, but store only a canonical HTTP(S) origin. */
export function normalizeSiteOrigin(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw Err.invalid("site origin is required");
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw Err.invalid("site must be a hostname or an http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw Err.invalid("site must use http or https");
  if (url.username || url.password) throw Err.invalid("site must not contain credentials");
  return url.origin;
}

function defaultName(origin: string): string {
  return new URL(origin).hostname.replace(/^www\./, "");
}

function cleanName(input: unknown, origin: string): string {
  const name = String(input ?? "").trim() || defaultName(origin);
  if (name.length > 80) throw Err.invalid("site name is longer than 80 characters");
  return name;
}

function cleanState(input: unknown): SiteAccessState {
  const state = String(input ?? "confirmed") as SiteAccessState;
  if (!(SITE_ACCESS_STATES as readonly string[]).includes(state)) {
    throw Err.invalid(`site state must be one of ${SITE_ACCESS_STATES.join(", ")}`);
  }
  return state;
}

export function listSiteAccess(browserId: string): SiteAccessView[] {
  const rows = getDb()
    .prepare(`SELECT * FROM browser_site_access WHERE browser_id = ? ORDER BY name COLLATE NOCASE, origin`)
    .all(browserId) as SiteAccessRow[];
  return rows.map(view);
}

export function reportSiteAccess(
  browserId: string,
  input: { origin: unknown; name?: unknown; state?: unknown },
  principal: Principal,
): SiteAccessView {
  const origin = normalizeSiteOrigin(input.origin);
  const name = cleanName(input.name, origin);
  const state = cleanState(input.state);
  const at = nowIso();
  const existing = getDb()
    .prepare(`SELECT id, last_confirmed_at FROM browser_site_access WHERE browser_id = ? AND origin = ?`)
    .get(browserId, origin) as { id: string; last_confirmed_at: string | null } | undefined;
  const id = existing?.id ?? randomBytes(6).toString("hex");
  const lastConfirmedAt = state === "confirmed" ? at : existing?.last_confirmed_at ?? null;
  getDb()
    .prepare(
      `INSERT INTO browser_site_access(
        id, browser_id, origin, name, state, reported_by_type, reported_by_id,
        reported_at, last_confirmed_at, inherited_from_seed_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(browser_id, origin) DO UPDATE SET
        name = excluded.name,
        state = excluded.state,
        reported_by_type = excluded.reported_by_type,
        reported_by_id = excluded.reported_by_id,
        reported_at = excluded.reported_at,
        last_confirmed_at = excluded.last_confirmed_at,
        inherited_from_seed_id = NULL`,
    )
    .run(id, browserId, origin, name, state, principal.type, principal.id, at, lastConfirmedAt);
  audit({
    actorType: principal.type,
    actorId: principal.id,
    action: "site.reported",
    targetType: "browser",
    targetId: browserId,
    detail: { origin, state },
  });
  hub.emitEvent("browser.site_access.changed", { origin, name, state }, browserId);
  return view(getDb().prepare(`SELECT * FROM browser_site_access WHERE id = ?`).get(id) as SiteAccessRow);
}

export function removeSiteAccess(browserId: string, siteId: string, principal: Principal): boolean {
  const row = getDb()
    .prepare(`SELECT origin FROM browser_site_access WHERE id = ? AND browser_id = ?`)
    .get(siteId, browserId) as { origin: string } | undefined;
  if (!row) return false;
  getDb().prepare(`DELETE FROM browser_site_access WHERE id = ? AND browser_id = ?`).run(siteId, browserId);
  audit({
    actorType: principal.type,
    actorId: principal.id,
    action: "site.removed",
    targetType: "browser",
    targetId: browserId,
    detail: { origin: row.origin },
  });
  hub.emitEvent("browser.site_access.changed", { origin: row.origin, removed: true }, browserId);
  return true;
}

export function deleteSiteAccessForBrowser(browserId: string): void {
  getDb().prepare(`DELETE FROM browser_site_access WHERE browser_id = ?`).run(browserId);
}

/** Freeze the manifest beside the profile copy. No claim becomes fresher merely by being copied. */
export function snapshotSiteAccess(browserId: string, seedId: string): void {
  getDb()
    .prepare(
      `INSERT INTO seed_site_access(seed_id, origin, name, source_state, last_confirmed_at)
       SELECT ?, origin, name, state, last_confirmed_at
       FROM browser_site_access WHERE browser_id = ?`,
    )
    .run(seedId, browserId);
}

/** A cloned login is only expected until the new browser proves the site still accepts it. */
export function restoreSiteAccess(seedId: string, browserId: string): void {
  const at = nowIso();
  getDb()
    .prepare(
      `INSERT INTO browser_site_access(
        id, browser_id, origin, name, state, reported_by_type, reported_by_id,
        reported_at, last_confirmed_at, inherited_from_seed_id
      )
      SELECT lower(hex(randomblob(6))), ?, origin, name,
        CASE WHEN source_state = 'needs_sign_in' THEN 'needs_sign_in' ELSE 'expected' END,
        'seed', ?, ?, last_confirmed_at, ?
      FROM seed_site_access WHERE seed_id = ?`,
    )
    .run(browserId, seedId, at, seedId, seedId);
}

export function listSeedSiteAccess(seedId: string): Array<{
  origin: string;
  name: string;
  state: SiteAccessState;
  lastConfirmedAt: string | null;
}> {
  return (
    getDb()
      .prepare(`SELECT origin, name, source_state, last_confirmed_at FROM seed_site_access WHERE seed_id = ? ORDER BY name COLLATE NOCASE`)
      .all(seedId) as Array<{ origin: string; name: string; source_state: SiteAccessState; last_confirmed_at: string | null }>
  ).map((row) => ({
    origin: row.origin,
    name: row.name,
    state: row.source_state,
    lastConfirmedAt: row.last_confirmed_at,
  }));
}
