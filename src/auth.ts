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
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export type Principal =
  | { type: "admin"; id: "admin"; name: "Administrator"; scopes: string[] }
  | { type: "agent"; id: string; name: string; scopes: string[]; maxBrowsers: number; enabled: boolean };

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
    .prepare(`SELECT id, name, scopes_json, max_browsers, enabled FROM agents WHERE id = ?`)
    .get(id) as
    | { id: string; name: string; scopes_json: string; max_browsers: number; enabled: number }
    | undefined;
  if (!row) return null;
  return {
    type: "agent",
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json) as string[],
    maxBrowsers: row.max_browsers,
    enabled: row.enabled === 1,
  };
}

export function listAgents() {
  return getDb()
    .prepare(
      `SELECT id, name, scopes_json, max_browsers, enabled, created_at, last_seen_at FROM agents ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    scopes_json: string;
    max_browsers: number;
    enabled: number;
    created_at: string;
    last_seen_at: string | null;
  }>;
}

export function createAgent(input: {
  name: string;
  scopes?: string[];
  maxBrowsers?: number;
}): { agent: Principal; token: string } {
  const id = `agt_${randomBytes(8).toString("hex")}`;
  const scopes = input.scopes?.length ? input.scopes : [...AGENT_SCOPES];
  for (const s of scopes) {
    if (!(AGENT_SCOPES as readonly string[]).includes(s)) throw Err.invalid(`unknown scope ${s}`);
  }
  getDb()
    .prepare(
      `INSERT INTO agents(id, name, scopes_json, max_browsers, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(id, input.name, JSON.stringify(scopes), input.maxBrowsers ?? 2, nowIso());
  const token = issueCredential("agent", id);
  audit({ actorType: "admin", actorId: "admin", action: "agent.created", targetType: "agent", targetId: id });
  return { agent: getAgent(id)!, token };
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
  audit({
    actorType: "admin",
    actorId: "admin",
    action: patch.enabled === false ? "agent.revoked" : "agent.updated",
    targetType: "agent",
    targetId: id,
  });
  return getAgent(id)!;
}

export function issueCredential(principalType: string, principalId: string): string {
  const token = newToken(principalType === "agent" ? "tl_ag" : "tl_br");
  getDb()
    .prepare(
      `INSERT INTO credentials(id, principal_type, principal_id, token_hash, token_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(cryptoRandomId(), principalType, principalId, sha256(token), token.slice(0, 10), nowIso());
  return token;
}

export function rotateAgentCredential(agentId: string): string {
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

export function authenticateBearer(token: string): Principal {
  if (!token) throw Err.unauthenticated();
  if (config.adminSecret && safeEqual(token, config.adminSecret)) return adminPrincipal();
  const row = getDb()
    .prepare(
      `SELECT principal_type, principal_id, revoked_at FROM credentials WHERE token_hash = ?`,
    )
    .get(sha256(token)) as
    | { principal_type: string; principal_id: string; revoked_at: string | null }
    | undefined;
  if (!row) throw Err.unauthenticated("invalid token");
  if (row.revoked_at) throw Err.credentialRevoked();
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
