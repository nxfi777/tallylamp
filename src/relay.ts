import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type RelayTarget = {
  host: string;
  port: number;
  path: string;
  /** Replaces the request's headers of the same name. Undefined removes one. */
  headers?: Record<string, string | undefined>;
};

/** Headers that describe one hop and must not be carried to the next. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function carried(from: IncomingHttpHeaders, target: RelayTarget, keepUpgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k) && !(keepUpgrade && (k === "connection" || k === "upgrade"))) continue;
    out[k] = v;
  }
  out.host = `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
  for (const [k, v] of Object.entries(target.headers ?? {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * Pass one HTTP request on to `target` and its response back. Used on both legs between a
 * browser's debugging port on a worker and whatever on the main instance is driving it.
 */
export function forwardHttp(req: IncomingMessage, res: ServerResponse, target: RelayTarget, timeoutMs = 30_000): void {
  const up = http.request(
    { host: target.host, port: target.port, path: target.path, method: req.method, headers: carried(req.headers, target, false), timeout: timeoutMs },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("timeout", () => up.destroy(new Error("relay timed out")));
  up.on("error", (e) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "relay_failed", message: e.message, retryable: true } }));
  });
  req.pipe(up);
}

/**
 * Pass a WebSocket upgrade on to `target` and join the two sockets. Nothing in between reads
 * the frames: whatever the two ends negotiate, compression included, is theirs.
 */
export function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: RelayTarget): void {
  const refuse = (status: number, text: string) => {
    if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const up = http.request({
    host: target.host,
    port: target.port,
    path: target.path,
    method: "GET",
    headers: carried(req.headers, target, true),
  });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 101 ${upRes.statusMessage || "Switching Protocols"}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const end = () => {
      upSocket.destroy();
      socket.destroy();
    };
    for (const s of [upSocket, socket]) {
      s.on("error", end);
      s.on("close", end);
    }
  });
  // The far end answered without upgrading: it refused, and said why in its status.
  up.on("response", (upRes) => {
    upRes.resume();
    refuse(upRes.statusCode ?? 502, upRes.statusMessage || "Bad Gateway");
  });
  up.on("error", () => refuse(502, "Bad Gateway"));
  socket.on("error", () => up.destroy());
  up.end();
}
