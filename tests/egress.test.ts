import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";
import http from "node:http";
import tls from "node:tls";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { dialUpstreamProxy } from "../src/upstream-proxy.js";

let proxy: EgressProxy;

describe("egress proxy survives hostile clients", () => {
  before(async () => {
    proxy = await startEgressProxy();
  });
  after(async () => proxy.close());

  it("does not crash the process when a client resets mid-request", async () => {
    // Regression: an unhandled 'error' event on the client socket used to be fatal, so a
    // routine ECONNRESET from Chrome killed the whole server.
    for (let i = 0; i < 20; i++) {
      const s = net.createConnection({ host: "127.0.0.1", port: proxy.port });
      await new Promise<void>((r) => s.once("connect", () => r()));
      s.write("CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n");
      s.resetAndDestroy();
    }
    await new Promise((r) => setTimeout(r, 300));
    // Still serving: a fresh connection is accepted and answered.
    const probe = net.createConnection({ host: "127.0.0.1", port: proxy.port });
    await new Promise<void>((r) => probe.once("connect", () => r()));
    const reply = await new Promise<string>((resolve) => {
      probe.once("data", (d) => resolve(d.toString()));
      probe.write("GARBAGE\r\n\r\n");
    });
    probe.destroy();
    assert.match(reply, /400 Bad Request/);
  });

  it("still refuses private destinations", async () => {
    const s = net.createConnection({ host: "127.0.0.1", port: proxy.port });
    await new Promise<void>((r) => s.once("connect", () => r()));
    const reply = await new Promise<string>((resolve) => {
      s.once("data", (d) => resolve(d.toString()));
      s.write("CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n");
    });
    s.destroy();
    assert.match(reply, /403 Forbidden/);
  });
});

async function listen(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

async function exchange(port: number, chunks: string[]): Promise<string> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(3000, () => socket.destroy(new Error("test timeout")));
  let result = "";
  socket.on("data", (chunk) => { result += chunk.toString(); });
  const done = once(socket, "close");
  await once(socket, "connect");
  for (const chunk of chunks) {
    if (socket.destroyed) break;
    socket.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await done;
  return result;
}

describe("upstream proxy transport", () => {
  let origin: http.Server;
  let upstream: http.Server;
  let originPort: number;
  let upstreamPort: number;
  let originalPrivate: string | undefined;
  let connects: Array<{ authority: string; auth?: string }>;
  let requests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }>;
  let peers: Set<net.Socket>;
  before(async () => {
    originalPrivate = process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK;
    process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = "true";
    connects = []; requests = []; peers = new Set();
    origin = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { requests.push({ url: req.url, headers: req.headers, body }); res.end("origin-ok"); });
    });
    originPort = await listen(origin);
    upstream = http.createServer();
    upstream.on("connect", (req, client, head) => {
      connects.push({ authority: req.url!, auth: req.headers["proxy-authorization"] });
      if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("alice:secret").toString("base64")}`) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\nDO-NOT-LEAK"); return;
      }
      const peer = net.createConnection({ host: "127.0.0.1", port: originPort });
      peers.add(peer);
      peer.on("error", () => client.destroy());
      peer.once("close", () => { peers.delete(peer); client.destroy(); });
      client.once("close", () => peer.destroy());
      peer.once("connect", () => {
        // Deliberately fragment the upstream response header too.
        client.write("HTTP/1.1 200 Connection");
        setTimeout(() => {
          client.write(" Established\r\n\r\n");
          if (head.length) peer.write(head);
          client.pipe(peer); peer.pipe(client);
        }, 5);
      });
    });
    upstreamPort = await listen(upstream);
  });
  after(async () => {
    if (originalPrivate === undefined) delete process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK;
    else process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = originalPrivate;
    for (const peer of peers) peer.destroy();
    await Promise.all([new Promise<void>((r) => upstream.close(() => r())), new Promise<void>((r) => origin.close(() => r()))]);
  });
  const proxyConfig = () => ({ server: `http://127.0.0.1:${upstreamPort}`, username: "alice", password: "secret" });

  it("sends pinned CONNECT and Basic auth, then origin-form HTTP without proxy credentials", async () => {
    const egress = await startEgressProxy({ upstream: proxyConfig() });
    try {
      const reply = await exchange(egress.port, [
        `POST http://127.0.0.1:${originPort}/path?q=1 HTTP/1.1\r\nHo`,
        "st: attacker.invalid\r\nProxy-Authorization: Basic CLIENT-SECRET\r\nProxy-Connection: keep-alive\r\nContent-Length: 6\r\n\r\nabc",
        "def",
      ]);
      assert.match(reply, /origin-ok/);
      assert.equal(connects.at(-1)?.authority, `127.0.0.1:${originPort}`);
      assert.equal(requests.at(-1)?.url, "/path?q=1");
      assert.equal(requests.at(-1)?.body, "abcdef");
      assert.equal(requests.at(-1)?.headers.host, `127.0.0.1:${originPort}`);
      assert.equal(requests.at(-1)?.headers["proxy-authorization"], undefined);
      assert.equal(requests.at(-1)?.headers["proxy-connection"], undefined);
    } finally { await egress.close(); }
  });

  for (const sameChunk of [true, false]) it(`preserves CONNECT payload in ${sameChunk ? "same" : "next"} chunk`, async () => {
    const egress = await startEgressProxy({ upstream: proxyConfig() });
    try {
      const header = `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: test\r\n\r\n`;
      const payload = "GET /inside HTTP/1.1\r\nHost: origin\r\nConnection: close\r\n\r\n";
      const reply = await exchange(egress.port, sameChunk ? [header.slice(0, 12), header.slice(12) + payload] : [header, payload]);
      assert.match(reply, /200 Connection Established/);
      assert.match(reply, /origin-ok/);
    } finally { await egress.close(); }
  });

  it("forwards a WebSocket upgrade through the upstream without leaking proxy credentials", async () => {
    const egress = await startEgressProxy({ upstream: proxyConfig() });
    const handle = (req: http.IncomingMessage, socket: import("node:stream").Duplex) => {
      assert.equal(req.url, "/socket");
      assert.equal(req.headers["proxy-authorization"], undefined);
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nupgrade-ok");
    };
    origin.once("upgrade", handle);
    try {
      const reply = await exchange(egress.port, [`GET ws://127.0.0.1:${originPort}/socket HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: Basic CLIENT-SECRET\r\n\r\n`]);
      assert.match(reply, /101 Switching Protocols/);
      assert.match(reply, /upgrade-ok/);
      assert.equal(connects.at(-1)?.authority, `127.0.0.1:${originPort}`);
    } finally { origin.removeListener("upgrade", handle); await egress.close(); }
  });

  it("still supports direct HTTP when no upstream is configured", async () => {
    const count = connects.length;
    const egress = await startEgressProxy();
    try {
      assert.match(await exchange(egress.port, [`GET http://127.0.0.1:${originPort}/direct HTTP/1.1\r\nHost: test\r\n\r\n`]), /origin-ok/);
      assert.equal(connects.length, count);
    } finally { await egress.close(); }
  });

  it("isolates browser credentials and never falls back after rejection", async () => {
    const bad = await startEgressProxy({ upstream: { ...proxyConfig(), password: "wrong" } });
    const good = await startEgressProxy({ upstream: proxyConfig() });
    try {
      const before = requests.length;
      const rejected = await exchange(bad.port, [`GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: test\r\n\r\n`]);
      assert.match(rejected, /502 Bad Gateway/);
      assert.doesNotMatch(rejected, /DO-NOT-LEAK|wrong|secret|407/);
      assert.equal(requests.length, before);
      assert.match(await exchange(good.port, [`GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: test\r\n\r\n`]), /origin-ok/);
    } finally { await bad.close(); await good.close(); }
  });

  it("honors tunnel precedence and fails closed on a broken binding", async () => {
    const count = connects.length;
    const tunnel = await startEgressProxy({ upstream: proxyConfig(), dial: async () => {
      const stream = net.createConnection({ host: "127.0.0.1", port: originPort });
      await once(stream, "connect"); return stream;
    } });
    const broken = await startEgressProxy({ upstream: proxyConfig(), dial: async () => { throw new Error("private detail"); } });
    try {
      assert.match(await exchange(tunnel.port, ["GET http://private.internal/ HTTP/1.1\r\nHost: private.internal\r\n\r\n"]), /origin-ok/);
      assert.match(await exchange(broken.port, ["CONNECT private.internal:80 HTTP/1.1\r\n\r\n"]), /502 Bad Gateway/);
      assert.equal(connects.length, count);
    } finally { await tunnel.close(); await broken.close(); }
  });

  it("vets destination and upstream independently before sending traffic", async () => {
    process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = "false";
    const egress = await startEgressProxy({ upstream: proxyConfig() });
    const count = connects.length;
    try {
      assert.match(await exchange(egress.port, ["CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n"]), /403 Forbidden/);
      assert.match(await exchange(egress.port, ["CONNECT 8.8.8.8:443 HTTP/1.1\r\n\r\n"]), /502 Bad Gateway/);
      assert.equal(connects.length, count);
    } finally { process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = "true"; await egress.close(); }
  });

  it("does not forward a pipelined second authority or oversized headers", async () => {
    const egress = await startEgressProxy({ upstream: proxyConfig() });
    const count = requests.length;
    try {
      await exchange(egress.port, [`GET http://127.0.0.1:${originPort}/first HTTP/1.1\r\nHost: test\r\n\r\nGET http://169.254.169.254/secret HTTP/1.1\r\nHost: metadata\r\n\r\n`]);
      assert.equal(requests.length, count);
      assert.match(await exchange(egress.port, [`GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\nX-Large: ${"x".repeat(17000)}\r\n\r\n`]), /400 Bad Request/);
    } finally { await egress.close(); }
  });

  it("bounds upstream headers, sanitizes rejection, and supports cancellation", async () => {
    const fake = net.createServer((client) => {
      client.on("error", () => {});
      client.once("data", () => client.write("HTTP/1.1 200 OK\r\nX: " + "x".repeat(17000)));
    });
    const port = await listen(fake);
    try {
      await assert.rejects(dialUpstreamProxy({ server: `http://127.0.0.1:${port}` }, "8.8.8.8", 443), /^Error: upstream proxy unavailable$/);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(dialUpstreamProxy(proxyConfig(), "8.8.8.8", 443, controller.signal), /upstream proxy unavailable/);
    } finally { await new Promise<void>((r) => fake.close(() => r())); }
  });

  it("supports unauthenticated proxies and closes an in-flight handshake on cancellation", async () => {
    let accepted: net.Socket | undefined;
    const fake = net.createServer((client) => {
      accepted = client;
      client.on("error", () => {});
      client.once("data", (data) => {
        assert.doesNotMatch(data.toString(), /Proxy-Authorization/);
        client.write("HTTP/1.1 200 OK\r\n\r\nhello");
      });
    });
    const port = await listen(fake);
    try {
      const stream = await dialUpstreamProxy({ server: `http://127.0.0.1:${port}` }, "8.8.8.8", 443);
      const received = once(stream, "data"); stream.resume();
      assert.equal((await received)[0].toString(), "hello");
      stream.destroy();
      accepted?.destroy();
      fake.removeAllListeners("connection");
      const connected = new Promise<net.Socket>((resolve) => fake.once("connection", (socket) => {
        accepted = socket; socket.on("error", () => {}); socket.resume(); resolve(socket);
      }));
      const controller = new AbortController();
      const pending = dialUpstreamProxy({ server: `http://127.0.0.1:${port}` }, "8.8.8.8", 443, controller.signal);
      const socket = await connected;
      const closed = once(socket, "close");
      controller.abort();
      await assert.rejects(pending, /upstream proxy unavailable/);
      await closed;
    } finally { accepted?.destroy(); await new Promise<void>((r) => fake.close(() => r())); }
  });

  it("times out a stalled upstream handshake without leaking its socket", async (t) => {
    let accepted: net.Socket | undefined;
    const fake = net.createServer((client) => { accepted = client; client.resume(); });
    const port = await listen(fake);
    try {
      // Fake only our wall-clock deadline, not network events or certificate clocks.
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const connection = once(fake, "connection");
      const pending = dialUpstreamProxy({ server: `http://127.0.0.1:${port}` }, "8.8.8.8", 443);
      const rejected = assert.rejects(pending, /upstream proxy unavailable/);
      await connection;
      const closed = once(accepted!, "close");
      t.mock.timers.tick(10_001);
      await rejected; await closed;
    } finally {
      t.mock.timers.reset(); accepted?.destroy();
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });

  it("verifies TLS trust and original hostname, sends SNI, and preserves handshake remainder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tallylamp-proxy-tls-"));
    let secure: tls.Server | undefined;
    try {
      const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
      const key = await readFile(keyPath), cert = await readFile(certPath);
      const names: string[] = [];
      secure = tls.createServer({ key, cert }, (socket) => {
        names.push(socket.servername || "");
        socket.on("error", () => {});
        socket.once("data", (data) => {
          assert.match(data.toString(), /^CONNECT 8\.8\.8\.8:443 HTTP\/1\.1/);
          assert.match(data.toString(), /Proxy-Authorization: Basic YTpi/);
          socket.end("HTTP/1.1 200 OK\r\n\r\nremainder");
        });
      });
      secure.on("tlsClientError", () => {});
      secure.listen(0); await once(secure, "listening");
      const port = (secure.address() as net.AddressInfo).port;
      await assert.rejects(dialUpstreamProxy({ server: `https://localhost:${port}` }, "8.8.8.8", 443), /upstream proxy unavailable/);
      // A child gets a test CA through Node's supported startup trust configuration.
      const code = `
        import { dialUpstreamProxy } from './src/upstream-proxy.ts';
        process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = 'true';
        const s = await dialUpstreamProxy({ server: 'https://localhost:${port}', username: 'a', password: 'b' }, '8.8.8.8', 443);
        let data = ''; s.on('data', x => data += x); s.resume();
        await new Promise(r => s.on('end', r));
        if (data !== 'remainder') throw new Error('lost remainder');
        try { await dialUpstreamProxy({ server: 'https://127.0.0.1:${port}' }, '8.8.8.8', 443); throw new Error('accepted bad identity'); }
        catch (e) { if (e.message !== 'upstream proxy unavailable') throw e; }
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdio: ["ignore", "pipe", "pipe"],
      });
      let errors = ""; child.stderr.on("data", (x) => { errors += x; });
      const [exit] = await once(child, "exit");
      assert.equal(exit, 0, errors);
      assert.deepEqual(names, ["localhost"]);
    } finally {
      if (secure) await new Promise<void>((r) => secure!.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
