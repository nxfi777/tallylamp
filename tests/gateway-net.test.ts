import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";
import { dialGateway, gatewayIsConnected } from "../src/gateways.js";

/**
 * The real client carrying real traffic to a real site, with the real egress policy in front of
 * it. Needs the internet, so it is not in `npm test`: run `npm run test:gateway-net`.
 */
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/tallylamp.mjs");

function traceIp(text: string): string | null {
  return /^ip=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
}

/** CONNECT through the egress proxy, then TLS to the site over that tunnel, then one GET. */
function httpsThrough(proxyPort: number, host: string, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const raw = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    let head = "";
    raw.once("connect", () => raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    raw.on("error", reject);
    const onHead = (d: Buffer) => {
      head += d.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      raw.removeListener("data", onHead);
      if (!/^HTTP\/1\.1 200/.test(head)) return reject(new Error(`CONNECT refused: ${head.split("\r\n")[0]}`));
      const secure = tls.connect({ socket: raw, servername: host }, () => {
        secure.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      // latin1 keeps one character per byte, so lengths below are byte counts.
      const chunks: Buffer[] = [];
      secure.on("data", (c: Buffer) => chunks.push(c));
      secure.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      secure.on("error", reject);
    };
    raw.on("data", onHead);
  });
}

describe("gateway over the internet", () => {
  let ctx: TestCtx;
  let child: ChildProcess;
  let proxy: EgressProxy;
  let gatewayId: string;

  before(async () => {
    ctx = await startTestServer();
    const made = await json(`${ctx.url}/api/v1/gateways`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Network test" }),
    });
    const body = made.body as { gateway: { id: string }; token: string };
    gatewayId = body.gateway.id;
    child = spawn(process.execPath, [cli, "gateway", "--allow-sleep"], {
      env: { ...process.env, TALLYLAMP_URL: ctx.url, TALLYLAMP_GATEWAY_TOKEN: body.token },
      stdio: "ignore",
    });
    const start = Date.now();
    while (!gatewayIsConnected(gatewayId)) {
      if (Date.now() - start > 10_000) throw new Error("the gateway did not connect");
      await new Promise((r) => setTimeout(r, 25));
    }
    proxy = await startEgressProxy({ gateway: (address, port) => dialGateway(gatewayId, address, port) });
  });
  after(async () => {
    await proxy?.close();
    child?.kill();
    await ctx.close();
  });

  it("reaches a site over HTTPS from this computer's address", async () => {
    const via = await httpsThrough(proxy.port, "www.cloudflare.com", "/cdn-cgi/trace");
    assert.match(via, /^HTTP\/1\.1 200/);
    const direct = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    assert.ok(traceIp(via), via.slice(0, 300));
    assert.equal(traceIp(via), traceIp(direct), "the site saw the gateway computer's own address");
  });

  it("carries plain http too", async () => {
    const res = await new Promise<string>((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port: proxy.port });
      let out = "";
      s.on("data", (d) => (out += d.toString()));
      s.on("error", reject);
      s.on("close", () => resolve(out));
      s.once("connect", () => s.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"));
    });
    assert.match(res, /^HTTP\/1\.1 (200|30\d)/);
  });

  it("downloads more than its buffers hold without dropping a byte", async () => {
    // 2.5 MB, chunked over many frames: exercises the client's pause-and-resume path.
    const via = await httpsThrough(proxy.port, "speed.cloudflare.com", "/__down?bytes=2500000");
    const split = via.indexOf("\r\n\r\n");
    const head = via.slice(0, split);
    assert.match(head, /^HTTP\/1\.1 200/);
    const length = /content-length:\s*(\d+)/i.exec(head)?.[1];
    assert.ok(length, `expected a content-length, got:\n${head}`);
    assert.equal(via.length - split - 4, Number(length), "every byte of the body arrived");
    assert.equal(Number(length), 2_500_000);
  });
});
