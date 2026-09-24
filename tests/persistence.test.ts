import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { profileDir } from "../src/config.js";
import { createAgent } from "../src/auth.js";

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
      body: JSON.stringify({ name: "sticky", persistent: true, start: true, metadata: { project: "Research", purpose: "Saved logins" } }),
    });
    const id = (r.body as { browser: { id: string } }).browser.id;
    await json(`${ctx.url}/api/v1/browsers/${id}/stop`, { method: "POST", headers: { Cookie: ctx.cookie } });
    assert.equal(existsSync(profileDir(id)), true);
    const again = await json(`${ctx.url}/api/v1/browsers/${id}`, { headers: { Cookie: ctx.cookie } });
    assert.equal((again.body as { browser: { persistent: boolean; status: string } }).browser.persistent, true);
    assert.equal((again.body as { browser: { status: string } }).browser.status, "stopped");
    const edited = await json(`${ctx.url}/api/v1/browsers/${id}`, {
      method: "PATCH", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Saved research", metadata: { project: "Research", purpose: "Reusable references", task: "Design review" } }),
    });
    assert.equal(edited.status, 200);
    const resumed = await json(`${ctx.url}/api/v1/browsers/${id}/start`, { method: "POST", headers: { Cookie: ctx.cookie } });
    const browser = (resumed.body as { browser: { name: string; metadata: Record<string, string> } }).browser;
    assert.equal(browser.name, "Saved research");
    assert.deepEqual(browser.metadata, { project: "Research", purpose: "Reusable references", task: "Design review" });
    await json(`${ctx.url}/api/v1/browsers/${id}/stop`, { method: "POST", headers: { Cookie: ctx.cookie } });
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

  it("refuses a start the host has no processes left for, counting starts in flight", async () => {
    // Railway caps a container at 1000 processes and threads, and one Chrome runs 230-420.
    // Past the cap Chrome cannot start renderers, and the tabs that crash are every
    // browser's, so the start that would cross it is the one to refuse.
    for (const r of ctx.browsers.list()) if (ctx.browsers.runtime(r.id)) await ctx.browsers.stop(r.id);
    const cgroup = mkdtempSync(path.join(os.tmpdir(), "tallylamp-cgroup-"));
    const pids = (current: number) => {
      writeFileSync(path.join(cgroup, "pids.max"), "1000\n");
      writeFileSync(path.join(cgroup, "pids.current"), `${current}\n`);
      writeFileSync(path.join(cgroup, "pids.events"), "max 0\n");
    };
    process.env.TALLYLAMP_CGROUP_DIR = cgroup;
    const principal = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
    const rows = [1, 2, 3, 4].map((n) =>
      ctx.browsers.create({ principal, via: "control_api", name: `pids-${n}`, persistent: false }),
    );
    try {
      pids(700);
      await assert.rejects(ctx.browsers.ensureRunning(rows[0]!.id), (e: { code?: string; message?: string }) =>
        e.code === "fleet_full" && /700 of 1000/.test(e.message ?? ""));
      // 900 free fits two browsers of 450. The kernel's count does not move until a Chrome
      // has spawned, so the second and later starts in this tick must be counted by hand.
      pids(100);
      const settled = await Promise.allSettled(rows.map((r) => ctx.browsers.ensureRunning(r.id)));
      const started = settled.filter((s) => s.status === "fulfilled").length;
      assert.equal(started, 2, `900 free processes must admit two concurrent starts, ${started} started`);
    } finally {
      delete process.env.TALLYLAMP_CGROUP_DIR;
      for (const r of rows) await ctx.browsers.stop(r.id);
      rmSync(cgroup, { recursive: true, force: true });
    }
  });

  it("has no cap when TALLYLAMP_MAX_BROWSERS is unset or 0, and no per-agent cap at 0", async () => {
    for (const r of ctx.browsers.list()) if (ctx.browsers.runtime(r.id)) await ctx.browsers.stop(r.id);
    const { agent } = createAgent({ name: "Uncapped", maxBrowsers: 0 });
    const rows: Array<{ id: string }> = [];
    try {
      for (const value of [undefined, "0"]) {
        if (value === undefined) delete process.env.TALLYLAMP_MAX_BROWSERS;
        else process.env.TALLYLAMP_MAX_BROWSERS = value;
        // Past both old defaults: 4 for the fleet, 2 per agent.
        for (let n = 0; n < 5; n++) {
          const row = ctx.browsers.create({ principal: agent, via: "control_api", name: `open-${value ?? "unset"}-${n}`, persistent: false });
          rows.push(row);
          await ctx.browsers.ensureRunning(row.id);
        }
      }
      assert.equal(ctx.browsers.runningCount(), 10);
      const status = await json(`${ctx.url}/api/v1/status`, { headers: { Cookie: ctx.cookie } });
      assert.equal((status.body as { maxBrowsers: number | null }).maxBrowsers, null);
    } finally {
      delete process.env.TALLYLAMP_MAX_BROWSERS;
      for (const r of rows) await ctx.browsers.stop(r.id);
    }
  });
});
