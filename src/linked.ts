import { EventEmitter } from "node:events";
import { randomBytes, randomInt } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { rateLimit } from "./rate-limit.js";
import { onUpgrade } from "./upgrades.js";
import { getAgent, newToken, sha256, type Principal } from "./auth.js";
import type { BrowserManager } from "./browsers.js";
import type { LinkPeer, LinkedTab, TargetInfo } from "./linked-cdp.js";

/**
 * Linked browsers: a person's own Chromium, driven through the Tallylamp extension.
 *
 * A managed browser is a Chrome this process launched, so reaching it is a loopback port.
 * A linked browser is on somebody's laptop behind NAT, so the extension dials OUT to here
 * and the server speaks down that socket -- the same direction trick the tunnels use, and
 * for the same reason.
 *
 * The extension is deliberately a dumb pipe. It can run a short list of calls (`cdp`,
 * `tabs.create`, `tabs.close`, `tabs.activate`, `window.get`) against tabs the person has
 * shared, and it reports what happens. All the CDP fakery lives in linked-cdp.ts. What it
 * is NOT dumb about is scope: which tabs are shared, and which CDP methods would reach past
 * a shared tab into the rest of the profile, are enforced in the extension. This server is
 * the party being constrained, so it cannot also be the one doing the constraining.
 *
 * Pairing is a device flow (RFC 8628 in shape). The extension asks for a pairing and gets a
 * device secret it keeps plus a short code it shows. A signed-in admin approves the code in
 * the dashboard and names the agent that may drive the browser. The extension, polling with
 * its secret, then collects a `tl_ln_` token exactly once. Nobody pastes a secret anywhere,
 * and the code on its own opens nothing.
 */

const PAIRING_TTL_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 10_000;
// The extension pings every 20s, which is also what keeps its service worker alive. Three
// missed pings is a dead socket the TCP stack has not admitted to yet.
const SILENCE_LIMIT_MS = 70_000;
// No I, O, 0 or 1: the code is read off one screen and compared by eye against another.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type LinkRow = {
  id: string;
  browser_id: string;
  token_hash: string | null;
  device_name: string;
  user_agent: string | null;
  approved_by_type: string;
  approved_by_id: string;
  created_at: string;
  connected_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
};

type PairingRow = {
  id: string;
  user_code: string;
  device_hash: string;
  device_name: string;
  user_agent: string | null;
  remote_addr: string | null;
  state: "pending" | "approved" | "denied" | "claimed";
  link_id: string | null;
  created_at: string;
  expires_at: string;
};

const connections = new Map<string, LinkConnection>();

const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** "abcd2345", "ABCD 2345" and "abcd-2345" are all the same code to the person typing it. */
export function normalizeUserCode(raw: string): string {
  const flat = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return flat.length === 8 ? `${flat.slice(0, 4)}-${flat.slice(4)}` : flat;
}

function newUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function startPairing(input: { deviceName?: unknown; userAgent?: unknown; remoteAddr?: string }): {
  deviceCode: string;
  userCode: string;
  expiresInSec: number;
  pollEverySec: number;
} {
  const deviceCode = newToken("tl_pd");
  const userCode = newUserCode();
  getDb()
    .prepare(
      `INSERT INTO link_pairings(id, user_code, device_hash, device_name, user_agent, remote_addr, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomBytes(8).toString("hex"),
      userCode,
      sha256(deviceCode),
      clip(input.deviceName, 60).trim() || "A browser",
      clip(input.userAgent, 300) || null,
      input.remoteAddr ?? null,
      nowIso(),
      new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    );
  return { deviceCode, userCode, expiresInSec: PAIRING_TTL_MS / 1000, pollEverySec: 2 };
}

function livePairing(where: "user_code" | "device_hash", value: string): PairingRow | undefined {
  const row = getDb().prepare(`SELECT * FROM link_pairings WHERE ${where} = ?`).get(value) as PairingRow | undefined;
  if (!row || Date.parse(row.expires_at) <= Date.now()) return undefined;
  return row;
}

/** What the approval page shows before anybody decides anything. */
export function describePairing(userCode: string) {
  const row = livePairing("user_code", normalizeUserCode(userCode));
  if (!row) throw Err.notFound("that code is not waiting for approval; it may have expired. Start again from the extension.");
  return {
    userCode: row.user_code,
    deviceName: row.device_name,
    userAgent: row.user_agent,
    remoteAddr: row.remote_addr,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export type LinkedAccess = { anyAgent: boolean; agentIds: string[] };

/** Who may use a linked browser besides the administrator. */
export function linkedAccess(browserId: string): LinkedAccess {
  const ids = (getDb().prepare(`SELECT agent_id FROM linked_access WHERE browser_id = ? ORDER BY created_at`).all(browserId) as Array<{ agent_id: string }>)
    .map((r) => r.agent_id);
  return { anyAgent: ids.includes("*"), agentIds: ids.filter((id) => id !== "*") };
}

export function linkedAllows(browserId: string, agentId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM linked_access WHERE browser_id = ? AND agent_id IN (?, '*')`).get(browserId, agentId));
}

/**
 * Checked before anything is written, so a typo in one id cannot leave a half-applied list.
 * A disabled agent is refused rather than silently kept: it cannot sign in, so ticking it
 * would look like access that does nothing.
 */
function checkAgents(ids: string[]): string[] {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  for (const id of unique) {
    const agent = getAgent(id);
    if (!agent) throw Err.notFound(`agent ${id} not found`);
    if (agent.type === "agent" && !agent.enabled) throw Err.invalid(`${agent.name} is disabled; enable it on the Agents page first`);
  }
  return unique;
}

function writeAccess(browserId: string, access: LinkedAccess): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`DELETE FROM linked_access WHERE browser_id = ?`).run(browserId);
    const insert = db.prepare(`INSERT INTO linked_access(browser_id, agent_id, created_at) VALUES (?, ?, ?)`);
    for (const id of access.anyAgent ? ["*"] : access.agentIds) insert.run(browserId, id, nowIso());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Replace the list. Every MCP session on the browser is dropped afterwards. Each agent's next
 * call re-binds through assertAccess, so one that keeps its access carries on and one that
 * lost it is refused there, rather than driving on until its session happens to end.
 */
export async function setLinkedAccess(browsers: BrowserManager, principal: Principal, browserId: string, input: { anyAgent?: unknown; agentIds?: unknown }): Promise<LinkedAccess> {
  if (principal.type !== "admin") throw Err.unauthorized("only the administrator can change who may use a linked browser");
  if (browsers.row(browserId).kind !== "linked") throw Err.invalid("that is not a linked browser");
  const access = { anyAgent: input.anyAgent === true, agentIds: checkAgents(Array.isArray(input.agentIds) ? input.agentIds : []) };
  const before = linkedAccess(browserId);
  writeAccess(browserId, access);
  audit({ actorType: principal.type, actorId: principal.id, action: "browser.link.access", targetType: "browser", targetId: browserId, detail: { before, after: access } });
  hub.emitEvent("browser.updated", {}, browserId);
  await browsers.dropSessions(browserId);
  return linkedAccess(browserId);
}

export function approvePairing(
  browsers: BrowserManager,
  principal: Principal,
  input: { userCode: string; agentIds?: unknown; anyAgent?: unknown; agentId?: unknown; name?: string },
): { browserId: string; linkId: string } {
  const row = livePairing("user_code", normalizeUserCode(input.userCode));
  if (!row) throw Err.notFound("that code is not waiting for approval; it may have expired. Start again from the extension.");
  if (row.state !== "pending") throw Err.conflict(`this pairing was already ${row.state}`);
  // `agentId` is the 0.6.0 dashboard's single choice, still accepted from a tab left open
  // across the upgrade.
  const requested = Array.isArray(input.agentIds) ? input.agentIds : typeof input.agentId === "string" ? [input.agentId] : [];
  const access = { anyAgent: input.anyAgent === true, agentIds: checkAgents(requested as string[]) };
  // The administrator owns every linked browser. Which agents may use it is a list beside it,
  // not ownership, so none of them can delete it, lend it or change who else gets in.
  const browser = browsers.createLinked({ approvedBy: principal, name: input.name?.trim() || row.device_name });
  writeAccess(browser.id, access);
  const linkId = randomBytes(8).toString("hex");
  getDb()
    .prepare(
      `INSERT INTO browser_links(id, browser_id, device_name, user_agent, approved_by_type, approved_by_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(linkId, browser.id, row.device_name, row.user_agent, principal.type, principal.id, nowIso());
  getDb().prepare(`UPDATE link_pairings SET state = 'approved', link_id = ? WHERE id = ?`).run(linkId, row.id);
  audit({
    actorType: principal.type,
    actorId: principal.id,
    action: "browser.link.approved",
    targetType: "browser",
    targetId: browser.id,
    detail: { linkId, deviceName: row.device_name, access, remoteAddr: row.remote_addr },
  });
  return { browserId: browser.id, linkId };
}

export function denyPairing(principal: Principal, userCode: string): void {
  const row = livePairing("user_code", normalizeUserCode(userCode));
  if (!row || row.state !== "pending") return;
  getDb().prepare(`UPDATE link_pairings SET state = 'denied' WHERE id = ?`).run(row.id);
  audit({ actorType: principal.type, actorId: principal.id, action: "browser.link.denied", targetType: "pairing", targetId: row.id, detail: { deviceName: row.device_name } });
}

/**
 * The extension's poll. The token is minted here, at collection, rather than at approval:
 * that way it never sits in the database in a form anyone could read back, and a pairing
 * that is approved but never collected leaves no credential behind.
 */
export function pollPairing(deviceCode: string):
  | { state: "pending" | "denied" | "expired" }
  | { state: "approved"; token: string; browserId: string; browserName: string } {
  const row = livePairing("device_hash", sha256(deviceCode));
  if (!row || row.state === "claimed") return { state: "expired" };
  if (row.state !== "approved" || !row.link_id) return { state: row.state === "denied" ? "denied" : "pending" };
  const link = getDb().prepare(`SELECT * FROM browser_links WHERE id = ? AND revoked_at IS NULL`).get(row.link_id) as LinkRow | undefined;
  if (!link) return { state: "expired" };
  const token = newToken("tl_ln");
  getDb().prepare(`UPDATE browser_links SET token_hash = ? WHERE id = ?`).run(sha256(token), link.id);
  getDb().prepare(`UPDATE link_pairings SET state = 'claimed' WHERE id = ?`).run(row.id);
  const name = (getDb().prepare(`SELECT name FROM browsers WHERE id = ?`).get(link.browser_id) as { name: string } | undefined)?.name;
  return { state: "approved", token, browserId: link.browser_id, browserName: name ?? link.device_name };
}

export function linkFor(browserId: string): LinkRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM browser_links WHERE browser_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(browserId) as LinkRow | undefined;
}

export function liveLink(browserId: string): LinkConnection | undefined {
  const conn = connections.get(browserId);
  return conn?.ready ? conn : undefined;
}

/** The dashboard's view of a link. Never the row: the row carries the token hash. */
export function linkView(browserId: string) {
  const row = linkFor(browserId);
  if (!row) return null;
  const conn = liveLink(browserId);
  return {
    id: row.id,
    deviceName: row.device_name,
    online: Boolean(conn),
    sharedTabs: conn ? [...conn.tabs().values()].map((t) => ({ url: t.info.url, title: t.info.title })) : [],
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Revoke every link to a browser and cut the socket. Deleting the browser comes through here. */
export function dropLinksFor(browserId: string, reason = "revoked"): void {
  getDb().prepare(`UPDATE browser_links SET revoked_at = ? WHERE browser_id = ? AND revoked_at IS NULL`).run(nowIso(), browserId);
  connections.get(browserId)?.shutdown(reason);
}

export function closeAllLinks(): void {
  for (const conn of [...connections.values()]) conn.shutdown("server shutting down");
}

export function sweepLinks(): void {
  const now = Date.now();
  for (const conn of [...connections.values()]) {
    if (now - conn.lastHeard > SILENCE_LIMIT_MS) conn.shutdown("no heartbeat");
  }
  getDb().prepare(`DELETE FROM link_pairings WHERE expires_at < ?`).run(new Date(now - 3_600_000).toISOString());
}

function parseTab(raw: unknown): LinkedTab | null {
  const t = raw as { tabId?: unknown; info?: Partial<TargetInfo> } | null;
  if (!t || !Number.isInteger(t.tabId) || !t.info || typeof t.info.targetId !== "string" || !t.info.targetId) return null;
  return {
    tabId: t.tabId as number,
    info: {
      targetId: clip(t.info.targetId, 100),
      type: "page",
      title: clip(t.info.title, 500),
      url: clip(t.info.url, 4000),
      browserContextId: clip(t.info.browserContextId, 100) || undefined,
    },
  };
}

/** The extension's socket: request/reply one way, events the other. */
export class LinkConnection extends EventEmitter implements LinkPeer {
  product = "Chromium";
  userAgent = "";
  ready = false;
  lastHeard = Date.now();
  private nextId = 0;
  private lastStamp = 0;
  private readonly shared = new Map<number, LinkedTab>();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly ws: WebSocket, private readonly onHello: (conn: LinkConnection, token: string) => LinkRow) {
    super();
    // A client per shared tab per consumer adds up, and a leak warning here is only noise.
    this.setMaxListeners(0);
    const deadline = setTimeout(() => !this.ready && this.shutdown("no hello"), HELLO_TIMEOUT_MS);
    deadline.unref();
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("close", () => this.shutdown("socket closed"));
    ws.on("error", () => this.shutdown("socket error"));
  }

  link: LinkRow | undefined;

  tabs(): ReadonlyMap<number, LinkedTab> {
    return this.shared;
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ready) return Promise.reject(new Error("the linked browser went offline"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`the linked browser did not answer ${method} in time`));
      }, CALL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.shutdown("malformed message");
    }
    this.lastHeard = Date.now();
    if (!this.ready) {
      if (msg.event !== "hello" || typeof msg.token !== "string") return this.shutdown("expected hello");
      try {
        this.link = this.onHello(this, msg.token);
      } catch (e) {
        return this.shutdown((e as Error).message);
      }
      this.product = clip(msg.product, 80) || "Chromium";
      this.userAgent = clip(msg.userAgent, 300);
      for (const raw of Array.isArray(msg.tabs) ? msg.tabs.slice(0, 200) : []) {
        const tab = parseTab(raw);
        if (tab) this.shared.set(tab.tabId, tab);
      }
      this.ready = true;
      this.ws.send(JSON.stringify({ event: "welcome" }));
      this.emit("ready");
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(clip(msg.error, 2000) || "the linked browser refused"));
      else p.resolve(msg.result);
      return;
    }
    switch (msg.event) {
      case "ping":
        this.ws.send(JSON.stringify({ event: "pong" }));
        if (this.link && this.lastHeard - this.lastStamp > 60_000) {
          this.lastStamp = this.lastHeard;
          getDb().prepare(`UPDATE browser_links SET last_seen_at = ? WHERE id = ?`).run(nowIso(), this.link.id);
        }
        return;
      case "tab.shared": {
        const tab = parseTab(msg.tab);
        if (!tab) return;
        this.shared.set(tab.tabId, tab);
        this.emit("shared", tab);
        return;
      }
      case "tab.updated": {
        const tab = this.shared.get(msg.tabId as number);
        if (!tab) return;
        tab.info = { ...tab.info, url: clip(msg.url, 4000) || tab.info.url, title: clip(msg.title, 500) };
        this.emit("updated", tab);
        return;
      }
      case "tab.unshared": {
        const tab = this.shared.get(msg.tabId as number);
        if (!tab) return;
        this.shared.delete(tab.tabId);
        this.emit("unshared", tab.tabId, clip(msg.reason, 80) || "unshared", tab.info);
        return;
      }
      case "cdp":
        if (this.shared.has(msg.tabId as number) && typeof msg.method === "string") {
          this.emit("cdp", msg.tabId, typeof msg.sessionId === "string" ? msg.sessionId : undefined, msg.method, (msg.params as Record<string, unknown>) ?? {});
        }
        return;
    }
  }

  private dead = false;

  shutdown(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    const wasReady = this.ready;
    this.ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`the linked browser went offline (${reason})`));
    }
    this.pending.clear();
    try {
      this.ws.close(1000, reason.slice(0, 120));
    } catch {
      /* already gone */
    }
    if (wasReady) log.info("linked browser disconnected", { browserId: this.link?.browser_id, reason });
    this.emit("close", reason);
  }
}

export function attachLinkUpgrade(server: import("node:http").Server, browsers: BrowserManager): WebSocketServer {
  // A full-page screenshot comes back as one base64 CDP result.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  onUpgrade(server, (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/v1/links/connect") return false;
    try {
      rateLimit(`link-connect:${req.socket.remoteAddress ?? "unknown"}`, 30, 15);
    } catch {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    // The token arrives in the first message, not the URL: URLs are what proxies and access
    // logs keep, and this one opens a person's signed-in browser.
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new LinkConnection(ws, (self, token) => {
        const link = getDb().prepare(`SELECT * FROM browser_links WHERE token_hash = ?`).get(sha256(token)) as LinkRow | undefined;
        if (!link || link.revoked_at) throw new Error("link revoked");
        // A reconnect must win, or a half-dead socket locks the browser out until TCP gives up.
        connections.get(link.browser_id)?.shutdown("replaced by a new connection");
        connections.set(link.browser_id, self);
        getDb().prepare(`UPDATE browser_links SET connected_at = ?, last_seen_at = ? WHERE id = ?`).run(nowIso(), nowIso(), link.id);
        return link;
      });
      conn.once("ready", () => {
        const browserId = conn.link!.browser_id;
        audit({ actorType: "link", actorId: conn.link!.id, action: "browser.link.connected", targetType: "browser", targetId: browserId, detail: { product: conn.product } });
        hub.emitEvent("browser.link.connected", { tabs: conn.tabs().size }, browserId);
        const changed = () => hub.emitEvent("browser.link.tabs", { tabs: conn.tabs().size }, browserId);
        conn.on("shared", changed);
        conn.on("unshared", changed);
      });
      conn.once("close", () => {
        const browserId = conn.link?.browser_id;
        if (!browserId || connections.get(browserId) !== conn) return;
        connections.delete(browserId);
        hub.emitEvent("browser.link.disconnected", {}, browserId);
        void browsers.linkDropped(browserId);
      });
    });
    return true;
  });
  return wss;
}
