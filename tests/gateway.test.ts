import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { startEgressProxy } from "../src/egress-proxy.js";
import { dialGateway, gatewayIsConnected, GATEWAY_PROTOCOL, TOKEN_PROTOCOL_PREFIX, CLOSE_REJECTED, CLOSE_REPLACED } from "../src/gateways.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/tallylamp.mjs");
let ctx: TestCtx;

const admin = (endpoint: string, method = "GET", body?: unknown) =>
  json(`${ctx.url}/api/v1${endpoint}`, {
    method,
    headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function addGateway(name: string): Promise<{ id: string; token: string; command: string }> {
  const res = await admin("/gateways", "POST", { name });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const body = res.body as { gateway: { id: string }; token: string; command: string };
  return { id: body.gateway.id, token: body.token, command: body.command };
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The gateway's half of the protocol with no address policy, so it can reach servers on this
 * machine. It records every authority it was asked for, which is how pinning is checked.
 */
function fakeGateway(token: string): { ws: WebSocket; asked: string[]; closed: Promise<{ code: number; reason: string }> } {
  const ws = new WebSocket(`${ctx.url.replace(/^http/, "ws")}/api/v1/gateways/connect`, [GATEWAY_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`]);
  const asked: string[] = [];
  const streams = new Map<number, net.Socket>();
  const send = (type: number, id: number, payload?: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const body = payload ?? Buffer.alloc(0);
    const out = Buffer.allocUnsafe(5 + body.length);
    out.writeUInt8(type, 0);
    out.writeUInt32BE(id, 1);
    body.copy(out, 5);
    ws.send(out);
  };
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const type = buf.readUInt8(0);
    const id = buf.readUInt32BE(1);
    const payload = buf.subarray(5);
    if (type === 0x01) {
      const authority = payload.toString("utf8");
      asked.push(authority);
      const m = /^(.+):(\d+)$/.exec(authority)!;
      const sock = net.createConnection({ host: m[1], port: Number(m[2]) });
      streams.set(id, sock);
      sock.once("connect", () => send(0x04, id));
      sock.on("data", (c) => send(0x02, id, c));
      sock.on("error", (e) => send(0x05, id, Buffer.from(e.message)));
      sock.on("close", () => {
        if (streams.delete(id)) send(0x03, id);
      });
      return;
    }
    const sock = streams.get(id);
    if (!sock) return;
    if (type === 0x02) sock.write(payload);
    else if (type === 0x03) {
      streams.delete(id);
      sock.end();
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => {
      for (const s of streams.values()) s.destroy();
      resolve({ code, reason: reason.toString() });
    });
  });
  return { ws, asked, closed };
}

/** Raw bytes in, everything that came back out. */
function throughProxy(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    let out = "";
    s.on("data", (d) => {
      out += d.toString();
    });
    s.on("error", reject);
    s.on("close", () => resolve(out));
    s.once("connect", () => s.write(request));
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, 4000).unref();
  });
}

function runCli(env: Record<string, string>, args: string[]): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [cli, "gateway", "--allow-sleep", ...args], {
    env: { ...process.env, TALLYLAMP_URL: ctx.url, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout!.on("data", (d) => (text += d));
  child.stderr!.on("data", (d) => (text += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output: () => text, exited };
}

describe("gateways", () => {
  let target: http.Server;
  let targetPort: number;
  let hits = 0;
  let originalPrivate: string | undefined;

  before(async () => {
    ctx = await startTestServer();
    process.env.TALLYLAMP_MAX_BROWSERS = "12";
    // The vetting before a gateway is the ordinary egress policy. Opening it to loopback lets
    // these tests use a server on this machine as "the site"; the fake gateway has no policy.
    originalPrivate = process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK;
    process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = "true";
    target = http.createServer((req, res) => {
      hits++;
      res.end(`site answered ${req.method} ${req.url}`);
    });
    // Every interface, both families: whichever address "localhost" pins to, it answers.
    await new Promise<void>((resolve) => target.listen(0, () => resolve()));
    targetPort = (target.address() as net.AddressInfo).port;
  });
  after(async () => {
    if (originalPrivate === undefined) delete process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK;
    else process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = originalPrivate;
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await ctx.close();
  });

  it("is the operator's alone to add, list and remove", async () => {
    const agent = { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" };
    const denied = await json(`${ctx.url}/api/v1/gateways`, { method: "POST", headers: agent, body: JSON.stringify({ name: "Agent box" }) });
    assert.equal(denied.status, 403);
    assert.equal((await json(`${ctx.url}/api/v1/gateways`, { headers: agent })).status, 403);

    const made = await addGateway("Studio Mac");
    assert.match(made.token, /^tl_gw_/);
    assert.ok(made.command.includes("/tallylamp.mjs"), made.command);
    assert.ok(made.command.includes(`TALLYLAMP_GATEWAY_TOKEN=${made.token}`), made.command);
    assert.equal((await admin("/gateways", "POST", { name: "studio mac" })).status, 409, "names are unique, ignoring case");
    assert.equal((await admin("/gateways", "POST", { name: "  " })).status, 400);

    const list = (await admin("/gateways")).body as { gateways: Array<Record<string, unknown>> };
    const row = list.gateways.find((g) => g.id === made.id)!;
    assert.equal(row.online, false);
    assert.ok(!JSON.stringify(list).includes(made.token), "the token is shown once, at creation");

    assert.equal((await admin(`/gateways/${made.id}`, "DELETE")).status, 200);
    assert.equal(((await admin("/gateways")).body as { gateways: unknown[] }).gateways.some((g) => (g as { id: string }).id === made.id), false);
  });

  it("serves its own command-line client, so a gateway needs no checkout", async () => {
    const res = await fetch(`${ctx.url}/tallylamp.mjs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.match(await res.text(), /async function runGateway/);
  });

  it("connects with its token in a header, and closes a bad one with a code the client stops on", async () => {
    const gw = await addGateway("Header check");
    const good = fakeGateway(gw.token);
    await until(() => gatewayIsConnected(gw.id), "the gateway to connect");
    assert.equal(good.ws.protocol, GATEWAY_PROTOCOL, "the token protocol is never echoed back");

    const bad = fakeGateway("tl_gw_not-a-real-token");
    const refused = await bad.closed;
    assert.equal(refused.code, CLOSE_REJECTED);

    // A second copy with the same token wins, and the first is told why it lost.
    const second = fakeGateway(gw.token);
    const first = await good.closed;
    assert.equal(first.code, CLOSE_REPLACED);
    await until(() => second.ws.readyState === WebSocket.OPEN, "the replacement to open");
    assert.ok(gatewayIsConnected(gw.id));
    second.ws.close();
    await second.closed;
    await until(() => !gatewayIsConnected(gw.id), "the gateway to drop");
  });

  it("carries plain http, CONNECT and the pinned address, never the name", async () => {
    const gw = await addGateway("Data path");
    const fake = fakeGateway(gw.token);
    await until(() => gatewayIsConnected(gw.id), "the gateway to connect");
    const proxy = await startEgressProxy({ gateway: (address, port) => dialGateway(gw.id, address, port) });
    try {
      const plain = await throughProxy(proxy.port, `GET http://localhost:${targetPort}/plain HTTP/1.1\r\nHost: localhost:${targetPort}\r\nConnection: close\r\n\r\n`);
      assert.match(plain, /^HTTP\/1\.1 200/);
      assert.match(plain, /site answered GET \/plain/);

      const tunnelled = await new Promise<string>((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port: proxy.port });
        let out = "";
        let established = false;
        s.on("data", (d) => {
          out += d.toString();
          if (!established && out.includes("\r\n\r\n")) {
            established = true;
            assert.match(out, /^HTTP\/1\.1 200 Connection Established/);
            out = "";
            s.write(`GET /inside HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
          }
        });
        s.on("error", reject);
        s.on("close", () => resolve(out));
        s.once("connect", () => s.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\nHost: localhost:${targetPort}\r\n\r\n`));
      });
      assert.match(tunnelled, /site answered GET \/inside/);

      assert.equal(fake.asked.length, 2);
      for (const authority of fake.asked) {
        const host = authority.slice(0, authority.lastIndexOf(":"));
        assert.ok(net.isIP(host), `the gateway was asked for ${authority}; it must only ever get an address`);
      }
    } finally {
      await proxy.close();
      fake.ws.close();
      await fake.closed;
    }
  });

  it("fails closed: with its gateway offline a browser gets a 502, never the direct route", async () => {
    const gw = await addGateway("Asleep");
    const proxy = await startEgressProxy({ gateway: (address, port) => dialGateway(gw.id, address, port) });
    try {
      const before = hits;
      const plain = await throughProxy(proxy.port, `GET http://127.0.0.1:${targetPort}/x HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
      assert.match(plain, /^HTTP\/1\.1 502/);
      assert.match(plain, /through the gateway Asleep, which is not connected/);
      const connect = await throughProxy(proxy.port, `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
      assert.match(connect, /^HTTP\/1\.1 502/);
      assert.equal(hits, before, "nothing reached the site by any other route");
    } finally {
      await proxy.close();
    }
  });

  it("is assigned by the operator to a stopped browser on the main instance, instead of a proxy", async () => {
    const gw = await addGateway("Assigned");
    const created = await admin("/browsers", "POST", { name: "gateway browser", start: false });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { browser: { id: string } }).browser.id;

    const asAgent = await json(`${ctx.url}/api/v1/browsers/${id}/gateway`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ gatewayId: gw.id }),
    });
    assert.equal(asAgent.status, 403);
    assert.equal((await admin(`/browsers/${id}/gateway`, "PUT", { gatewayId: "nope" })).status, 404);

    const set = await admin(`/browsers/${id}/gateway`, "PUT", { gatewayId: gw.id });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual((set.body as { browser: { gateway: unknown } }).browser.gateway, { id: gw.id, name: "Assigned", online: false });

    // One route out at a time, either way round.
    assert.equal((await admin(`/browsers/${id}`, "PATCH", { proxy: { server: "http://proxy.example:8080" } })).status, 409);
    // Not onto a worker, whose egress cannot reach a gateway connected here.
    const move = await admin(`/browsers/${id}/move`, "POST", { workerId: "any-worker" });
    assert.equal(move.status, 409);
    assert.match(JSON.stringify(move.body), /gateway/);
    // Not removed from under the browser using it.
    const removal = await admin(`/gateways/${gw.id}`, "DELETE");
    assert.equal(removal.status, 409);
    assert.match(JSON.stringify(removal.body), /gateway browser/);

    // Read at launch, so a running browser must be stopped first.
    assert.equal((await admin(`/browsers/${id}/start`, "POST")).status, 200);
    assert.equal((await admin(`/browsers/${id}/gateway`, "PUT", { gatewayId: null })).status, 409);
    await admin(`/browsers/${id}/stop`, "POST");
    const cleared = await admin(`/browsers/${id}/gateway`, "PUT", { gatewayId: null });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as { browser: { gateway: unknown } }).browser.gateway, null);
    assert.equal((await admin(`/gateways/${gw.id}`, "DELETE")).status, 200);

    const proxied = await admin("/browsers", "POST", { name: "proxied browser", start: false, proxy: { server: "http://proxy.example:8080" } });
    const proxiedId = (proxied.body as { browser: { id: string } }).browser.id;
    const other = await addGateway("Other");
    assert.equal((await admin(`/browsers/${proxiedId}/gateway`, "PUT", { gatewayId: other.id })).status, 409);
  });

  it("runs as the real client, refusing this computer's network and ports other than the web's", async () => {
    const gw = await addGateway("Real client");
    const run = runCli({ TALLYLAMP_GATEWAY_TOKEN: gw.token }, []);
    try {
      await until(() => gatewayIsConnected(gw.id), "the CLI to connect", 10_000);
      await assert.rejects(dialGateway(gw.id, "127.0.0.1", 443), /private network/);
      await assert.rejects(dialGateway(gw.id, "192.168.1.1", 443), /private network/);
      await assert.rejects(dialGateway(gw.id, "8.8.8.8", 25), /port 25 is not allowed/);
      const listed = await admin("/gateways");
      const mine = (listed.body as { gateways: Array<{ id: string; online: boolean }> }).gateways.find((g) => g.id === gw.id)!;
      assert.equal(mine.online, true);
      // Removing it ends the client for good, with a reason, rather than leaving it retrying.
      assert.equal((await admin(`/gateways/${gw.id}`, "DELETE")).status, 200);
      assert.equal(await run.exited, 1);
      assert.match(run.output(), /removed in the Tallylamp dashboard/);
    } finally {
      run.child.kill();
    }
  });

  it("reports itself after connecting, so the operator can see which computer it is", async () => {
    const gw = await addGateway("Hello check");
    const run = runCli({ TALLYLAMP_GATEWAY_TOKEN: gw.token }, []);
    try {
      await until(() => gatewayIsConnected(gw.id), "the CLI to connect", 10_000);
      let client: { hostname?: string; platform?: string; ports?: number[] } | null = null;
      const start = Date.now();
      while (!client && Date.now() - start < 5000) {
        const listed = await admin("/gateways");
        client = (listed.body as { gateways: Array<{ id: string; client: typeof client }> }).gateways.find((g) => g.id === gw.id)!.client;
        if (!client) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(client, "the hello arrived");
      assert.equal(client!.hostname, os.hostname().slice(0, 80));
      assert.equal(client!.platform, process.platform);
      assert.deepEqual(client!.ports, [80, 443]);
    } finally {
      run.child.kill();
      await run.exited;
    }
  });

  it("stops at once on a rejected token instead of retrying for ever", async () => {
    const run = runCli({ TALLYLAMP_GATEWAY_TOKEN: "tl_gw_wrong" }, []);
    try {
      assert.equal(await run.exited, 1);
      assert.match(run.output(), /rejected this gateway's token/);
    } finally {
      run.child.kill();
    }
  });
});
