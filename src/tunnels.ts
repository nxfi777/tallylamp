import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { requireScope, sha256, newToken, type Principal } from "./auth.js";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { hostLooksPrivate } from "./ssrf.js";
import { grantsFor } from "./lending.js";
import { rateLimit } from "./rate-limit.js";
import { onUpgrade } from "./upgrades.js";
import type { BrowserManager } from "./browsers.js";

/**
 * Loopback tunnels: letting one browser reach one private address on the machine that
 * asked for it.
 *
 * Chrome here runs on the server, so `http://localhost:5173` resolves on the server and an
 * agent's own dev server is simply unreachable — and the egress proxy refuses private
 * destinations anyway, deliberately. That is right for a browser pointed at hostile sites,
 * and wrong for the one case that cannot be worked around: an OAuth flow whose redirect_uri
 * is registered as `http://localhost:PORT/callback`. The provider redirects to that literal
 * address, the hosted browser resolves it on the container, and the code never reaches the
 * machine waiting for it. Consent succeeded; the flow is dead.
 *
 * So a tunnel re-opens exactly what the SSRF policy closed, and nothing else:
 *
 *   - A binding is one `browser x host:port`, not a forward. Chrome cannot pick the
 *     destination; the binding was declared before any page was loaded.
 *   - The authority MUST be one the egress policy would refuse -- loopback, RFC1918, .local.
 *     A tunnel on a *public* name would be a MITM primitive against the browser's own
 *     profile: bind `api.stripe.com:443` and Chrome's traffic to Stripe arrives at whoever
 *     holds the tunnel token instead. Requiring a private authority makes the tunnel's
 *     reachable set precisely the complement of the proxy's, so it can add no destination
 *     that was not already refused.
 *   - The data path is an outbound WebSocket from the machine being reached. Nothing new
 *     listens, no hostname resolves publicly, no certificate appears in a CT log. Compare a
 *     public tunnel service, where the dev server is reachable by anyone who finds the URL.
 *   - It expires, it is revocable, and it is off by default behind `browser:tunnel`.
 *
 * What remains, and is documented rather than mitigated: while a binding is live, any page
 * in that browser can fetch the bound authority. That is inherent -- the whole point is to
 * make it reachable -- which is why the window is short and the scope is not a default.
 */

export type TunnelRow = {
  id: string;
  browser_id: string;
  host: string;
  port: number;
  token_hash: string;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  connected_at: string | null;
  last_seen_at: string | null;
  bytes_up: number;
  bytes_down: number;
};

/** A binding exists but nothing is on the other end of it. Distinct from "no binding". */
export class TunnelUnavailable extends Error {}

const F_OPEN = 0x01;
const F_DATA = 0x02;
const F_CLOSE = 0x03;
const F_ACK = 0x04;
const F_ERROR = 0x05;

const HEADER = 5;
/** Frames are capped well under the socket's maxPayload so one write cannot be refused. */
const MAX_CHUNK = 256 * 1024;
/** Per-stream ceiling on unread bytes. The protocol has no window, so this is the backstop. */
const MAX_BUFFERED = 8 * 1024 * 1024;

function encode(type: number, streamId: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const out = Buffer.allocUnsafe(HEADER + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId, 1);
  body.copy(out, HEADER);
  return out;
}

function decode(buf: Buffer): { type: number; streamId: number; payload: Buffer } | null {
  if (buf.length < HEADER) return null;
  return { type: buf.readUInt8(0), streamId: buf.readUInt32BE(1), payload: buf.subarray(HEADER) };
}

export function normalizeAuthority(host: string, port: number): { host: string; port: number } {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) throw Err.invalid("tunnel host is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Err.invalid("tunnel port must be 1-65535");
  // The whole safety argument rests on this: a tunnel may only reach what the egress proxy
  // already refuses, so it can never shadow a real site the profile is logged into.
  if (!hostLooksPrivate(h)) {
    throw Err.invalid(
      `a tunnel may only bind a loopback or private address; ${h} is public and would shadow the real site for this browser`,
    );
  }
  return { host: h, port };
}

export function tunnelRow(id: string): TunnelRow {
  const row = getDb().prepare(`SELECT * FROM browser_tunnels WHERE id = ?`).get(id) as TunnelRow | undefined;
  if (!row) throw Err.notFound("tunnel not found");
  return row;
}

export function listTunnels(browserId: string): TunnelRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM browser_tunnels WHERE browser_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at`,
    )
    .all(browserId, nowIso()) as TunnelRow[];
}

/**
 * Owner-or-admin, never a borrower. A borrowed browser reaching the borrower's laptop would
 * be defensible, but `assertAccess(..., "control")` also admits a grant, and the operator who
 * lent a browser out did not consent to it dialling anywhere. Ownership is the clean line,
 * the same one `setLendable` draws.
 */
function assertMayTunnel(browsers: BrowserManager, browserId: string, principal: Principal): void {
  const row = browsers.row(browserId);
  if (principal.type === "admin") return;
  if (row.owner_id !== principal.id) throw Err.unauthorized("browser is owned by another principal");
  requireScope(principal, "browser:tunnel");
}

/** Seeing the bindings is owner-or-admin too, but needs no scope: it is not a new capability. */
export function assertMaySeeTunnels(browsers: BrowserManager, browserId: string, principal: Principal): void {
  if (principal.type === "admin") return;
  const row = browsers.row(browserId);
  if (row.owner_id !== principal.id) throw Err.unauthorized("browser is owned by another principal");
}

export function createTunnel(
  browsers: BrowserManager,
  principal: Principal,
  input: { browserId: string; host?: string; port: number; ttlSec?: number },
): { row: TunnelRow; token: string } {
  assertMayTunnel(browsers, input.browserId, principal);
  // Ownership at create time is not enough on its own: a grant issued afterwards would hand
  // the borrower a browser that can already reach the owner's machine. The two are mutually
  // exclusive in both orderings -- issueGrant drops tunnels, and this refuses while a
  // borrower is holding the browser.
  if (grantsFor(input.browserId).length) {
    throw Err.conflict("this browser is currently lent to another agent; take it back before opening a tunnel");
  }
  const authority = normalizeAuthority(input.host ?? "127.0.0.1", input.port);

  // listTunnels hides expired rows, but the partial unique index does not -- an expired row
  // that the 15s sweep has not reached yet would turn a legitimate re-create into a raw
  // SQLite UNIQUE error and a 500. Retire it here rather than waiting for the sweep.
  getDb()
    .prepare(`UPDATE browser_tunnels SET revoked_at = ? WHERE browser_id = ? AND revoked_at IS NULL AND expires_at <= ?`)
    .run(nowIso(), input.browserId, nowIso());
  const live = listTunnels(input.browserId);
  const already = live.find((t) => t.host === authority.host && t.port === authority.port);
  if (already) throw Err.conflict(`a tunnel for ${authority.host}:${authority.port} already exists on this browser`);
  if (live.length >= config.tunnelsPerBrowser) {
    throw Err.conflict(`this browser already has ${live.length} tunnels (max ${config.tunnelsPerBrowser})`);
  }

  const ttl = Math.min(
    Math.max((input.ttlSec ?? 0) * 1000 || config.tunnelTtlMs, 60_000),
    config.tunnelMaxTtlMs,
  );
  const id = randomBytes(8).toString("hex");
  const token = newToken("tl_tn");
  const expires = new Date(Date.now() + ttl).toISOString();
  getDb()
    .prepare(
      `INSERT INTO browser_tunnels(id, browser_id, host, port, token_hash, created_by_type, created_by_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.browserId, authority.host, authority.port, sha256(token), principal.type, principal.id, nowIso(), expires);
  audit({
    actorType: principal.type,
    actorId: principal.id,
    action: "browser.tunnel.opened",
    targetType: "browser",
    targetId: input.browserId,
    detail: { tunnelId: id, authority: `${authority.host}:${authority.port}`, expiresAt: expires },
  });
  hub.emitEvent("browser.tunnel.opened", { tunnelId: id, authority: `${authority.host}:${authority.port}` }, input.browserId);
  return { row: tunnelRow(id), token };
}

export function revokeTunnel(browsers: BrowserManager, principal: Principal, tunnelId: string): TunnelRow {
  const row = tunnelRow(tunnelId);
  assertMayTunnel(browsers, row.browser_id, principal);
  getDb().prepare(`UPDATE browser_tunnels SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), tunnelId);
  // Revoking has to cut the live channel too, or the binding is gone from the table while
  // Chrome keeps talking down a socket that is still open.
  connections.get(tunnelId)?.shutdown("revoked");
  audit({
    actorType: principal.type,
    actorId: principal.id,
    action: "browser.tunnel.revoked",
    targetType: "browser",
    targetId: row.browser_id,
    detail: { tunnelId, authority: `${row.host}:${row.port}` },
  });
  hub.emitEvent("browser.tunnel.revoked", { tunnelId }, row.browser_id);
  return tunnelRow(tunnelId);
}

/** Live bindings for an authority, ignoring expiry state held only in the table. */
function findBinding(browserId: string, host: string, port: number): TunnelRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM browser_tunnels
       WHERE browser_id = ? AND host = ? AND port = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(browserId, host.toLowerCase().replace(/^\[|\]$/g, ""), port, nowIso()) as TunnelRow | undefined;
  return row ?? null;
}

type StreamState = { duplex: Duplex; settle?: (err: Error | null) => void };

class TunnelConnection {
  private streams = new Map<number, StreamState>();
  private nextId = 1;
  private closed = false;

  constructor(
    readonly tunnelId: string,
    readonly browserId: string,
    private readonly ws: WebSocket,
  ) {
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.onFrame(buf);
    });
    ws.on("close", () => this.shutdown("socket closed"));
    ws.on("error", (e) => {
      log.warn("tunnel socket error", { tunnelId, error: (e as Error).message });
      this.shutdown("socket error");
    });
  }

  private onFrame(buf: Buffer): void {
    const f = decode(buf);
    if (!f) return;
    const st = this.streams.get(f.streamId);
    if (!st) return;
    if (f.type === F_ACK) {
      st.settle?.(null);
      st.settle = undefined;
      return;
    }
    if (f.type === F_ERROR) {
      const reason = f.payload.toString("utf8").slice(0, 200) || "refused";
      if (st.settle) {
        st.settle(new TunnelUnavailable(reason));
        st.settle = undefined;
      }
      this.dropStream(f.streamId);
      return;
    }
    if (f.type === F_DATA) {
      this.bytesDown += f.payload.length;
      st.duplex.push(f.payload);
      // The peer cannot be told to slow down -- the protocol has no window -- so a reader
      // slower than the sender is bounded here rather than allowed to buffer without limit.
      if (st.duplex.readableLength > MAX_BUFFERED) {
        log.warn("tunnel stream exceeded its read buffer", { tunnelId: this.tunnelId, streamId: f.streamId });
        this.dropStream(f.streamId);
      }
      return;
    }
    if (f.type === F_CLOSE) {
      // push(null) ends the readable side; destroying here instead would drop whatever is
      // still buffered and truncate the tail of the response.
      st.duplex.push(null);
      this.streams.delete(f.streamId);
    }
  }

  private bytesUp = 0;
  private bytesDown = 0;

  private dropStream(streamId: number): void {
    const st = this.streams.get(streamId);
    if (!st) return;
    this.streams.delete(streamId);
    if (!st.duplex.destroyed) st.duplex.destroy();
  }

  private send(type: number, streamId: number, payload?: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(type, streamId, payload), { binary: true });
  }

  async open(host: string, port: number): Promise<Duplex> {
    if (this.closed) throw new TunnelUnavailable("tunnel is closing");
    if (this.streams.size >= config.tunnelMaxStreams) {
      throw new TunnelUnavailable(`tunnel is at its stream limit (${config.tunnelMaxStreams})`);
    }
    const streamId = this.nextId++;
    // uint32 wrap is not reachable in a tunnel's lifetime, but a wrapped id would collide
    // with a live stream rather than fail, so refuse rather than reuse.
    if (streamId > 0xffff_fffe) throw new TunnelUnavailable("tunnel stream ids exhausted");

    const self = this;
    const duplex = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        if (self.ws.readyState !== WebSocket.OPEN) return cb(new Error("tunnel closed"));
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // Chunked so one big write cannot exceed the peer's frame limit, and the send
        // callback is the backpressure: the next chunk waits for this one to leave.
        let offset = 0;
        const pump = (err?: Error): void => {
          if (err) return cb(err);
          if (offset >= buf.length) return cb(null);
          const slice = buf.subarray(offset, offset + MAX_CHUNK);
          offset += slice.length;
          self.bytesUp += slice.length;
          self.ws.send(encode(F_DATA, streamId, slice), { binary: true }, (e) => pump(e ?? undefined));
        };
        pump();
      },
      final(cb) {
        self.send(F_CLOSE, streamId);
        cb();
      },
      destroy(err, cb) {
        self.send(F_CLOSE, streamId);
        self.streams.delete(streamId);
        cb(err);
      },
    });

    const state: StreamState = { duplex };
    this.streams.set(streamId, state);
    // The normalised spelling, not Chrome's: the client compares this against its own argv,
    // and "[::1]" vs "::1" or a capitalised name would make a valid binding refuse itself.
    const asked = `${host.toLowerCase().replace(/^\[|\]$/g, "")}:${port}`;
    this.send(F_OPEN, streamId, Buffer.from(asked, "utf8"));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.settle = undefined;
        this.dropStream(streamId);
        reject(new TunnelUnavailable("tunnel did not answer the open in time"));
      }, config.tunnelOpenTimeoutMs);
      timer.unref?.();
      state.settle = (err) => {
        clearTimeout(timer);
        if (err) {
          this.dropStream(streamId);
          reject(err);
        } else resolve();
      };
    });
    return duplex;
  }

  shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, st] of this.streams) {
      st.settle?.(new TunnelUnavailable(reason));
      st.settle = undefined;
      this.streams.delete(id);
      if (!st.duplex.destroyed) st.duplex.destroy();
    }
    try {
      this.ws.close(1000, reason.slice(0, 100));
    } catch {
      /* already gone */
    }
    if (connections.get(this.tunnelId) === this) connections.delete(this.tunnelId);
    this.flush();
    log.info("tunnel disconnected", { tunnelId: this.tunnelId, reason });
    hub.emitEvent("browser.tunnel.disconnected", { tunnelId: this.tunnelId, reason }, this.browserId);
  }

  flush(): void {
    if (!this.bytesUp && !this.bytesDown) return;
    try {
      getDb()
        .prepare(`UPDATE browser_tunnels SET bytes_up = bytes_up + ?, bytes_down = bytes_down + ?, last_seen_at = ? WHERE id = ?`)
        .run(this.bytesUp, this.bytesDown, nowIso(), this.tunnelId);
    } catch {
      /* the row can be gone if the browser was deleted mid-stream */
    }
    this.bytesUp = 0;
    this.bytesDown = 0;
  }
}

const connections = new Map<string, TunnelConnection>();

/**
 * The egress proxy's hook. Returns a stream when this browser has a binding for the
 * authority, null when it has none — in which case the caller falls through to the ordinary
 * SSRF check, which refuses. A miss therefore fails closed to a 403, never to a fetch.
 */
export async function dialTunnel(browserId: string, host: string, port: number): Promise<Duplex | null> {
  const binding = findBinding(browserId, host, port);
  if (!binding) return null;
  const conn = connections.get(binding.id);
  if (!conn) {
    throw new TunnelUnavailable(
      `a tunnel is bound to ${host}:${port} for this browser but nothing is connected to it`,
    );
  }
  return conn.open(host, port);
}

export function tunnelIsConnected(tunnelId: string): boolean {
  return connections.has(tunnelId);
}

export function closeAllTunnels(): void {
  for (const conn of [...connections.values()]) conn.shutdown("server shutting down");
}

/** Revoke and disconnect every tunnel on a browser. Called when the browser goes away. */
export function dropTunnelsFor(browserId: string): void {
  // Driven off the live connections rather than off listTunnels: a row that expired but has
  // not been swept is filtered out of listTunnels while its socket is still open, and would
  // be left attached for the life of the process.
  for (const conn of [...connections.values()]) {
    if (conn.browserId === browserId) conn.shutdown("browser gone");
  }
  getDb()
    .prepare(`UPDATE browser_tunnels SET revoked_at = ? WHERE browser_id = ? AND revoked_at IS NULL`)
    .run(nowIso(), browserId);
}

function authenticateTunnel(tunnelId: string, token: string): TunnelRow {
  const row = getDb().prepare(`SELECT * FROM browser_tunnels WHERE id = ?`).get(tunnelId) as TunnelRow | undefined;
  if (!row) throw new Error("unknown tunnel");
  if (!token || sha256(token) !== row.token_hash) throw new Error("bad tunnel token");
  if (row.revoked_at) throw new Error("tunnel revoked");
  if (Date.parse(row.expires_at) <= Date.now()) throw new Error("tunnel expired");
  return row;
}

export function attachTunnelUpgrade(server: import("node:http").Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CHUNK + 64 * 1024 });
  onUpgrade(server, (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = url.pathname.match(/^\/api\/v1\/tunnels\/([^/]+)\/connect$/);
    // Not ours: leave it for the other handlers. The router closes what nobody claims.
    if (!m) return false;
    const netSocket = socket as import("node:net").Socket;
    netSocket.setTimeout(15_000, () => socket.destroy());
    try {
      // Unauthenticated connect attempts are cheap to generate; the token is unguessable but
      // the handshake is not free. Throttled the same way a failed bearer on /mcp is.
      rateLimit(`tunnel-connect:${req.socket.remoteAddress ?? "unknown"}`, 30, 15);
      const row = authenticateTunnel(m[1], url.searchParams.get("token") ?? "");
      wss.handleUpgrade(req, socket, head, (ws) => {
        netSocket.setTimeout(0);
        // A reconnect after a dropped socket must win, or a half-dead connection the server
        // has not noticed locks the tunnel out until the TCP timeout.
        connections.get(row.id)?.shutdown("replaced by a new connection");
        const conn = new TunnelConnection(row.id, row.browser_id, ws);
        connections.set(row.id, conn);
        getDb()
          .prepare(`UPDATE browser_tunnels SET connected_at = ?, last_seen_at = ? WHERE id = ?`)
          .run(nowIso(), nowIso(), row.id);
        log.info("tunnel connected", { tunnelId: row.id, browserId: row.browser_id, authority: `${row.host}:${row.port}` });
        audit({
          actorType: "tunnel",
          actorId: row.id,
          action: "browser.tunnel.connected",
          targetType: "browser",
          targetId: row.browser_id,
          detail: { authority: `${row.host}:${row.port}` },
        });
        hub.emitEvent("browser.tunnel.connected", { tunnelId: row.id }, row.browser_id);
      });
    } catch (e) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log.warn("tunnel upgrade rejected", { error: (e as Error).message });
    }
    return true;
  });
  return wss;
}

/** Expire rows whose time is up, and cut any socket still attached to one. */
export function sweepTunnels(): void {
  const now = nowIso();
  const stale = getDb()
    .prepare(`SELECT id FROM browser_tunnels WHERE revoked_at IS NULL AND expires_at <= ?`)
    .all(now) as Array<{ id: string }>;
  for (const { id } of stale) connections.get(id)?.shutdown("expired");
  if (stale.length) {
    getDb().prepare(`UPDATE browser_tunnels SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at <= ?`).run(now, now);
    log.info("expired tunnels", { count: stale.length });
  }
  for (const conn of connections.values()) conn.flush();
  // Revoked rows are kept briefly so the dashboard can still show what happened, then dropped.
  getDb()
    .prepare(`DELETE FROM browser_tunnels WHERE revoked_at IS NOT NULL AND revoked_at < ?`)
    .run(new Date(Date.now() - 86_400_000).toISOString());
}
