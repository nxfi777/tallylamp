import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { WebSocket } from "ws";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";
import { dialTunnel, closeAllTunnels } from "../src/tunnels.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { requestBrowser, answerRequest, activeGrant } from "../src/lending.js";
import { createTunnel, listTunnels, tunnelIsConnected } from "../src/tunnels.js";

let ctx: TestCtx;

/** The client half of the tunnel protocol — what bin/tallylamp.mjs runs on the user's box. */
function attachTunnelClient(wsUrl: string, host: string, port: number): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
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
  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (buf.length < 5) return;
    const type = buf.readUInt8(0);
    const id = buf.readUInt32BE(1);
    const payload = buf.subarray(5);
    if (type === 0x01) {
      if (payload.toString("utf8") !== `${host}:${port}`) {
        send(0x05, id, Buffer.from("wrong authority"));
        return;
      }
      const sock = net.createConnection({ host, port });
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
  ws.on("close", () => {
    for (const s of streams.values()) s.destroy();
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** One request through the egress proxy, in the absolute-URI form Chrome uses for http. */
function proxyGet(proxy: EgressProxy, host: string, port: number, path = "/"): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port: proxy.port });
    let out = "";
    s.on("data", (d) => {
      out += d.toString();
    });
    s.on("error", reject);
    s.on("close", () => resolve(out));
    s.once("connect", () => {
      s.write(`GET http://${host}:${port}${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, 4000).unref();
  });
}

async function newBrowser(token: string): Promise<string> {
  const res = await json(`${ctx.url}/api/v1/browsers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "tunnel test" }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (res.body as { browser: { id: string } }).browser.id;
}

describe("loopback tunnels", () => {
  let scoped: string;
  let unscoped: string;

  before(async () => {
    ctx = await startTestServer();
    // config reads env lazily, so this raises the cap for this file only. Each test wants a
    // fresh browser and the default fleet is 4.
    process.env.TALLYLAMP_MAX_BROWSERS = "12";
    scoped = createAgent({ name: "Tunneller", scopes: ["browser:create", "browser:read:own", "browser:control:own", "browser:tunnel"], maxBrowsers: 6 }).token;
    unscoped = createAgent({ name: "No tunnels" }).token;
  });
  after(async () => {
    closeAllTunnels();
    await ctx.close();
  });

  it("is not a default scope, so an ordinary agent cannot open one", async () => {
    const id = await newBrowser(unscoped);
    const res = await json(`${ctx.url}/api/v1/browsers/${id}/tunnels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${unscoped}`, "Content-Type": "application/json" },
      body: JSON.stringify({ port: 4321 }),
    });
    assert.equal(res.status, 403);
    assert.match(JSON.stringify(res.body), /browser:tunnel/);
  });

  it("refuses a public authority, which would shadow the real site for that browser", async () => {
    const id = await newBrowser(scoped);
    for (const host of ["example.com", "8.8.8.8"]) {
      const res = await json(`${ctx.url}/api/v1/browsers/${id}/tunnels`, {
        method: "POST",
        headers: { Authorization: `Bearer ${scoped}`, "Content-Type": "application/json" },
        body: JSON.stringify({ host, port: 443 }),
      });
      assert.equal(res.status, 400, `${host} should be refused`);
      assert.match(JSON.stringify(res.body), /loopback or private/);
    }
  });

  it("carries a real request from the browser's proxy to a server on this machine", async () => {
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello from the laptop");
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
    const port = (origin.address() as net.AddressInfo).port;

    const browserId = await newBrowser(scoped);
    const made = await json(`${ctx.url}/api/v1/browsers/${browserId}/tunnels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${scoped}`, "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { tunnel, token } = made.body as { tunnel: { id: string }; token: string };

    const proxy = await startEgressProxy({
      browserId,
      dial: (h, p) => dialTunnel(browserId, h, p),
    });

    // Bound, but nothing is connected: a clear 502, not a silent SSRF refusal.
    const offline = await proxyGet(proxy, "127.0.0.1", port);
    assert.match(offline, /502 Bad Gateway/);
    // Generic on purpose: naming the binding would let any page enumerate the operator's
    // private authorities. The detail belongs in the log.
    assert.match(offline, /tunnel unavailable/);
    assert.doesNotMatch(offline, /127\.0\.0\.1/);

    const ws = await attachTunnelClient(
      `${ctx.url.replace(/^http/, "ws")}/api/v1/tunnels/${tunnel.id}/connect?token=${encodeURIComponent(token)}`,
      "127.0.0.1",
      port,
    );

    const live = await proxyGet(proxy, "127.0.0.1", port);
    assert.match(live, /200 OK/);
    assert.match(live, /hello from the laptop/);

    // A different private port on the same browser has no binding, so the ordinary policy
    // answers: the tunnel widens nothing beyond the authority it was created for.
    const unbound = await proxyGet(proxy, "127.0.0.1", port + 1);
    assert.match(unbound, /403 Forbidden/);

    // And another browser cannot ride this binding at all.
    const otherProxy = await startEgressProxy({
      browserId: "some-other-browser",
      dial: (h, p) => dialTunnel("some-other-browser", h, p),
    });
    const crossed = await proxyGet(otherProxy, "127.0.0.1", port);
    assert.match(crossed, /403 Forbidden/);

    // Revoking cuts it immediately.
    const del = await json(`${ctx.url}/api/v1/tunnels/${tunnel.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${scoped}` },
    });
    assert.equal(del.status, 204);
    const after = await proxyGet(proxy, "127.0.0.1", port);
    assert.match(after, /403 Forbidden/);

    ws.close();
    await otherProxy.close();
    await proxy.close();
    await new Promise<void>((r) => origin.close(() => r()));
  });

  it("works with the real CLI client, not just a reimplementation of it", async () => {
    // The client half lives in bin/tallylamp.mjs and is the piece most likely to drift from
    // the framing in src/tunnels.ts, so it is exercised as an actual subprocess.
    const origin = http.createServer((_req, res) => res.end("served over the real client"));
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
    const port = (origin.address() as net.AddressInfo).port;

    const browserId = await newBrowser(scoped);
    const made = await json(`${ctx.url}/api/v1/browsers/${browserId}/tunnels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${scoped}`, "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    const { tunnel, token } = made.body as { tunnel: { id: string }; token: string };

    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/tallylamp.mjs");
    const child = spawn(
      process.execPath,
      [cli, "tunnel", String(port), "--host", "127.0.0.1", "--tunnel-id", tunnel.id, "--tunnel-token", token],
      { env: { ...process.env, TALLYLAMP_URL: ctx.url }, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("cli did not connect in time")), 10_000);
        child.stderr.on("data", (d: Buffer) => {
          if (d.toString().includes("now reachable")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", (code) => reject(new Error(`cli exited early with ${code}`)));
      });

      const proxy = await startEgressProxy({ browserId, dial: (h, p) => dialTunnel(browserId, h, p) });
      const body = await proxyGet(proxy, "127.0.0.1", port);
      assert.match(body, /200 OK/);
      assert.match(body, /served over the real client/);
      await proxy.close();
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((r) => origin.close(() => r()));
    }
  });

  it("closes a browser's tunnels when it is lent, so the borrower cannot inherit them", async () => {
    // A binding is keyed on the browser, not on who is driving it. Ownership at create time
    // is therefore not enough on its own: without this, granting afterwards silently hands
    // the borrower a browser that can already reach the owner's machine.
    const owner = createAgent({ name: "tunnel owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend", "browser:tunnel"], maxBrowsers: 5 });
    const borrower = createAgent({ name: "tunnel borrower", scopes: [...DEFAULT_AGENT_SCOPES, "browser:borrow"], maxBrowsers: 5 });
    const row = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "lent-with-a-tunnel" });

    const origin = http.createServer((_req, res) => res.end("the owner's laptop"));
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
    const port = (origin.address() as net.AddressInfo).port;

    const { row: tun, token } = createTunnel(ctx.browsers, owner.agent, { browserId: row.id, port });
    const ws = await attachTunnelClient(
      `${ctx.url.replace(/^http/, "ws")}/api/v1/tunnels/${tun.id}/connect?token=${encodeURIComponent(token)}`,
      "127.0.0.1",
      port,
    );
    assert.equal(tunnelIsConnected(tun.id), true);

    const asked = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    assert.equal(asked.state, "pending");
    answerRequest(ctx.browsers, owner.agent, { requestId: (asked as { requestId: string }).requestId, decision: "grant" });
    assert.ok(activeGrant(row.id, borrower.agent.id), "the grant should exist");

    // The binding is gone and the socket with it, so the borrower has nothing to inherit.
    assert.deepEqual(listTunnels(row.id), []);
    assert.equal(tunnelIsConnected(tun.id), false);

    const proxy = await startEgressProxy({ browserId: row.id, dial: (h, p) => dialTunnel(row.id, h, p) });
    const blocked = await proxyGet(proxy, "127.0.0.1", port);
    assert.match(blocked, /403 Forbidden/);
    await proxy.close();

    // And the other ordering: it cannot be re-opened while the borrower still holds it.
    assert.throws(
      () => createTunnel(ctx.browsers, owner.agent, { browserId: row.id, port }),
      /lent to another agent/,
    );

    ws.close();
    await new Promise<void>((r) => origin.close(() => r()));
  });

  it("does not let a borrower enumerate the owner's private authorities", async () => {
    const owner = createAgent({ name: "listing owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend", "browser:tunnel"], maxBrowsers: 5 });
    const borrower = createAgent({ name: "listing borrower", scopes: [...DEFAULT_AGENT_SCOPES, "browser:borrow"], maxBrowsers: 5 });
    const row = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "listing-test" });
    const asked = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    answerRequest(ctx.browsers, owner.agent, { requestId: (asked as { requestId: string }).requestId, decision: "grant" });

    const res = await json(`${ctx.url}/api/v1/browsers/${row.id}/tunnels`, {
      headers: { Authorization: `Bearer ${borrower.token}` },
    });
    assert.equal(res.status, 403);
    // The borrower can still read the browser itself; the tunnel list is simply absent.
    const detail = await json(`${ctx.url}/api/v1/browsers/${row.id}`, {
      headers: { Authorization: `Bearer ${borrower.token}` },
    });
    assert.equal(detail.status, 200);
    assert.deepEqual((detail.body as { tunnels: unknown[] }).tunnels, []);
  });

  it("refuses a connection with the wrong token", async () => {
    const browserId = await newBrowser(scoped);
    const made = await json(`${ctx.url}/api/v1/browsers/${browserId}/tunnels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${scoped}`, "Content-Type": "application/json" },
      body: JSON.stringify({ port: 5999 }),
    });
    const { tunnel } = made.body as { tunnel: { id: string } };
    await assert.rejects(
      attachTunnelClient(
        `${ctx.url.replace(/^http/, "ws")}/api/v1/tunnels/${tunnel.id}/connect?token=not-the-token`,
        "127.0.0.1",
        5999,
      ),
      (e) => e instanceof Error,
    );
  });

  it("still serves the viewer path, which shares the upgrade listener", async () => {
    const res = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${ctx.url.replace(/^http/, "ws")}/api/v1/browsers/nope/view?ticket=bad`);
      ws.on("error", () => resolve(401));
      ws.on("unexpected-response", (_req, r) => resolve(r.statusCode ?? 0));
      ws.on("open", () => {
        ws.close();
        resolve(200);
      });
    });
    assert.equal(res, 401);
  });
});
