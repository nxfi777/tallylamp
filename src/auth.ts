import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { audit } from "./audit.js";

export const AGENT_SCOPES = [
  "browser:create",
  "browser:list:own",
  "browser:read:own",
  "browser:start:own",
  "browser:stop:own",
  "browser:delete:own",
  "browser:control:own",
  "seed:use",
  "seed:write",
  "browser:lend",
  "browser:borrow",
  "browser:tunnel",
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * What an agent gets when no scopes are named. Deliberately NOT all of AGENT_SCOPES.
 *
 * A seed is a whole authenticated Chrome profile: cloning one hands the caller every login
 * inside it. Creating a seed is administrator-only, but consuming one used to require nothing
 * beyond `browser:create`, so any agent that ever learned a seed id inherited its logins for
 * good. Seed ids are not secrets -- they ride in create calls, audit rows and dashboards.
 * Granting this only on request keeps the blast radius of a leaked agent token to the browsers
 * that token created.
 * `seed:write` is a separate opt-in: it publishes every login from an owned
 * browser and permits overwriting its linked shared snapshot for future copies.
 * Merely loading or borrowing a profile never grants that write permission.
 *
 * `browser:lend` and `browser:borrow` are held out for the same reason, and it is the stronger
 * case: lending hands over a *live* profile rather than a copy of one, so the borrower gets
 * every session cookie in it, still logged in. Without these two an agent cannot lend, cannot
 * borrow, and cannot be talked into either -- which keeps the clean 403 that ownership gives
 * today as the default answer for one agent asking after another's browser.
 *
 * `browser:tunnel` is held out on the reverse argument: it does not hand this browser to
 * anyone, it points this browser at a private address on the machine that asked -- typically
 * the operator's own laptop. The egress proxy exists to refuse exactly that, so the ability
 * to punch one hole through it belongs to a principal that was deliberately given it, not to
 * every agent that happens to hold a token.
 */
export const DEFAULT_AGENT_SCOPES = AGENT_SCOPES.filter(
  (s) => s !== "seed:use" && s !== "seed:write" && s !== "browser:lend" && s !== "browser:borrow" && s !== "browser:tunnel",
);

export type Principal =
  | { type: "admin"; id: "admin"; name: "Administrator"; scopes: string[] }
  | { type: "agent"; id: string; name: string; scopes: string[]; maxBrowsers: number; enabled: boolean; labels: Record<string, string> };

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function verifyAdminSecret(secret: string): boolean {
  if (!config.adminSecret) return false;
  return safeEqual(secret, config.adminSecret);
}

export function createAdminSession(): { token: string; expiresAt: string } {
  const token = newToken("tl_sess");
  const expires = new Date(Date.now() + config.sessionTtlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions(id, principal_type, principal_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?, 'admin', 'admin', ?, ?, ?, ?)`,
    )
    .run(cryptoRandomId(), sha256(token), nowIso(), expires, nowIso());
  audit({ actorType: "admin", actorId: "admin", action: "admin.login" });
  return { token, expiresAt: expires };
}

function cryptoRandomId(): string {
  return randomBytes(16).toString("hex");
}

export function destroySession(token: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
  audit({ actorType: "admin", actorId: "admin", action: "admin.logout" });
}

export function readSession(token: string): Principal | null {
  const row = getDb()
    .prepare(
      `SELECT principal_type, principal_id, expires_at FROM sessions WHERE token_hash = ?`,
    )
    .get(sha256(token)) as { principal_type: string; principal_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
    return null;
  }
  getDb().prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(nowIso(), sha256(token));
  if (row.principal_type === "admin") return adminPrincipal();
  return getAgent(row.principal_id);
}

export function adminPrincipal(): Principal {
  return {
    type: "admin",
    id: "admin",
    name: "Administrator",
    scopes: ["*"],
  };
}

export function getAgent(id: string): Principal | null {
  const row = getDb()
    .prepare(`SELECT id, name, scopes_json, max_browsers, enabled, labels_json FROM agents WHERE id = ?`)
    .get(id) as
    | { id: string; name: string; scopes_json: string; max_browsers: number; enabled: number; labels_json: string }
    | undefined;
  if (!row) return null;
  return {
    type: "agent",
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json) as string[],
    maxBrowsers: row.max_browsers,
    enabled: row.enabled === 1,
    labels: parseLabels(row.labels_json),
  };
}

function parseLabels(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function listAgents() {
  return getDb()
    .prepare(
      `SELECT id, name, scopes_json, max_browsers, enabled, created_at, last_seen_at, labels_json FROM agents ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    scopes_json: string;
    max_browsers: number;
    enabled: number;
    created_at: string;
    last_seen_at: string | null;
    labels_json: string;
  }>;
}

export function createAgent(input: {
  name: string;
  scopes?: string[];
  maxBrowsers?: number;
  labels?: Record<string, string>;
}): { agent: Principal; token: string } {
  const id = `agt_${randomBytes(8).toString("hex")}`;
  const scopes = input.scopes?.length ? input.scopes : [...DEFAULT_AGENT_SCOPES];
  for (const s of scopes) {
    if (!(AGENT_SCOPES as readonly string[]).includes(s)) throw Err.invalid(`unknown scope ${s}`);
  }
  getDb()
    .prepare(
      `INSERT INTO agents(id, name, scopes_json, max_browsers, enabled, created_at, labels_json) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, input.name, JSON.stringify(scopes), input.maxBrowsers ?? 2, nowIso(), JSON.stringify(input.labels ?? {}));
  const token = issueCredential("agent", id);
  audit({ actorType: "admin", actorId: "admin", action: "agent.created", targetType: "agent", targetId: id });
  return { agent: getAgent(id)!, token };
}

/**
 * An agent principal that exists only as the identity of an OAuth connector. It gets no
 * dashboard bearer token: its only credentials are the access/refresh pair from the grant,
 * so revoking the agent revokes the connector and nothing else.
 */
export function createConnectorAgent(input: {
  name: string;
  scopes?: string[];
  maxBrowsers?: number;
  labels?: Record<string, string>;
}): Principal {
  const id = `agt_${randomBytes(8).toString("hex")}`;
  const scopes = input.scopes?.length ? input.scopes : [...DEFAULT_AGENT_SCOPES];
  for (const scope of scopes) {
    if (!(AGENT_SCOPES as readonly string[]).includes(scope)) throw Err.invalid(`unknown scope ${scope}`);
  }
  getDb()
    .prepare(
      `INSERT INTO agents(id, name, scopes_json, max_browsers, enabled, created_at, labels_json) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, input.name, JSON.stringify(scopes), input.maxBrowsers ?? config.oauthMaxBrowsers, nowIso(), JSON.stringify(input.labels ?? {}));
  audit({ actorType: "admin", actorId: "admin", action: "connector.created", targetType: "agent", targetId: id });
  return getAgent(id)!;
}

export function updateAgent(
  id: string,
  patch: { name?: string; scopes?: string[]; maxBrowsers?: number; enabled?: boolean },
): Principal {
  const existing = getAgent(id);
  if (!existing || existing.type !== "agent") throw Err.notFound("agent not found");
  const name = patch.name ?? existing.name;
  const scopes = patch.scopes ?? existing.scopes;
  const maxBrowsers = patch.maxBrowsers ?? existing.maxBrowsers;
  const enabled = patch.enabled ?? existing.enabled;
  getDb()
    .prepare(`UPDATE agents SET name = ?, scopes_json = ?, max_browsers = ?, enabled = ? WHERE id = ?`)
    .run(name, JSON.stringify(scopes), maxBrowsers, enabled ? 1 : 0, id);
  if (patch.enabled === false) {
    // Disabling alone only blocks authentication while the row says so; re-enabling would
    // silently reactivate a stolen token. Revoke the credentials outright.
    getDb()
      .prepare(`UPDATE credentials SET revoked_at = ? WHERE principal_type = 'agent' AND principal_id = ? AND revoked_at IS NULL`)
      .run(nowIso(), id);
  }
  audit({
    actorType: "admin",
    actorId: "admin",
    action: patch.enabled === false ? "agent.revoked" : "agent.updated",
    targetType: "agent",
    targetId: id,
  });
  return getAgent(id)!;
}

export type CredentialKind = "access" | "refresh";

export function issueCredential(
  principalType: string,
  principalId: string,
  opts?: {
    prefix?: string;
    expiresAt?: string;
    /** RFC 8707 audience. Non-null credentials are only accepted at that exact resource. */
    audience?: string | null;
    kind?: CredentialKind;
    clientId?: string | null;
    grantId?: string | null;
  },
): string {
  const token = newToken(opts?.prefix ?? (principalType === "agent" ? "tl_ag" : "tl_br"));
  getDb()
    .prepare(
      `INSERT INTO credentials(id, principal_type, principal_id, token_hash, token_prefix, created_at, expires_at, kind, audience, client_id, grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cryptoRandomId(),
      principalType,
      principalId,
      sha256(token),
      token.slice(0, 10),
      nowIso(),
      opts?.expiresAt ?? null,
      opts?.kind ?? "access",
      opts?.audience ?? null,
      opts?.clientId ?? null,
      opts?.grantId ?? null,
    );
  return token;
}

export type CredentialRow = {
  id: string;
  principal_type: string;
  principal_id: string;
  revoked_at: string | null;
  expires_at: string | null;
  kind: string;
  audience: string | null;
  client_id: string | null;
  grant_id: string | null;
};

export function lookupCredential(token: string): CredentialRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, principal_type, principal_id, revoked_at, expires_at, kind, audience, client_id, grant_id
       FROM credentials WHERE token_hash = ?`,
    )
    .get(sha256(token)) as CredentialRow | undefined;
}

export function revokeCredential(token: string): void {
  getDb().prepare(`UPDATE credentials SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(nowIso(), sha256(token));
}

/**
 * Revoke every credential minted by one OAuth approval. Used both by explicit revocation
 * and by refresh-token reuse detection, where a replayed refresh token means the family
 * is assumed stolen.
 */
export function revokeGrant(grantId: string): number {
  const res = getDb()
    .prepare(`UPDATE credentials SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), grantId);
  return Number(res.changes ?? 0);
}

export function listGrants(): Array<{
  grant_id: string;
  principal_id: string;
  client_id: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: number;
}> {
  return getDb()
    .prepare(
      `SELECT grant_id, principal_id, client_id, MIN(created_at) AS created_at, MAX(expires_at) AS expires_at,
              MAX(last_used_at) AS last_used_at, MIN(CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END) AS revoked
       FROM credentials WHERE grant_id IS NOT NULL GROUP BY grant_id ORDER BY created_at DESC`,
    )
    .all() as never;
}

/** Drop rows that can no longer authenticate anything. Cheap; run at boot. */
export function pruneExpiredCredentials(): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM viewer_tickets WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM credentials WHERE expires_at IS NOT NULL AND expires_at < ?`).run(now);
  // Dynamic client registrations are unauthenticated, so bound them: drop any that never
  // produced a grant and are older than 30 days.
  db.prepare(
    `DELETE FROM oauth_clients WHERE agent_id IS NULL AND created_at < ?`,
  ).run(new Date(Date.now() - 30 * 86400_000).toISOString());
}

/**
 * Rotating ADMIN_SECRET must invalidate everything the old secret authorised, otherwise a
 * connector token outlives the credential that approved it.
 */
export function enforceAdminSecretRotation(): void {
  if (!config.adminSecret) return;
  const db = getDb();
  const current = sha256(config.adminSecret);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'admin_secret_hash'`).get() as { value: string } | undefined;
  if (row?.value === current) return;
  if (row) {
    db.prepare(`DELETE FROM sessions`).run();
    const res = db.prepare(`UPDATE credentials SET revoked_at = ? WHERE grant_id IS NOT NULL AND revoked_at IS NULL`).run(nowIso());
    audit({
      actorType: "admin",
      actorId: "admin",
      action: "admin.secret_rotated",
      detail: { revokedGrantCredentials: Number(res.changes ?? 0) },
    });
  }
  db.prepare(`INSERT INTO meta(key, value) VALUES ('admin_secret_hash', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(current);
}

export function rotateAgentCredential(agentId: string): string {
  const agent = getAgent(agentId);
  if (!agent || agent.type !== "agent") throw Err.notFound("agent not found");
  if (agent.labels.kind === "connector") {
    throw Err.invalid("connector credentials come from the OAuth grant; revoke it and reconnect instead");
  }
  getDb()
    .prepare(`UPDATE credentials SET revoked_at = ? WHERE principal_type = 'agent' AND principal_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), agentId);
  const token = issueCredential("agent", agentId);
  audit({ actorType: "admin", actorId: "admin", action: "credential.rotated", targetType: "agent", targetId: agentId });
  return token;
}

export function revokeAgent(agentId: string): void {
  updateAgent(agentId, { enabled: false });
  getDb()
    .prepare(`UPDATE credentials SET revoked_at = ? WHERE principal_type = 'agent' AND principal_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), agentId);
}

/**
 * Authenticate a bearer token for a specific resource.
 *
 * `expectedAudience` is the resource the caller is guarding. A credential carrying a
 * non-null audience is only valid at that exact resource, so an OAuth connector token
 * minted for `<publicUrl>/mcp` is rejected everywhere else, including the control API.
 * Dashboard-issued agent tokens have a null audience and stay valid everywhere, which is
 * what keeps the static-bearer path working unchanged.
 */
export function authenticateBearer(token: string, expectedAudience: string | null = null): Principal {
  if (!token) throw Err.unauthenticated();
  // ADMIN_SECRET-as-bearer is a brute-forceable master key; off unless explicitly enabled.
  if (config.adminBearer && config.adminSecret && safeEqual(token, config.adminSecret)) return adminPrincipal();
  const row = lookupCredential(token);
  if (!row) throw Err.unauthenticated("invalid token");
  if (row.kind !== "access") throw Err.unauthenticated("invalid token");
  if (row.revoked_at) throw Err.credentialRevoked();
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) throw Err.credentialRevoked("token expired");
  if (row.audience !== null && row.audience !== expectedAudience) {
    throw Err.unauthorized("token was not issued for this resource");
  }
  getDb().prepare(`UPDATE credentials SET last_used_at = ? WHERE token_hash = ?`).run(nowIso(), sha256(token));
  if (row.principal_type === "admin") return adminPrincipal();
  const agent = getAgent(row.principal_id);
  if (!agent || agent.type !== "agent") throw Err.unauthenticated();
  if (!agent.enabled) throw Err.credentialRevoked("agent disabled");
  getDb().prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(nowIso(), agent.id);
  return agent;
}

export function hasScope(p: Principal, scope: string): boolean {
  if (p.type === "admin") return true;
  return p.scopes.includes(scope) || p.scopes.includes("*");
}

export function requireScope(p: Principal, scope: string): void {
  if (!hasScope(p, scope)) throw Err.unauthorized(`missing scope ${scope}`);
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/** Unused scrypt helper kept for future secret stretching of the admin secret. */
export function stretch(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}
