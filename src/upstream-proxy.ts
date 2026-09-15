import { createConnection, isIP, type Socket } from "node:net";
import { connect as connectTls, checkServerIdentity } from "node:tls";
import type { BrowserProxy } from "./browser-proxy.js";
import { resolveVetted } from "./ssrf.js";

export const PROXY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const PROXY_MAX_HEADER_BYTES = 16_384;
const unavailable = () => new Error("upstream proxy unavailable");

export function ipAuthority(address: string, port: number): string {
  return `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

/** The destination must already be vetted and pinned. Never ask the proxy to resolve it. */
export async function dialUpstreamProxy(
  proxy: BrowserProxy,
  address: string,
  port: number,
  signal?: AbortSignal,
): Promise<Socket> {
  if (!isIP(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw unavailable();
  // Keep DNS resolution within the same timeout/cancellation budget as TCP/TLS/CONNECT.
  return new Promise<Socket>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    const timer = setTimeout(fail, PROXY_HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      socket?.removeListener("data", onData);
      socket?.removeListener("close", fail);
    }
    function fail() {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.destroy();
      reject(unavailable());
    }
    let header = Buffer.alloc(0);
    function onData(chunk: Buffer) {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        if (header.length > PROXY_MAX_HEADER_BYTES) fail();
        return;
      }
      if (end + 4 > PROXY_MAX_HEADER_BYTES || !/^HTTP\/1\.[01] 200(?: |\r\n)/.test(header.toString("latin1", 0, end + 2))) {
        fail();
        return;
      }
      settled = true;
      socket!.pause();
      cleanup();
      if (header.length > end + 4) socket!.unshift(header.subarray(end + 4));
      resolve(socket!);
    }
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted) { fail(); return; }
    void (async () => {
      const url = new URL(proxy.server);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw unavailable();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const vetted = await resolveVetted(hostname);
      if (settled) return;
      if (!vetted.ok || !vetted.addresses[0]) throw unavailable();
      const options = { host: vetted.addresses[0].address, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
      socket = url.protocol === "https:"
        ? connectTls({
          ...options,
          rejectUnauthorized: true,
          servername: isIP(hostname) ? undefined : hostname,
          // TCP uses the pinned IP; certificate identity always uses the original name.
          checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
        })
        : createConnection(options);
      // Retained after handoff, so an error in the promise/pipe handoff cannot be unhandled.
      socket.on("error", fail);
      socket.once("close", fail);
      socket.on("data", onData);
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
        if (settled) return;
        const authority = ipAuthority(address, port);
        const auth = proxy.username !== undefined || proxy.password !== undefined
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`, "utf8").toString("base64")}\r\n`
          : "";
        socket!.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
      });
    })().catch(fail);
  });
}
