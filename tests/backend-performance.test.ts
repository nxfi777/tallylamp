import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { adminPrincipal } from "../src/auth.js";
import { browserWsUrl } from "../src/cdp.js";
import { getDb, prepare, resetDbForTests } from "../src/db.js";
import { fakeCdpCalls, resetFakeCdp } from "../src/fake-chrome.js";
import { startTestServer, type TestCtx } from "./helpers.js";

describe("backend request work sharing", () => {
  let ctx: TestCtx;
  let id: string;
  before(async () => {
    ctx = await startTestServer();
    id = (await ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard" })).id;
    await ctx.browsers.ensureRunning(id);
    await ctx.browsers.refreshPageInfo(id);
  });
  after(async () => { await ctx.close(); });

  it("shares overlapping page refreshes, then reads a fresh page on the next call", async () => {
    const nativeFetch = globalThis.fetch;
    const url = `${ctx.browsers.runtime(id)!.cdpUrl}/json/list`;
    let reads = 0;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    globalThis.fetch = async (input, init) => {
      if (input === url) { reads++; await gate; }
      return nativeFetch(input, init);
    };
    try {
      const pending = Array.from({ length: 8 }, () => ctx.browsers.refreshPageInfo(id));
      assert.equal(reads, 1);
      finish();
      await Promise.all(pending);
      await ctx.browsers.refreshPageInfo(id);
      assert.equal(reads, 2, "completed work is not a stale result cache");
    } finally { finish(); globalThis.fetch = nativeFetch; }
  });

  it("coalesces simultaneous thumbnails without retaining completed pixels", async () => {
    resetFakeCdp();
    const responses = await Promise.all(Array.from({ length: 8 }, async () => {
      const r = await fetch(`${ctx.url}/api/v1/browsers/${id}/thumbnail`, { headers: { Cookie: ctx.cookie } });
      assert.equal(r.status, 200);
      return Buffer.from(await r.arrayBuffer());
    }));
    responses.forEach(b => assert.deepEqual(b, responses[0]));
    assert.equal(fakeCdpCalls.filter(c => c.method === "Page.captureScreenshot").length, 1);
    const fresh = await fetch(`${ctx.url}/api/v1/browsers/${id}/thumbnail`, { headers: { Cookie: ctx.cookie } });
    await fresh.arrayBuffer();
    assert.equal(fakeCdpCalls.filter(c => c.method === "Page.captureScreenshot").length, 2);
  });

  it("does not publish a late page response after that runtime has stopped", async () => {
    const nativeFetch = globalThis.fetch;
    const url = `${ctx.browsers.runtime(id)!.cdpUrl}/json/list`;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    globalThis.fetch = async (input, init) => {
      if (input === url) {
        await gate;
        return new Response(JSON.stringify([{ type: "page", url: "https://obsolete.example", title: "Obsolete" }]));
      }
      return nativeFetch(input, init);
    };
    try {
      const pending = ctx.browsers.refreshPageInfo(id);
      await ctx.browsers.stop(id);
      finish();
      await pending;
      assert.notEqual(ctx.browsers.row(id).current_url, "https://obsolete.example");
    } finally { finish(); globalThis.fetch = nativeFetch; }
  });
});

it("bounds a CDP discovery socket that accepts a request but never sends a response", async () => {
  const server = http.createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const start = performance.now();
    await assert.rejects(browserWsUrl(`http://127.0.0.1:${address.port}`, 80), /could not read CDP version/);
    assert.ok(performance.now() - start < 1000, "the fetch must obey the caller's timeout");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("waits for an unpublished clone during shutdown and refuses new work", async () => {
  const ctx = await startTestServer();
  const principal = adminPrincipal();
  const source = await ctx.browsers.create({ principal, via: "dashboard" });
  const seed = await ctx.browsers.snapshotSeed(source.id, "Shutdown snapshot", principal);
  const manager = ctx.browsers as unknown as { copyProfile: (from: string, to: string) => Promise<void> };
  const original = manager.copyProfile;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  manager.copyProfile = async (from, to) => { await gate; await original.call(ctx.browsers, from, to); };
  const clone = ctx.browsers.create({ principal, via: "dashboard", seedId: seed.id });
  let shutDown = false;
  const shutdown = ctx.browsers.shutdown().then(() => { shutDown = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutDown, false, "shutdown must keep the profile directory alive while a copy uses it");
    await assert.rejects(ctx.browsers.create({ principal, via: "dashboard" }), /shutting down/);
    release();
    const row = await clone;
    await shutdown;
    assert.equal(ctx.browsers.row(row.id).status, "stopped");
  } finally { release(); await clone.catch(() => undefined); await shutdown; manager.copyProfile = original; await ctx.close(); }
});

it("reserves a deleting profile against starts, saves, moves and another delete", async () => {
  const ctx = await startTestServer();
  const principal = adminPrincipal();
  try {
    const row = await ctx.browsers.create({ principal, via: "dashboard" });
    const deletion = ctx.browsers.destroy(row.id, principal);
    await assert.rejects(ctx.browsers.ensureRunning(row.id), /being deleted/);
    await assert.rejects(ctx.browsers.snapshotSeed(row.id, "Too late", principal), /being deleted|browser not found/);
    await assert.rejects(ctx.browsers.moveTo(row.id, null, principal), /being deleted|browser not found/);
    await assert.rejects(ctx.browsers.destroy(row.id, principal), /being deleted|browser not found/);
    await deletion;
    assert.throws(() => ctx.browsers.row(row.id), /browser not found/);
  } finally { await ctx.close(); }
});

for (const mode of ["delete", "idle reap"] as const) {
  it(`waits for asynchronous ${mode} cleanup before shutdown completes`, { timeout: 5000 }, async () => {
    const ctx = await startTestServer();
    const principal = adminPrincipal();
    const previousTtl = process.env.TALLYLAMP_IDLE_TTL_SEC;
    process.env.TALLYLAMP_IDLE_TTL_SEC = "1";
    const row = await ctx.browsers.create({ principal, via: "dashboard", persistent: false });
    if (mode === "idle reap") {
      await ctx.browsers.ensureRunning(row.id);
      getDb().prepare("UPDATE browsers SET last_activity_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", row.id);
    }
    const manager = ctx.browsers as unknown as { removeBrowserFiles: (id: string, profile: string) => Promise<void> };
    const original = manager.removeBrowserFiles;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { entered = resolve; });
    manager.removeBrowserFiles = async (id, profile) => { entered(); await gate; await original.call(ctx.browsers, id, profile); };
    const removing = mode === "delete" ? ctx.browsers.destroy(row.id, principal) : ctx.browsers.reapIdle();
    let shutdown: Promise<void> | undefined;
    try {
      await held;
      let finished = false;
      shutdown = ctx.browsers.shutdown().then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false, "cleanup still needs the database and profile storage");
      await assert.rejects(ctx.browsers.destroy(row.id, principal), /shutting down/);
      release();
      await removing; await shutdown;
      assert.throws(() => ctx.browsers.row(row.id), /browser not found/);
    } finally {
      release(); await removing.catch(() => undefined); await shutdown;
      manager.removeBrowserFiles = original;
      if (previousTtl === undefined) delete process.env.TALLYLAMP_IDLE_TTL_SEC;
      else process.env.TALLYLAMP_IDLE_TTL_SEC = previousTtl;
      await ctx.close();
    }
  });
}

it("compiled statement reuse reads live values and cannot cross database resets", () => {
  resetDbForTests();
  const sql = "SELECT value FROM meta WHERE key = 'performance-fixture'";
  const first = prepare(sql);
  assert.equal(prepare(sql), first);
  getDb().prepare("INSERT INTO meta(key, value) VALUES ('performance-fixture', 'one')").run();
  assert.equal((prepare(sql).get() as { value: string }).value, "one");
  getDb().prepare("UPDATE meta SET value = 'two' WHERE key = 'performance-fixture'").run();
  assert.equal((prepare(sql).get() as { value: string }).value, "two");
  resetDbForTests();
  assert.notEqual(prepare(sql), first);
  assert.equal(prepare(sql).get(), undefined);
});
