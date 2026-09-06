import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";

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
      s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
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
