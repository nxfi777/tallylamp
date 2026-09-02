import { createServer, type Socket } from "node:net";
import { createConnection } from "node:net";
import { checkDestination, parseAuthority } from "./ssrf.js";
import { log } from "./log.js";

export type EgressProxy = {
  port: number;
  close: () => Promise<void>;
};

/**
 * HTTP CONNECT proxy. Chrome still performs destination TLS itself.
 * Private/link-local/metadata destinations are refused after DNS resolution.
 */
export async function startEgressProxy(): Promise<EgressProxy> {
  const server = createServer();
  const sockets = new Set<Socket>();

  server.on("connection", (client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.once("data", async (buf) => {
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
      const verdict = await checkDestination(authority.host, authority.port);
      if (!verdict.ok) {
        log.warn("egress denied", { host: authority.host, port: authority.port, reason: verdict.reason });
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = createConnection({ host: authority.host, port: authority.port });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => {
        try {
          client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        } catch {
          /* ignore */
        }
      });
      upstream.once("connect", () => {
        if (connect) {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          client.pipe(upstream);
          upstream.pipe(client);
        } else {
          upstream.write(buf);
          client.pipe(upstream);
          upstream.pipe(client);
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("egress proxy failed to bind");
  log.info("egress proxy listening", { port: addr.port });
  return {
    port: addr.port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
