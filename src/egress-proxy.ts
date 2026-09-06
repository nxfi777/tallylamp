import { createServer, type Socket } from "node:net";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { parseAuthority, resolveVetted } from "./ssrf.js";
import { log } from "./log.js";

export type EgressProxy = {
  port: number;
  close: () => Promise<void>;
};

/**
 * Answers with a stream when this browser has a tunnel bound to the authority, null when it
 * has none. Throwing means "bound, but not reachable" -- a distinction worth keeping,
 * because falling through would turn a broken tunnel into a confusing SSRF refusal.
 */
export type TunnelDialer = (host: string, port: number) => Promise<Duplex | null>;

export type EgressOptions = {
  /** Whose proxy this is. One listener per browser, so a tunnel binding is attributable. */
  browserId?: string;
  dial?: TunnelDialer;
};

/**
 * HTTP CONNECT proxy. Chrome still performs destination TLS itself.
 * Private/link-local/metadata destinations are refused after DNS resolution.
 */
export async function startEgressProxy(opts: EgressOptions = {}): Promise<EgressProxy> {
  const server = createServer();
  const sockets = new Set<Socket>();

  async function handleRequest(client: Socket, buf: Buffer): Promise<void> {
    // Attaching a 'data' listener put the socket in flowing mode, and everything below this
    // awaits -- a DNS lookup, or a tunnel open round trip. Anything the client sent in that
    // window would be emitted to nobody and lost. pipe() resumes it.
    client.pause();
    const head = buf.toString("utf8");
    const first = head.split("\r\n")[0] ?? "";
    const connect = first.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]/i);
    const http = first.match(/^(GET|POST|HEAD|PUT|DELETE|PATCH|OPTIONS)\s+(\S+)\s+HTTP\/1\.[01]/i);

    let authority: { host: string; port: number } | null = null;
    if (connect) {
      authority = parseAuthority(connect[1]);
    } else if (http) {
      try {
        const u = new URL(http[2]);
        authority = { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
      } catch {
        authority = null;
      }
    }
    if (!authority) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }

    // Tunnels are consulted first and are the only way a private destination is ever
    // reached. A binding that does not exist returns null and falls through to the check
    // below, which refuses -- so a lookup miss fails closed rather than dialling.
    if (opts.dial) {
      let tunnel: Duplex | null = null;
      try {
        tunnel = await opts.dial(authority.host, authority.port);
      } catch (e) {
        log.warn("tunnel dial failed", {
          browserId: opts.browserId,
          host: authority.host,
          port: authority.port,
          error: (e as Error).message,
        });
        // Deliberately not the dial error: the page asking is untrusted, and "a tunnel is
        // bound to this authority but offline" would let any site probe for which private
        // addresses the operator has open. The detail goes to the log instead.
        client.end(
          "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\ntunnel unavailable",
        );
        return;
      }
      if (tunnel) {
        if (client.destroyed) {
          tunnel.destroy();
          return;
        }
        if (connect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else tunnel.write(buf);
        client.pipe(tunnel);
        client.resume();
        tunnel.pipe(client);
        tunnel.on("error", (e) => {
          log.warn("tunnel stream error", { browserId: opts.browserId, error: (e as Error).message });
          if (!client.destroyed) client.destroy();
        });
        client.on("close", () => tunnel.destroy());
        tunnel.on("close", () => client.destroy());
        return;
      }
    }

    // Resolve once and connect to the address that was vetted, rather than re-resolving the
    // name on the way out. Checking a name and then dialling the same name is two separate
    // lookups, and a record with a short TTL can answer public for the first and private for
    // the second -- which reaches a refused destination with no binding involved at all.
    const vetted = await resolveVetted(authority.host);
    if (!vetted.ok) {
      log.warn("egress denied", { host: authority.host, port: authority.port, reason: vetted.reason });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (client.destroyed) return;
    const pinned = vetted.addresses[0];
    if (!pinned) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    const upstream = createConnection({ host: pinned.address, port: authority.port });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", (e) => {
      log.warn("egress upstream error", { host: authority.host, error: (e as Error).message });
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.once("connect", () => {
      if (connect) {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } else {
        upstream.write(buf);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    // Tear down the peer when either side goes away, so a half-open pair cannot leak.
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  server.on("connection", (client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    // A proxy client resetting mid-request is routine: a closed tab, a cancelled request,
    // a keepalive expiring. Without a listener that 'error' event is unhandled and takes
    // the whole process down, so any site Chrome talks to could kill the server.
    client.on("error", (e) => {
      log.warn("egress client error", { error: (e as Error).message });
      client.destroy();
    });
    client.once("data", (buf) => {
      handleRequest(client, buf).catch((e) => {
        log.warn("egress request failed", { error: (e as Error).message });
        client.destroy();
      });
    });
  });

  server.on("error", (e) => log.warn("egress server error", { error: (e as Error).message }));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("egress proxy failed to bind");
  log.info("egress proxy listening", { port: addr.port, browserId: opts.browserId });
  return {
    port: addr.port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
