import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { existsSync } from "node:fs";
import { profileDir } from "../src/config.js";

let ctx: TestCtx;

describe("persistence", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("stopping a persistent browser keeps the profile", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sticky", persistent: true, start: true }),
    });
    const id = (r.body as { browser: { id: string } }).browser.id;
    await json(`${ctx.url}/api/v1/browsers/${id}/stop`, { method: "POST", headers: { Cookie: ctx.cookie } });
    assert.equal(existsSync(profileDir(id)), true);
    const again = await json(`${ctx.url}/api/v1/browsers/${id}`, { headers: { Cookie: ctx.cookie } });
    assert.equal((again.body as { browser: { persistent: boolean; status: string } }).browser.persistent, true);
    assert.equal((again.body as { browser: { status: string } }).browser.status, "stopped");
  });

  it("deleting removes the profile", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gone", start: false }),
    });
    const id = (r.body as { browser: { id: string } }).browser.id;
    await json(`${ctx.url}/api/v1/browsers/${id}`, { method: "DELETE", headers: { Cookie: ctx.cookie } });
    const get = await json(`${ctx.url}/api/v1/browsers/${id}`, { headers: { Cookie: ctx.cookie } });
    assert.equal(get.status, 404);
    assert.equal(existsSync(profileDir(id)), false);
  });

  it("enforces fleet limits", async () => {
    process.env.TALLYLAMP_MAX_BROWSERS = "1";
    const first = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "one", start: true }),
    });
    assert.equal(first.status, 201);
    const second = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "two", start: true }),
    });
    assert.equal(second.status, 429);
    delete process.env.TALLYLAMP_MAX_BROWSERS;
  });

  it("counts in-flight starts against the cap, so concurrent launches cannot overshoot it", async () => {
    // Earlier tests in this file leave a Chrome running, and the cap counts the whole fleet.
    for (const r of ctx.browsers.list()) if (ctx.browsers.runtime(r.id)) await ctx.browsers.stop(r.id);
    assert.equal(ctx.browsers.runningCount(), 0, "the fleet must be empty before the cap is measured");
    process.env.TALLYLAMP_MAX_BROWSERS = "2";
    const principal = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
    const rows = [1, 2, 3, 4].map((n) =>
      ctx.browsers.create({ principal, via: "control_api", name: `race-${n}`, persistent: false }),
    );
    try {
      // ensureRunning does its cap check synchronously, before start() ever awaits, so firing
      // them in one tick is exactly the interleaving that used to launch four Chromes under a
      // cap of two: every call read runtimes.size === 0 and every call passed.
      const settled = await Promise.allSettled(rows.map((r) => ctx.browsers.ensureRunning(r.id)));
      const started = settled.filter((s) => s.status === "fulfilled").length;
      assert.equal(started, 2, `a cap of 2 must hold under concurrent starts, ${started} started`);
      assert.ok(
        settled.some((s) => s.status === "rejected" && (s.reason as { code?: string }).code === "fleet_full"),
        "the calls over the cap must fail with fleet_full, not silently launch",
      );
    } finally {
      delete process.env.TALLYLAMP_MAX_BROWSERS;
      for (const r of rows) await ctx.browsers.stop(r.id);
    }
  });
});
