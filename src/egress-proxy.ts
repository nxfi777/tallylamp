import { createConnection, type Socket } from "node:net";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import type { BrowserProxy } from "./browser-proxy.js";
import { parseAuthority, resolveVetted } from "./ssrf.js";
import { dialUpstreamProxy, PROXY_HANDSHAKE_TIMEOUT_MS, PROXY_MAX_HEADER_BYTES } from "./upstream-proxy.js";
import { log } from "./log.js";

export type EgressProxy = { port: number; close: () => Promise<void> };
/** null means unbound; rejection means bound but unavailable, and must never fall back. */
export type TunnelDialer = (host: string, port: number) => Promise<Duplex | null>;
export type EgressOptions = {
  browserId?: string;
  dial?: TunnelDialer;
  upstream?: BrowserProxy | null;
};

class Denied extends Error {}
class TunnelUnavailable extends Error {}
const badGateway = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

function originHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const result = { ...headers };
  for (const name of (headers.connection ?? "").split(",")) delete result[name.trim().toLowerCase()];
  for (const name of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]) delete result[name];
  result.host = host;
  result.connection = "close";
  return result;
}

/** Chrome -> local egress -> optional upstream CONNECT -> pinned destination.
 * Node's HTTP parser bounds/reassembles headers and frames request bodies. Plain HTTP
 * is deliberately one request per client connection: no unchecked cross-authority reuse.
 */
export async function startEgressProxy(opts: EgressOptions = {}): Promise<EgressProxy> {
  const server = createServer({ maxHeaderSize: PROXY_MAX_HEADER_BYTES, headersTimeout: PROXY_HANDSHAKE_TIMEOUT_MS });
  const sockets = new Set<Duplex>();
  const used = new WeakSet<Duplex>();
  const headerTimers = new WeakMap<Duplex, NodeJS.Timeout>();
  function track(socket: Duplex) {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  }
  function begin(client: Duplex): boolean {
    clearTimeout(headerTimers.get(client));
    if (used.has(client)) { client.destroy(); return false; }
    used.add(client);
    return true;
  }
  async function dial(host: string, port: number, client: Duplex): Promise<Duplex> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    client.once("close", abort);
    const timer = setTimeout(abort, PROXY_HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    let peer: Duplex | undefined;
    const work = (async () => {
      let tunnel: Duplex | null | undefined;
      try { tunnel = await opts.dial?.(host, port); }
      catch { throw new TunnelUnavailable(); }
      if (tunnel) return tunnel;
      if (controller.signal.aborted) throw new Error("cancelled");
      const vetted = await resolveVetted(host);
      if (!vetted.ok || !vetted.addresses[0]) throw new Denied();
      if (controller.signal.aborted) throw new Error("cancelled");
      if (opts.upstream) return dialUpstreamProxy(opts.upstream, vetted.addresses[0].address, port, controller.signal);
      return new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host: vetted.addresses[0].address, port, signal: controller.signal });
        socket.on("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    })();
    // A tunnel dialer cannot be cancelled; destroy a late result instead of leaking it.
    void work.then((stream) => { if (controller.signal.aborted) stream.destroy(); }, () => {});
    try {
      peer = await new Promise<Duplex>((resolve, reject) => {
        const cancelled = () => reject(new Error("cancelled"));
        controller.signal.addEventListener("abort", cancelled, { once: true });
        work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", cancelled));
        if (client.destroyed || controller.signal.aborted) { abort(); cancelled(); }
      });
      if (client.destroyed) { peer.destroy(); throw new Error("cancelled"); }
      track(peer);
      client.once("close", () => peer!.destroy());
      return peer;
    } finally {
      clearTimeout(timer);
      client.removeListener("close", abort);
    }
  }

  server.on("connect", (req, client, head) => {
    if (!begin(client)) return;
    client.pause();
    const authority = req.url && /^[^\s/?#@]+:\d+$/.test(req.url) ? parseAuthority(req.url) : null;
    if (!authority || !Number.isInteger(authority.port) || authority.port < 1 || authority.port > 65535) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    void dial(authority.host, authority.port, client).then((peer) => {
      peer.on("error", () => client.destroy());
      peer.once("close", () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) peer.write(head);
      client.pipe(peer);
      peer.pipe(client);
    }, (error) => {
      if (!client.destroyed) client.end(error instanceof Denied
        ? "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        : badGateway);
    });
  });

  server.on("request", (req, res) => {
    if (!begin(req.socket)) return;
    req.pause();
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      // HTTPS is carried only via CONNECT, never plaintext to a TLS origin.
      if (url.protocol !== "http:" || url.username || url.password) throw new Error();
    } catch {
      res.writeHead(400, { connection: "close" }); res.end(); return;
    }
    void dial(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 80), req.socket).then((peer) => {
      const outgoing = request({
        method: req.method, path: `${url.pathname}${url.search}`,
        headers: originHeaders(req.headers, url.host),
        // No pool and no DNS lookup: the already-vetted transport is the sole connection.
        createConnection: () => peer,
      }, (response) => {
        const headers = { ...response.headers, connection: "close" };
        delete headers["proxy-authenticate"];
        res.writeHead(response.statusCode ?? 502, headers);
        response.on("error", () => res.destroy());
        response.pipe(res);
      });
      outgoing.on("error", () => {
        if (res.headersSent) res.destroy();
        else { res.writeHead(502, { connection: "close" }); res.end(); }
      });
      // The CONNECT reader hands off paused, with any response remainder unshifted.
      outgoing.once("socket", () => peer.resume());
      req.on("error", () => outgoing.destroy());
      res.once("close", () => { outgoing.destroy(); peer.destroy(); });
      req.pipe(outgoing);
    }, (error) => {
      if (!res.destroyed) {
        res.writeHead(error instanceof Denied ? 403 : 502, { connection: "close" });
        res.end(error instanceof TunnelUnavailable ? "tunnel unavailable" : undefined);
      }
    });
  });
  server.on("upgrade", (req, client, head) => {
    if (!begin(client)) return;
    client.pause();
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (!["http:", "ws:"].includes(url.protocol) || url.username || url.password || req.headers.upgrade?.toLowerCase() !== "websocket") throw new Error();
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return;
    }
    void dial(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 80), client).then((peer) => {
      const outgoing = request({
        method: "GET", path: `${url.pathname}${url.search}`,
        headers: { ...originHeaders(req.headers, url.host), connection: "Upgrade", upgrade: "websocket" },
        createConnection: () => peer,
      });
      const timer = setTimeout(() => outgoing.destroy(), PROXY_HANDSHAKE_TIMEOUT_MS);
      timer.unref();
      client.once("close", () => { clearTimeout(timer); outgoing.destroy(); });
      outgoing.once("socket", () => peer.resume());
      outgoing.on("error", () => { clearTimeout(timer); if (!client.destroyed) client.end(badGateway); });
      outgoing.once("response", (response) => { response.destroy(); outgoing.destroy(); if (!client.destroyed) client.end(badGateway); });
      outgoing.once("upgrade", (response, socket, responseHead) => {
        clearTimeout(timer);
        if (client.destroyed) { socket.destroy(); return; }
        socket.on("error", () => client.destroy());
        socket.once("close", () => client.destroy());
        client.write("HTTP/1.1 101 Switching Protocols\r\n");
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          if (!response.rawHeaders[i].toLowerCase().startsWith("proxy-")) client.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
        }
        client.write("\r\n");
        if (responseHead.length) client.write(responseHead);
        if (head.length) socket.write(head);
        client.pipe(socket);
        socket.pipe(client);
      });
      outgoing.end();
    }, (error) => {
      if (!client.destroyed) client.end(error instanceof Denied ? "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n" : badGateway);
    });
  });
  server.on("connection", (client) => {
    track(client);
    const timer = setTimeout(() => client.destroy(), PROXY_HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    headerTimers.set(client, timer);
    client.once("close", () => clearTimeout(timer));
  });
  server.on("clientError", (_error, client) => {
    client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("error", () => log.warn("egress server error"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("egress proxy failed to bind");
  return { port: address.port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
