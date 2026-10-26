import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { sha256, newToken, type Principal } from "./auth.js";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { rateLimit } from "./rate-limit.js";
import { onUpgrade } from "./upgrades.js";
import { MAX_CHUNK, TunnelMux } from "./tunnels.js";

/**
 * Gateways: letting a browser reach the web from a computer its operator owns.
 *
 * Chrome here runs in a datacenter, and sites score that address before anyone touches the
 * page. Cloudflare answers with a challenge that a person at the viewer cannot get past, and
 * ChatGPT refuses a signed-in session outright, with no checkbox to click. Nothing about the
 * browser can fix where its packets come from. A gateway is the operator's own computer
 * dialling out to this instance, and a browser assigned to it reaches the web from there.
 *
 *   - Admin only, both creating one and assigning it. A gateway carries a browser's traffic and
 *     sees which addresses it connects to, so it is the operator's decision, never an agent's.
 *   - Vetted here first. The egress proxy resolves the name and refuses private destinations
 *     exactly as before, then hands the gateway a public IP and a port. The gateway never
 *     resolves a name, so no page can steer it at the network it sits on. The client checks
 *     the address again on its side, in case this side is ever wrong.
 *   - Encrypted end to end. HTTPS crosses as CONNECT bytes, so the gateway relays ciphertext.
 *   - Fails closed. A browser whose gateway is not connected gets 502s, never the datacenter
 *     route. The operator chose this route on purpose, and a site that watches a session's
 *     address change mid-way trusts it less than one that never moved.
 *   - The data path is the tunnel protocol (tunnels.ts): one outbound WebSocket from the
 *     gateway, many streams over it. Nothing listens on the operator's computer.
 */

export type GatewayRow = {
  id: string;
  name: string;
  token_hash: string;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  connected_at: string | null;
  last_seen_at: string | null;
  remote_address: string | null;
  client_json: string | null;
  bytes_up: number;
  bytes_down: number;
};

/** Offered by the client. The token rides as a second protocol, a header no proxy logs as a URL. */
export const GATEWAY_PROTOCOL = "tallylamp-gateway.v1";
export const TOKEN_PROTOCOL_PREFIX = "tallylamp.token.";
/** Close codes the client treats as final: reconnecting with the same token cannot help. */
export const CLOSE_REJECTED = 4401;
export const CLOSE_REMOVED = 4403;
export const CLOSE_REPLACED = 4409;
/** 1012 is "service restart": the client should come back once this instance is up again. */
const CLOSE_RESTART = 1012;
/** How often the server pings and the client is told it is still heard. */
const HEARTBEAT_MS = 20_000;
const NAME_MAX = 60;

/** Bound to a gateway that is not connected, or that could not reach the address. */
export class GatewayUnavailable extends Error {}

function rowById(id: string): GatewayRow | undefined {
  return getDb().prepare(`SELECT * FROM gateways WHERE id = ?`).get(id) as GatewayRow | undefined;
}

export function gatewayRow(id: string): GatewayRow {
  const row = rowById(id);
  if (!row) throw Err.notFound("gateway not found");
  return row;
}

function assertAdmin(principal: Principal): void {
  if (principal.type !== "admin") throw Err.unauthorized("only the administrator can manage gateways");
}

function browsersUsing(gatewayId: string): Array<{ id: string; name: string }> {
  return getDb()
    .prepare(`SELECT id, name FROM browsers WHERE gateway_id = ? ORDER BY name`)
    .all(gatewayId) as Array<{ id: string; name: string }>;
}

/** Browser pages show their gateway's state, so they change when it connects or drops. */
function announce(type: string, gatewayId: string, payload: Record<string, unknown> = {}): void {
  hub.emitEvent(type, { gatewayId, ...payload });
  for (const b of browsersUsing(gatewayId)) hub.emitEvent("browser.updated", {}, b.id);
}

export function createGateway(principal: Principal, input: { name?: unknown }): { row: GatewayRow; token: string } {
  assertAdmin(principal);
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name) throw Err.invalid("name the gateway after the computer it runs on, for example \"Studio Mac\"");
  if (name.length > NAME_MAX) throw Err.invalid(`a gateway name is at most ${NAME_MAX} characters`);
  const clash = getDb().prepare(`SELECT 1 FROM gateways WHERE lower(name) = lower(?)`).get(name);
  if (clash) throw Err.conflict(`a gateway named ${name} already exists`);
  const id = randomBytes(8).toString("hex");
  const token = newToken("tl_gw");
  getDb()
    .prepare(
      `INSERT INTO gateways(id, name, token_hash, created_by_type, created_by_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, sha256(token), principal.type, principal.id, nowIso());
  audit({ actorType: principal.type, actorId: principal.id, action: "gateway.created", targetType: "gateway", targetId: id, detail: { name } });
  hub.emitEvent("gateway.created", { gatewayId: id });
  return { row: gatewayRow(id), token };
}

export function removeGateway(principal: Principal, id: string): void {
  assertAdmin(principal);
  const row = gatewayRow(id);
  // Removing it from under a browser would leave that browser with no route at all, and the
  // only safe reading of "no route" is "no web". Make the operator choose for each browser.
  const using = browsersUsing(id);
  if (using.length) {
    throw Err.conflict(
      `${using.map((b) => b.name).join(", ")} ${using.length === 1 ? "uses" : "use"} this gateway. ` +
        `Switch ${using.length === 1 ? "it" : "them"} to another connection first.`,
    );
  }
  connections.get(id)?.shutdown("gateway removed", CLOSE_REMOVED);
  getDb().prepare(`DELETE FROM gateways WHERE id = ?`).run(id);
  audit({ actorType: principal.type, actorId: principal.id, action: "gateway.removed", targetType: "gateway", targetId: id, detail: { name: row.name } });
  hub.emitEvent("gateway.removed", { gatewayId: id });
}

export function gatewayView(row: GatewayRow) {
  const conn = connections.get(row.id);
  let client: Record<string, unknown> | null = null;
  try {
    client = row.client_json ? (JSON.parse(row.client_json) as Record<string, unknown>) : null;
  } catch {
    client = null;
  }
  return {
    id: row.id,
    name: row.name,
    online: Boolean(conn),
    connectedAt: conn ? row.connected_at : null,
    lastSeenAt: conn ? nowIso() : row.last_seen_at,
    // Where its socket came from. Sites see the same address unless that computer splits its
    // traffic, so this is the address a browser on this gateway appears to browse from.
    remoteAddress: row.remote_address,
    client,
    bytesUp: row.bytes_up + (conn?.pendingUp ?? 0),
    bytesDown: row.bytes_down + (conn?.pendingDown ?? 0),
    browsers: browsersUsing(row.id),
    createdAt: row.created_at,
  };
}

/**
 * What to run on the gateway computer. The client is served by this instance (server.ts), so it
 * needs Node 22 or newer and nothing else: no checkout and no package. The token goes in the
 * environment rather than argv, where `ps` would show it.
 */
export function gatewayCommand(token: string): string {
  const base = config.publicUrl.replace(/\/$/, "");
  return `curl -fsSLo tallylamp.mjs ${base}/tallylamp.mjs && TALLYLAMP_URL=${base} TALLYLAMP_GATEWAY_TOKEN=${token} node tallylamp.mjs gateway`;
}

export function listGateways() {
  return (getDb().prepare(`SELECT * FROM gateways ORDER BY created_at`).all() as GatewayRow[]).map(gatewayView);
}

export function gatewayExists(id: string): boolean {
  return Boolean(rowById(id));
}

/** The short form a browser's own view carries. */
export function gatewayBrief(id: string): { id: string; name: string; online: boolean } {
  const row = rowById(id);
  return { id, name: row?.name ?? "a removed gateway", online: connections.has(id) };
}

/**
 * The egress proxy's route for a browser assigned to a gateway. `address` is already vetted and
 * pinned: a public IP, never a name. Every failure is a GatewayUnavailable, which the proxy
 * answers with a 502 and never with a direct connection.
 */
export async function dialGateway(gatewayId: string, address: string, port: number): Promise<Duplex> {
  const conn = connections.get(gatewayId);
  const name = () => rowById(gatewayId)?.name ?? "this browser's gateway";
  if (!conn) {
    throw new GatewayUnavailable(
      `This browser reaches the web through the gateway ${name()}, which is not connected. Start it on that computer, then reload.`,
    );
  }
  let stream: Duplex | null;
  try {
    stream = await conn.open(address, port);
  } catch (e) {
    throw new GatewayUnavailable(`The gateway ${name()} could not reach ${address}:${port}: ${(e as Error).message}`);
  }
  if (!stream) throw new GatewayUnavailable(`The gateway ${name()} refused ${address}:${port}.`);
  return stream;
}

/** A gateway's live socket: the stream mux, a heartbeat both ends can see, and the counters. */
class GatewayConnection extends TunnelMux {
  private answered = true;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    readonly gatewayId: string,
    ws: WebSocket,
  ) {
    super(ws, { gatewayId }, { maxStreams: config.gatewayMaxStreams, openTimeoutMs: config.gatewayOpenTimeoutMs });
    ws.on("pong", () => {
      this.answered = true;
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.onText(String(data));
    });
    // A laptop that sleeps or changes network leaves a socket that looks open from here for as
    // long as TCP takes to notice. Two missed pongs end it, which frees the route to report
    // "not connected" instead of timing every page out.
    this.heartbeat = setInterval(() => {
      if (!this.answered) {
        log.warn("gateway stopped answering", { gatewayId });
        ws.terminate();
        return;
      }
      this.answered = false;
      try {
        ws.ping();
        // A WHATWG WebSocket client never sees a ping, so it watches for this instead.
        ws.send(JSON.stringify({ type: "heartbeat" }));
      } catch {
        /* closing */
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get pendingUp(): number {
    return this.bytesUp;
  }

  get pendingDown(): number {
    return this.bytesDown;
  }

  /** The client says what it is once, after connecting. Shown on the Gateways page, nothing else. */
  private onText(text: string): void {
    let msg: { type?: unknown; hostname?: unknown; platform?: unknown; version?: unknown; ports?: unknown };
    try {
      msg = JSON.parse(text.slice(0, 2048)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== "hello") return;
    const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
    const client = {
      hostname: clip(msg.hostname, 80),
      platform: clip(msg.platform, 20),
      version: clip(msg.version, 20),
      ports: Array.isArray(msg.ports) ? msg.ports.filter((p) => Number.isInteger(p)).slice(0, 16) : null,
    };
    getDb().prepare(`UPDATE gateways SET client_json = ? WHERE id = ?`).run(JSON.stringify(client), this.gatewayId);
    announce("gateway.updated", this.gatewayId);
  }

  protected override closedBecause(reason: string): void {
    clearInterval(this.heartbeat);
    if (connections.get(this.gatewayId) === this) connections.delete(this.gatewayId);
    this.flush();
    log.info("gateway disconnected", { gatewayId: this.gatewayId, reason });
    announce("gateway.disconnected", this.gatewayId, { reason });
  }

  flush(): void {
    try {
      getDb()
        .prepare(`UPDATE gateways SET bytes_up = bytes_up + ?, bytes_down = bytes_down + ?, last_seen_at = ? WHERE id = ?`)
        .run(this.bytesUp, this.bytesDown, nowIso(), this.gatewayId);
    } catch {
      /* removed while connected */
    }
    this.bytesUp = 0;
    this.bytesDown = 0;
  }
}

const connections = new Map<string, GatewayConnection>();

export function gatewayIsConnected(id: string): boolean {
  return connections.has(id);
}

/** The address its socket came from; behind a known proxy, what that proxy says it saw. */
function remoteAddress(req: IncomingMessage): string | null {
  const forwarded = config.trustProxy
    ? String(req.headers["x-forwarded-for"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop()
    : undefined;
  const raw = forwarded || req.socket.remoteAddress || null;
  return raw ? raw.replace(/^::ffff:/, "").slice(0, 64) : null;
}

function offeredProtocols(req: IncomingMessage): string[] {
  return String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function attachGatewayUpgrade(server: import("node:http").Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CHUNK + 64 * 1024,
    // Only ever echo the protocol name. The token is the other one the client offered.
    handleProtocols: (protocols) => (protocols.has(GATEWAY_PROTOCOL) ? GATEWAY_PROTOCOL : false),
  });
  onUpgrade(server, (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/v1/gateways/connect") return false;
    const netSocket = socket as import("node:net").Socket;
    netSocket.setTimeout(15_000, () => socket.destroy());
    const offered = offeredProtocols(req);
    try {
      rateLimit(`gateway-connect:${remoteAddress(req) ?? "unknown"}`, 30, 15);
    } catch {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    if (!offered.includes(GATEWAY_PROTOCOL)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    const token = offered.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length) ?? "";
    const row = token
      ? (getDb().prepare(`SELECT * FROM gateways WHERE token_hash = ?`).get(sha256(token)) as GatewayRow | undefined)
      : undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      netSocket.setTimeout(0);
      // Upgraded first and closed with a code, rather than refused with a 401: a WHATWG client
      // cannot read a refused handshake's status, so it could not tell a bad token from a dropped
      // network and would retry a removed gateway for ever.
      if (!row) {
        log.warn("gateway connect rejected", { from: remoteAddress(req) });
        ws.close(CLOSE_REJECTED, "gateway token rejected");
        return;
      }
      // A reconnect must win. The socket it replaces is usually that same computer's, gone
      // half-dead when it slept, and waiting for TCP to notice would keep its browsers offline.
      connections.get(row.id)?.shutdown("replaced by a new connection", CLOSE_REPLACED);
      const conn = new GatewayConnection(row.id, ws);
      connections.set(row.id, conn);
      const from = remoteAddress(req);
      getDb()
        .prepare(`UPDATE gateways SET connected_at = ?, last_seen_at = ?, remote_address = ? WHERE id = ?`)
        .run(nowIso(), nowIso(), from, row.id);
      log.info("gateway connected", { gatewayId: row.id, from });
      audit({ actorType: "gateway", actorId: row.id, action: "gateway.connected", targetType: "gateway", targetId: row.id, detail: { from } });
      announce("gateway.connected", row.id);
    });
    return true;
  });
  return wss;
}

/** Write the byte counters and the last-seen time of every live gateway. */
export function sweepGateways(): void {
  for (const conn of connections.values()) conn.flush();
}

export function closeAllGateways(): void {
  for (const conn of [...connections.values()]) conn.shutdown("server restarting", CLOSE_RESTART);
}
