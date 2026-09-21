import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { hasScope, type Principal } from "./auth.js";
import { rateLimit } from "./rate-limit.js";
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
 *
 * A browser the OPERATOR owns is the other half, and none of the reasoning above applies to it.
 * A person can be woken -- that is what the dashboard inbox is -- so there is no crashed-owner
 * problem to solve and no idle rule to solve it with. `tryAutoGrant` therefore refuses an
 * admin-owned browser outright: the only way one is ever handed over is an operator clicking
 * approve, and time can never do it for them.
 *
 * Two levels, not three. `read` admits binding and the non-mutating tools; `control` is
 * everything a borrower could ever do. There is no write-only level because an agent cannot
 * act on a page it cannot read, so the pair is already the whole lattice.
 */

/**
 * What a grant permits. `control` includes `read`; there is nothing in between, because an
 * agent that cannot read a page cannot usefully act on one either.
 */
export type GrantAccess = "read" | "control";

/**
 * "Until revoked", spelled as a date so that every `expires_at > now` comparison in this file
 * keeps working unchanged. Picked to sort after any real timestamp in ISO-8601, which is what
 * SQLite is actually comparing.
 */
export const NEVER_EXPIRES = "9999-12-31T23:59:59.999Z";

export const isPermanent = (expiresAt: string): boolean => expiresAt === NEVER_EXPIRES;

/** Narrow whatever the column holds to a level. Anything unrecognised reads as the safer one. */
export function grantAccess(row: { access?: string | null }): GrantAccess {
  return row.access === "control" ? "control" : row.access === "read" ? "read" : "control";
}

/** Does a grant at `held` satisfy a demand for `needed`? */
export const accessAllows = (held: GrantAccess, needed: GrantAccess): boolean =>
  held === "control" || needed === "read";

export type GrantRow = {
  id: string;
  browser_id: string;
  grantee_id: string;
  granted_by: string;
  reason: string | null;
  access: string;
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
  access: string;
  granted_access: string | null;
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
  // Every lending path runs through here: asking, the idle rule, answering and the candidate
  // list. A linked browser is somebody's own, signed in as them, so an agent that may use it
  // must not be able to pass it on. Its owner changes access in the dashboard, and only there.
  if (row.kind === "linked") {
    return "this is a person's own browser; only they can give an agent access, from the Tallylamp dashboard";
  }
  // An operator-owned managed browser IS askable, and this is the one place that had to change
  // for it. What makes it safe is not the blocker but everything downstream: the idle rule
  // refuses it, so the only way it is ever handed over is a person clicking approve.
  if (row.owner_type !== "agent" && row.owner_type !== "admin") return "browser is not owned by an agent";
  if (row.owner_id === requesterId) return "you already own this browser";
  if (browsers.controlState(row.id).controllerType === "human") return "a human is controlling this browser";
  return null;
}

/** Who has to answer a request for this browser: its owning agent, or the operator. */
export const answeredByAdmin = (row: BrowserRow): boolean => row.owner_type !== "agent";

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
  access: GrantAccess = "control",
  expiresAt?: string,
): GrantRow {
  const id = randomBytes(8).toString("hex");
  const expires = expiresAt ?? new Date(Date.now() + config.lendGrantTtlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO browser_grants(id, browser_id, grantee_id, granted_by, reason, access, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(browser_id, grantee_id) DO UPDATE SET
         id = excluded.id, granted_by = excluded.granted_by, reason = excluded.reason,
         access = excluded.access, created_at = excluded.created_at, expires_at = excluded.expires_at,
         revoked_at = NULL`,
    )
    .run(id, row.id, granteeId, grantedBy, reason, access, nowIso(), expires);
  // A tunnel points this browser at the owner's own machine. Handing the browser to somebody
  // else must not hand that over with it -- and the borrower would inherit it silently, since
  // the binding is keyed on the browser and not on who is driving.
  //
  // Only for a control grant. A reader cannot navigate, cannot script and cannot open or close
  // a tunnel -- every one of those tools is refused -- so there is nothing for it to inherit,
  // and tearing down the operator's own dev-server binding because somebody was allowed to
  // read one page would break the thing they were being shown.
  if (access === "control") dropTunnelsFor(row.id);
  audit({
    actorType: grantedBy === "admin" ? "admin" : "agent",
    actorId: grantedBy,
    action: "browser.lent",
    targetType: "browser",
    targetId: row.id,
    detail: { grantId: id, grantee: granteeId, access, expiresAt: expires, reason },
  });
  hub.emitEvent("browser.lent", { grantee: granteeId, access, expiresAt: expires }, row.id);
  return activeGrant(row.id, granteeId)!;
}

export function revokeGrant(browsers: BrowserManager, browserId: string, granteeId: string, actor: Principal): void {
  const row = browsers.row(browserId);
  if (actor.type !== "admin" && row.owner_id !== actor.id) {
    throw Err.unauthorized("only the owner or the administrator can revoke a grant");
  }
  const had = activeGrant(browserId, granteeId);
  getDb()
    .prepare(`UPDATE browser_grants SET revoked_at = ? WHERE browser_id = ? AND grantee_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), browserId, granteeId);
  audit({
    actorType: actor.type,
    actorId: actor.id,
    action: "browser.lend.revoked",
    targetType: "browser",
    targetId: browserId,
    detail: { grantId: had?.id ?? null, grantee: granteeId, access: had ? grantAccess(had) : null },
  });
  hub.emitEvent("browser.lend.revoked", { grantee: granteeId }, browserId);
}

export type RequestOutcome =
  | {
      state: "granted";
      browserId: string;
      access: GrantAccess;
      expiresAt: string | null;
      via: "existing" | "idle" | "answer";
    }
  | {
      state: "pending";
      requestId: string;
      browserId: string;
      access: GrantAccess;
      answeredBy: "owner" | "administrator";
      retryAfterSec: number;
      etaSec: number | null;
      expiresAt: string;
    }
  | { state: "denied"; browserId: string; reason: string; etaSec: number | null }
  | { state: "unavailable"; browserId: string; reason: string };

/**
 * The level a caller that did not name one gets, which depends on who owns the browser.
 *
 * Agent-to-agent lending predates the level and has exactly one meaning: hand it over so I can
 * drive it. Defaulting those callers to `read` would silently break every one of them, so they
 * keep `control`.
 *
 * An operator-owned browser is new ground with no callers to keep, and it is the case where the
 * asymmetry actually bites -- it is signed in as a person, by that person. So the default there
 * is the level that cannot do anything: `read`. An agent that wants more has to say so, which
 * also means the operator sees it asked for more.
 */
export const defaultAccessFor = (row: BrowserRow): GrantAccess => (answeredByAdmin(row) ? "read" : "control");

/**
 * How many requests this agent already has in flight, fleet-wide.
 *
 * Bounded per agent rather than per browser: the inbox an operator reads is one list, so an
 * agent that spread thirty requests across thirty browsers would flood it just as effectively
 * as thirty against one.
 */
export function pendingCountFor(requesterId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM browser_requests WHERE requester_id = ? AND state = 'pending' AND expires_at > ?`)
    .get(requesterId, nowIso()) as { n: number };
  return Number(row?.n ?? 0);
}

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
  input: { browserId?: string; reason?: string; maxWaitSec?: number; access?: GrantAccess },
): RequestOutcome {
  // No browserId is "any of them": rank what is available and ask the single best candidate.
  const picked = input.browserId
    ? browsers.row(input.browserId)
    : candidates(browsers, principal)[0];
  if (!picked) {
    return { state: "unavailable", browserId: "", reason: "no browser is available to borrow right now" };
  }
  const row = picked;
  const want: GrantAccess = input.access ?? defaultAccessFor(row);

  // The scope gate stays exactly where it was for agent-to-agent lending: borrowing a peer's
  // profile is a live credential transfer and `browser:borrow` is the opt-in for it.
  //
  // It does NOT gate asking the operator. A scope the operator has to add before an agent can
  // even ask makes the request flow unreachable by precisely the agent that needs it -- the
  // operator would have to be asked, out of band, for permission to ask. Asking grants nothing,
  // so what bounds it below is a rate and a cap, not a privilege.
  if (principal.type === "agent" && !answeredByAdmin(row) && !hasScope(principal, "browser:borrow")) {
    throw Err.unauthorized("missing scope browser:borrow");
  }

  // A grant already in hand short-circuits -- but only if it is at least the level being asked
  // for. A reader asking for control is making a genuinely new request, and returning its
  // existing read grant instead would leave it looping on an answer it can never get.
  const existing = activeGrant(row.id, principal.id);
  if (existing && accessAllows(grantAccess(existing), want)) {
    return {
      state: "granted",
      browserId: row.id,
      access: grantAccess(existing),
      expiresAt: isPermanent(existing.expires_at) ? null : existing.expires_at,
      via: "existing",
    };
  }

  const blocker = lendingBlocker(browsers, row, principal.id);
  if (blocker) return { state: "unavailable", browserId: row.id, reason: blocker };

  // An outstanding request is reused rather than duplicated, so an agent that asks on every
  // turn keeps one queue position instead of flooding the owner's inbox with its own retries.
  // Keyed on the level too: a held read grant plus a pending control request are two separate
  // things and the upgrade must not be swallowed by the row that won the read.
  const mine = getDb()
    .prepare(
      `SELECT * FROM browser_requests
       WHERE browser_id = ? AND requester_id = ? AND access = ? AND state = 'pending' AND expires_at > ?`,
    )
    .get(row.id, principal.id, want, nowIso()) as RequestRow | undefined;

  const req =
    mine ??
    (() => {
      // Charged only when a row is actually created. A retry that keeps its place in the queue
      // costs nothing, which is what the tool's own description promises, and means a polite
      // client polling on schedule can never throttle itself out of its own pending request.
      assertMayAsk(principal);
      const id = randomBytes(8).toString("hex");
      const ttl = Math.min(
        Math.max((input.maxWaitSec ?? 0) * 1000 || config.lendRequestTtlMs, 30_000),
        config.lendRequestTtlMs,
      );
      getDb()
        .prepare(
          `INSERT INTO browser_requests(id, browser_id, requester_id, requester_name, reason, access, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, row.id, principal.id, principal.name ?? null, input.reason ?? null, want, nowIso(), new Date(Date.now() + ttl).toISOString());
      audit({
        actorType: principal.type,
        actorId: principal.id,
        action: "browser.requested",
        targetType: "browser",
        targetId: row.id,
        detail: { requestId: id, access: want, reason: input.reason ?? null },
      });
      hub.emitEvent("browser.requested", { requester: principal.id, requestId: id, access: want }, row.id);
      return request(id);
    })();

  // The idle rule, applied at ask time as well as on the sweep, so a request against a browser
  // that is already long idle is answered in the same call instead of a poll later.
  const granted = tryAutoGrant(browsers, row, req);
  if (granted) {
    return {
      state: "granted",
      browserId: row.id,
      access: grantAccess(granted),
      expiresAt: isPermanent(granted.expires_at) ? null : granted.expires_at,
      via: "idle",
    };
  }

  return {
    state: "pending",
    requestId: req.id,
    browserId: row.id,
    access: want,
    answeredBy: answeredByAdmin(row) ? "administrator" : "owner",
    retryAfterSec: config.lendPollSec,
    etaSec: req.eta_sec ?? etaSec(browsers, row),
    expiresAt: req.expires_at,
  };
}

/**
 * The two bounds on asking, both of which exist because the thing on the other end of an
 * operator-answered request is a person with an inbox.
 *
 * Neither is retryable. A retryable throttle is an instruction to a daemon to come straight
 * back, which is the behaviour being bounded; the message carries the way out instead.
 */
function assertMayAsk(principal: Principal): void {
  if (principal.type !== "agent") return;
  const pending = pendingCountFor(principal.id);
  if (pending >= config.lendMaxPendingPerAgent) {
    throw Err.lendThrottled(
      `you already have ${pending} browser requests waiting to be answered, which is the limit ` +
        `(${config.lendMaxPendingPerAgent}). Do not ask again for a different browser: wait for one of ` +
        `these to be answered or to expire, withdraw one, or use a browser you own.`,
    );
  }
  try {
    rateLimit(`lend-request:${principal.id}`, config.lendRequestsPerMin, config.lendRequestBurst);
  } catch {
    throw Err.lendThrottled(
      `you are filing browser requests too quickly (limit ${config.lendRequestsPerMin}/min). ` +
        `Wait at least 60 seconds before asking for a browser again. Asking repeatedly does not ` +
        `move you up the queue -- a request you have already made keeps its place.`,
    );
  }
}

/** The idle path. Returns the grant if this request could be settled without anyone answering. */
function tryAutoGrant(browsers: BrowserManager, row: BrowserRow, req: RequestRow): GrantRow | null {
  // Never for a browser the operator owns, at either level. The idle rule exists to answer for
  // an owner that cannot answer for itself; a person always can, and "they have not touched it
  // for two minutes" is not consent from someone who is merely away from the keyboard.
  if (answeredByAdmin(row)) return null;
  if (!row.lendable) return null;
  if (lendingBlocker(browsers, row, req.requester_id)) return null;
  // A running browser has to have gone quiet; a stopped one has by definition.
  if (browsers.runtime(row.id) && idleMs(row) < config.lendAutoGrantIdleMs) return null;
  const access = grantAccess(req);
  const grant = issueGrant(browsers, row, req.requester_id, row.owner_id, req.reason, access);
  getDb()
    .prepare(
      `UPDATE browser_requests SET state = 'granted', granted_access = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
    )
    .run(access, nowIso(), "auto:idle", req.id);
  log.info("browser auto-lent after idle", { browserId: row.id, grantee: req.requester_id, access });
  return grant;
}

/**
 * What is waiting on the browsers this principal owns. The owner's inbox -- and, for the
 * administrator, the only place a request against their own browser is ever seen.
 *
 * An agent owner is told about its requests on the back of its next tool call, because that is
 * the one moment an agent is reachable. A person is not reachable that way at all, so for the
 * operator this list, polled by the dashboard, IS the notification.
 */
export function inbox(
  browsers: BrowserManager,
  principal: Principal,
): Array<RequestRow & { browserName: string; browserOwnerType: string }> {
  const owned =
    principal.type === "admin" ? browsers.list() : browsers.list({ ownerType: "agent", ownerId: principal.id });
  const out: Array<RequestRow & { browserName: string; browserOwnerType: string }> = [];
  for (const b of owned) {
    for (const r of pendingFor(b.id)) out.push({ ...r, browserName: b.name, browserOwnerType: b.owner_type });
  }
  return out;
}

/** The requests this principal has made, and where each one got to. */
export function minePending(requesterId: string): Array<{
  requestId: string;
  browserId: string;
  state: RequestRow["state"];
  requestedAccess: GrantAccess;
  grantedAccess: GrantAccess | null;
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
    requestedAccess: grantAccess(r),
    // What the answer actually gave, which is how a requester learns it was approved at a
    // lower level than it asked for rather than simply granted.
    grantedAccess: r.granted_access ? grantAccess({ access: r.granted_access }) : null,
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
    // An operator-owned browser can be asked for, but never *found* this way. Ranking one here
    // would put "I need any browser" -- a want an agent can satisfy by creating its own -- in
    // front of a person, and nothing in that queue resolves without them. Naming it is the
    // signal that this browser in particular is the point.
    .filter((row) => row.owner_type === "agent")
    .filter((row) => !lendingBlocker(browsers, row, principal.id))
    .sort((a, b) => (b.lendable - a.lendable) || (idleMs(b) - idleMs(a)));
}

export function answerRequest(
  browsers: BrowserManager,
  principal: Principal,
  input: {
    requestId: string;
    decision: "grant" | "deny";
    etaSec?: number;
    reason?: string;
    /** Approve at this level instead of the one asked for. Only ever downward. */
    access?: GrantAccess;
    /** How long the grant lasts. Omit both for the server default. */
    durationSec?: number;
    untilRevoked?: boolean;
  },
): RequestRow {
  const req = request(input.requestId);
  const row = browsers.row(req.browser_id);
  if (principal.type !== "admin") {
    // An operator-owned browser has no owning agent to answer for it, and `owner_id` is the
    // literal string 'admin', which no agent id can equal -- so this already refuses every
    // agent for exactly the right reason. Said out loud because it is load-bearing.
    if (answeredByAdmin(row)) throw Err.unauthorized("only the administrator can answer a request for this browser");
    if (row.owner_id !== principal.id) throw Err.unauthorized("only the owner can answer this request");
    if (!hasScope(principal, "browser:lend")) throw Err.unauthorized("missing scope browser:lend");
  }
  if (req.state !== "pending") throw Err.conflict(`request is already ${req.state}`);

  const asked = grantAccess(req);
  // Never upward. An answer is permission to give what was asked for or less; handing an agent
  // control it did not ask for is a decision nobody made, least of all the requester, whose
  // client may well refuse to use it.
  const granted: GrantAccess = input.decision === "grant"
    ? (input.access && !accessAllows(asked, input.access) ? asked : input.access ?? asked)
    : asked;

  if (input.decision === "grant") {
    const blocker = lendingBlocker(browsers, row, req.requester_id);
    if (blocker) throw Err.conflict(blocker);
    issueGrant(browsers, row, req.requester_id, principal.id, req.reason, granted, grantExpiry(input));
  }
  getDb()
    .prepare(
      `UPDATE browser_requests SET state = ?, granted_access = ?, decided_at = ?, decided_by = ?, eta_sec = ?, decided_reason = ?
       WHERE id = ?`,
    )
    .run(
      input.decision === "grant" ? "granted" : "denied",
      input.decision === "grant" ? granted : null,
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
    detail: {
      requestId: req.id,
      requester: req.requester_id,
      requestedAccess: asked,
      grantedAccess: input.decision === "grant" ? granted : null,
      etaSec: input.etaSec ?? null,
    },
  });
  return request(req.id);
}

/**
 * When a grant an operator just approved should lapse.
 *
 * "Until revoked" is a real answer and not a loophole: the daemon this was built for
 * re-initialises after every idle reap and every restart, so a grant measured in hours is a
 * grant that fails overnight and wakes somebody up. What keeps it safe is that it is visible
 * and revocable at any moment, not that it expires on a timer nobody chose.
 */
function grantExpiry(input: { durationSec?: number; untilRevoked?: boolean }): string | undefined {
  if (input.untilRevoked) return NEVER_EXPIRES;
  if (typeof input.durationSec !== "number" || !Number.isFinite(input.durationSec)) return undefined;
  const sec = Math.min(Math.max(Math.round(input.durationSec), 60), config.lendMaxGrantSec);
  return new Date(Date.now() + sec * 1000).toISOString();
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
