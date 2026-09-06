import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { hasScope, type Principal } from "./auth.js";
import { dropTunnelsFor } from "./tunnels.js";
import type { BrowserManager, BrowserRow } from "./browsers.js";

/**
 * Lending a browser between agents.
 *
 * The constraint that shapes all of this: an agent cannot be woken. It exists only inside a
 * turn, so there is no way to push a request at an idle owner and no way at all to reach a
 * crashed one. Any design that *waits for an answer* therefore deadlocks against precisely the
 * owners worth reclaiming from.
 *
 * So answers are an accelerant, never the mechanism. What resolves a request is time:
 *
 *   - the owner answers on its next tool call, because the pending request rides back on the
 *     result of whatever it calls next (see McpGateway.callTool) -- reliable, because an owner
 *     that is calling a tool is by definition running;
 *   - or the browser goes idle for lendAutoGrantIdleMs and the request auto-grants, which needs
 *     nobody to be alive and is what covers the crashed owner;
 *   - or the request expires and the requester is told plainly that it did.
 *
 * Auto-grant is gated on the browser being marked `lendable`, because a profile is a live
 * credential store: handing one over is a bigger transfer than cloning a seed, and that already
 * needs its own scope. An owner that has not opted a browser in keeps the ordinary answer --
 * ownership refuses, and only an explicit grant changes that.
 */

export type GrantRow = {
  id: string;
  browser_id: string;
  grantee_id: string;
  granted_by: string;
  reason: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export type RequestRow = {
  id: string;
  browser_id: string;
  requester_id: string;
  requester_name: string | null;
  reason: string | null;
  state: "pending" | "granted" | "denied" | "expired" | "withdrawn";
  eta_sec: number | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_reason: string | null;
};

/** The live grant for this principal on this browser, if there is one. */
export function activeGrant(browserId: string, granteeId: string): GrantRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM browser_grants
       WHERE browser_id = ? AND grantee_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(browserId, granteeId, nowIso()) as GrantRow | undefined;
  return row ?? null;
}

export function grantsFor(browserId: string): GrantRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM browser_grants WHERE browser_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at`,
    )
    .all(browserId, nowIso()) as GrantRow[];
}

export function pendingFor(browserId: string): RequestRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM browser_requests WHERE browser_id = ? AND state = 'pending' AND expires_at > ?
       ORDER BY created_at`,
    )
    .all(browserId, nowIso()) as RequestRow[];
}

export function request(id: string): RequestRow {
  const row = getDb().prepare(`SELECT * FROM browser_requests WHERE id = ?`).get(id) as RequestRow | undefined;
  if (!row) throw Err.notFound("request not found");
  return row;
}

function idleMs(row: BrowserRow): number {
  const last = row.last_activity_at ? Date.parse(row.last_activity_at) : Date.parse(row.created_at);
  return Date.now() - last;
}

/**
 * Why a browser cannot be lent right now, or null if it can.
 *
 * A human lease is a hard no rather than a queue position: a takeover is exclusive and
 * interactive, and asking the operator to wait behind an agent would invert the whole point of
 * the feature. The requester is told to look elsewhere, not to wait.
 */
export function lendingBlocker(browsers: BrowserManager, row: BrowserRow, requesterId: string): string | null {
  if (row.owner_type !== "agent") return "browser is not owned by an agent";
  if (row.owner_id === requesterId) return "you already own this browser";
  if (browsers.controlState(row.id).controllerType === "human") return "a human is controlling this browser";
  return null;
}

/**
 * When this browser is likely to come free, in seconds, or null when that is genuinely not
 * knowable. Computed here rather than asked of the owner on purpose: an owner that is mid-task
 * guesses badly, and one that has crashed cannot answer at all. The owner can still override it
 * with a deny-plus-eta, which is the one number it really does know.
 */
export function etaSec(browsers: BrowserManager, row: BrowserRow): number | null {
  if (browsers.controlState(row.id).controllerType === "human") return null;
  if (!browsers.runtime(row.id)) return 0;
  if (!row.lendable) return null;
  const remaining = config.lendAutoGrantIdleMs - idleMs(row);
  return Math.max(0, Math.round(remaining / 1000));
}

function issueGrant(
  browsers: BrowserManager,
  row: BrowserRow,
  granteeId: string,
  grantedBy: string,
  reason: string | null,
): GrantRow {
  const id = randomBytes(8).toString("hex");
  const expires = new Date(Date.now() + config.lendGrantTtlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO browser_grants(id, browser_id, grantee_id, granted_by, reason, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(browser_id, grantee_id) DO UPDATE SET
         id = excluded.id, granted_by = excluded.granted_by, reason = excluded.reason,
         created_at = excluded.created_at, expires_at = excluded.expires_at, revoked_at = NULL`,
    )
    .run(id, row.id, granteeId, grantedBy, reason, nowIso(), expires);
  // A tunnel points this browser at the owner's own machine. Handing the browser to somebody
  // else must not hand that over with it -- and the borrower would inherit it silently, since
  // the binding is keyed on the browser and not on who is driving.
  dropTunnelsFor(row.id);
  audit({
    actorType: "agent",
    actorId: grantedBy,
    action: "browser.lent",
    targetType: "browser",
    targetId: row.id,
    detail: { grantee: granteeId, expiresAt: expires, reason },
  });
  hub.emitEvent("browser.lent", { grantee: granteeId, expiresAt: expires }, row.id);
  return activeGrant(row.id, granteeId)!;
}

export function revokeGrant(browsers: BrowserManager, browserId: string, granteeId: string, actor: Principal): void {
  const row = browsers.row(browserId);
  if (actor.type !== "admin" && row.owner_id !== actor.id) {
    throw Err.unauthorized("only the owner or the administrator can revoke a grant");
  }
  getDb()
    .prepare(`UPDATE browser_grants SET revoked_at = ? WHERE browser_id = ? AND grantee_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), browserId, granteeId);
  audit({
    actorType: actor.type,
    actorId: actor.id,
    action: "browser.lend.revoked",
    targetType: "browser",
    targetId: browserId,
    detail: { grantee: granteeId },
  });
  hub.emitEvent("browser.lend.revoked", { grantee: granteeId }, browserId);
}

export type RequestOutcome =
  | { state: "granted"; browserId: string; expiresAt: string; via: "existing" | "idle" | "answer" }
  | { state: "pending"; requestId: string; browserId: string; retryAfterSec: number; etaSec: number | null; expiresAt: string }
  | { state: "denied"; browserId: string; reason: string; etaSec: number | null }
  | { state: "unavailable"; browserId: string; reason: string };

/**
 * Ask for a browser owned by somebody else. Returns immediately, always.
 *
 * Deliberately never blocks waiting for a grant. Holding the tool call open would burn an MCP
 * request slot and an SSE stream for minutes and then hit each client's own tool timeout at
 * whatever number that client picked, which is a worse failure than being told to come back.
 */
export function requestBrowser(
  browsers: BrowserManager,
  principal: Principal,
  input: { browserId?: string; reason?: string; maxWaitSec?: number },
): RequestOutcome {
  if (principal.type === "agent" && !hasScope(principal, "browser:borrow")) {
    throw Err.unauthorized("missing scope browser:borrow");
  }
  // No browserId is "any of them": rank what is available and ask the single best candidate.
  const picked = input.browserId
    ? browsers.row(input.browserId)
    : candidates(browsers, principal)[0];
  if (!picked) {
    return { state: "unavailable", browserId: "", reason: "no browser is available to borrow right now" };
  }
  const row = picked;

  const existing = activeGrant(row.id, principal.id);
  if (existing) return { state: "granted", browserId: row.id, expiresAt: existing.expires_at, via: "existing" };

  const blocker = lendingBlocker(browsers, row, principal.id);
  if (blocker) return { state: "unavailable", browserId: row.id, reason: blocker };

  // An outstanding request is reused rather than duplicated, so an agent that asks on every
  // turn keeps one queue position instead of flooding the owner's inbox with its own retries.
  const mine = getDb()
    .prepare(
      `SELECT * FROM browser_requests WHERE browser_id = ? AND requester_id = ? AND state = 'pending' AND expires_at > ?`,
    )
    .get(row.id, principal.id, nowIso()) as RequestRow | undefined;

  const req =
    mine ??
    (() => {
      const id = randomBytes(8).toString("hex");
      const ttl = Math.min(
        Math.max((input.maxWaitSec ?? 0) * 1000 || config.lendRequestTtlMs, 30_000),
        config.lendRequestTtlMs,
      );
      getDb()
        .prepare(
          `INSERT INTO browser_requests(id, browser_id, requester_id, requester_name, reason, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, row.id, principal.id, principal.name ?? null, input.reason ?? null, nowIso(), new Date(Date.now() + ttl).toISOString());
      audit({
        actorType: principal.type,
        actorId: principal.id,
        action: "browser.requested",
        targetType: "browser",
        targetId: row.id,
        detail: { requestId: id, reason: input.reason ?? null },
      });
      hub.emitEvent("browser.requested", { requester: principal.id, requestId: id }, row.id);
      return request(id);
    })();

  // The idle rule, applied at ask time as well as on the sweep, so a request against a browser
  // that is already long idle is answered in the same call instead of a poll later.
  const granted = tryAutoGrant(browsers, row, req);
  if (granted) return { state: "granted", browserId: row.id, expiresAt: granted.expires_at, via: "idle" };

  return {
    state: "pending",
    requestId: req.id,
    browserId: row.id,
    retryAfterSec: config.lendPollSec,
    etaSec: req.eta_sec ?? etaSec(browsers, row),
    expiresAt: req.expires_at,
  };
}

/** The idle path. Returns the grant if this request could be settled without anyone answering. */
function tryAutoGrant(browsers: BrowserManager, row: BrowserRow, req: RequestRow): GrantRow | null {
  if (!row.lendable) return null;
  if (lendingBlocker(browsers, row, req.requester_id)) return null;
  // A running browser has to have gone quiet; a stopped one has by definition.
  if (browsers.runtime(row.id) && idleMs(row) < config.lendAutoGrantIdleMs) return null;
  const grant = issueGrant(browsers, row, req.requester_id, row.owner_id, req.reason);
  getDb()
    .prepare(`UPDATE browser_requests SET state = 'granted', decided_at = ?, decided_by = ? WHERE id = ?`)
    .run(nowIso(), "auto:idle", req.id);
  log.info("browser auto-lent after idle", { browserId: row.id, grantee: req.requester_id });
  return grant;
}

/** What is waiting on the browsers this principal owns. The owner's inbox. */
export function inbox(browsers: BrowserManager, principal: Principal): Array<RequestRow & { browserName: string }> {
  const owned =
    principal.type === "admin" ? browsers.list() : browsers.list({ ownerType: "agent", ownerId: principal.id });
  const out: Array<RequestRow & { browserName: string }> = [];
  for (const b of owned) for (const r of pendingFor(b.id)) out.push({ ...r, browserName: b.name });
  return out;
}

/** The requests this principal has made, and where each one got to. */
export function minePending(requesterId: string): Array<{
  requestId: string;
  browserId: string;
  state: RequestRow["state"];
  etaSec: number | null;
  expiresAt: string;
  decidedReason: string | null;
}> {
  return (
    getDb()
      .prepare(
        `SELECT * FROM browser_requests WHERE requester_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20`,
      )
      .all(requesterId, new Date(Date.now() - 24 * 3600_000).toISOString()) as RequestRow[]
  ).map((r) => ({
    requestId: r.id,
    browserId: r.browser_id,
    state: r.state,
    etaSec: r.eta_sec,
    expiresAt: r.expires_at,
    decidedReason: r.decided_reason,
  }));
}

/**
 * The browsers this principal could plausibly borrow, best first.
 *
 * Discovery is free and involves no agents at all -- it is one query over rows this process
 * already owns -- so "ask everyone" costs nothing here. What is NOT free is the answer: a
 * broadcast that lands three grants leaves the requester holding three Chromes, which is the
 * memory problem the fleet cap exists to prevent. So the fan-out is used to rank, and exactly
 * one candidate is asked. Longest-idle first, opted-in ahead of not, because that is the one
 * most likely to resolve without anybody having to answer.
 */
export function candidates(browsers: BrowserManager, principal: Principal): BrowserRow[] {
  return browsers
    .list()
    .filter((row) => !lendingBlocker(browsers, row, principal.id))
    .sort((a, b) => (b.lendable - a.lendable) || (idleMs(b) - idleMs(a)));
}

export function answerRequest(
  browsers: BrowserManager,
  principal: Principal,
  input: { requestId: string; decision: "grant" | "deny"; etaSec?: number; reason?: string },
): RequestRow {
  const req = request(input.requestId);
  const row = browsers.row(req.browser_id);
  if (principal.type !== "admin") {
    if (row.owner_id !== principal.id) throw Err.unauthorized("only the owner can answer this request");
    if (!hasScope(principal, "browser:lend")) throw Err.unauthorized("missing scope browser:lend");
  }
  if (req.state !== "pending") throw Err.conflict(`request is already ${req.state}`);

  if (input.decision === "grant") {
    const blocker = lendingBlocker(browsers, row, req.requester_id);
    if (blocker) throw Err.conflict(blocker);
    issueGrant(browsers, row, req.requester_id, principal.id, req.reason);
  }
  getDb()
    .prepare(
      `UPDATE browser_requests SET state = ?, decided_at = ?, decided_by = ?, eta_sec = ?, decided_reason = ?
       WHERE id = ?`,
    )
    .run(
      input.decision === "grant" ? "granted" : "denied",
      nowIso(),
      principal.id,
      input.etaSec ?? null,
      input.reason ?? null,
      req.id,
    );
  audit({
    actorType: principal.type,
    actorId: principal.id,
    action: input.decision === "grant" ? "browser.request.granted" : "browser.request.denied",
    targetType: "browser",
    targetId: row.id,
    detail: { requestId: req.id, requester: req.requester_id, etaSec: input.etaSec ?? null },
  });
  return request(req.id);
}

/** Withdraw a request you made. The polite half of giving up. */
export function withdrawRequest(principal: Principal, requestId: string): RequestRow {
  const req = request(requestId);
  if (principal.type !== "admin" && req.requester_id !== principal.id) {
    throw Err.unauthorized("that is not your request");
  }
  if (req.state === "pending") {
    getDb()
      .prepare(`UPDATE browser_requests SET state = 'withdrawn', decided_at = ?, decided_by = ? WHERE id = ?`)
      .run(nowIso(), principal.id, requestId);
  }
  return request(requestId);
}

/**
 * Time doing the work answers cannot. Runs on the same interval as the idle reaper: expires
 * stale requests and grants, and settles anything the idle rule now covers -- which is the path
 * that unblocks a requester whose owner has crashed and will never answer anything again.
 */
export function sweepLending(browsers: BrowserManager): void {
  const now = nowIso();
  const expired = getDb()
    .prepare(`UPDATE browser_requests SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at <= ?`)
    .run(now, now);
  if (expired.changes) log.info("expired browser requests", { count: Number(expired.changes) });

  for (const req of getDb()
    .prepare(`SELECT * FROM browser_requests WHERE state = 'pending' ORDER BY created_at`)
    .all() as RequestRow[]) {
    let row: BrowserRow;
    try {
      row = browsers.row(req.browser_id);
    } catch {
      // The browser was deleted out from under the queue.
      getDb()
        .prepare(`UPDATE browser_requests SET state = 'expired', decided_at = ? WHERE id = ?`)
        .run(now, req.id);
      continue;
    }
    tryAutoGrant(browsers, row, req);
  }
}
