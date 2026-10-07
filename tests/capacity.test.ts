import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { getDb } from "../src/db.js";
import { hub, type TallyEvent } from "../src/events.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { navigationOutcome } from "../src/mcp.js";
import type { Usage } from "../src/host-limits.js";

let ctx: TestCtx;
const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
const cgroup = mkdtempSync(path.join(os.tmpdir(), "tallylamp-cgroup-"));

/** Write the fake cgroup: Railway's ceiling of 1000, `current` in use. */
function pids(current: number, refused = 0) {
  writeFileSync(path.join(cgroup, "pids.max"), "1000\n");
  writeFileSync(path.join(cgroup, "pids.current"), `${current}\n`);
  writeFileSync(path.join(cgroup, "pids.events"), `max ${refused}\n`);
}

function usage(threads: number, rendererZygotes = 1): Usage {
  return { threads, processes: 12, byKind: { browser: { processes: 1, threads: 40 } }, rendererZygotes };
}

/** What each fake browser "uses", standing in for /proc, which the fake Chrome has none of. */
let measured = new Map<string, Usage>();

function browser(name: string) {
  return ctx.browsers.create({ principal: admin, via: "control_api", name, persistent: true });
}

function idle(id: string) {
  getDb().prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`).run(new Date(Date.now() - 3_600_000).toISOString(), id);
}

async function stopAll() {
  for (const r of ctx.browsers.list()) if (ctx.browsers.runtime(r.id)) await ctx.browsers.stop(r.id);
  getDb().prepare(`UPDATE browsers SET pinned = 0`).run();
}

describe("host capacity", () => {
  before(async () => {
    ctx = await startTestServer();
    // Driven by hand below, so the background sampler cannot act between a test's steps.
    ctx.browsers.capacity.stopSampling();
    ctx.browsers.capacity.measure = () => new Map([...measured].filter(([id]) => ctx.browsers.runtime(id)));
    process.env.TALLYLAMP_CGROUP_DIR = cgroup;
    process.env.TALLYLAMP_MAX_BROWSERS = "0";
  });
  after(async () => {
    delete process.env.TALLYLAMP_CGROUP_DIR;
    delete process.env.TALLYLAMP_ADMISSION_WAIT_SEC;
    delete process.env.TALLYLAMP_UNHEALTHY_RESTARTS;
    await stopAll();
    await ctx.close();
    rmSync(cgroup, { recursive: true, force: true });
  });
  beforeEach(() => {
    measured = new Map();
    process.env.TALLYLAMP_ADMISSION_WAIT_SEC = "0";
    // One Capacity serves every test here, and stopping a busy browser starts a 10-second
    // cooldown before the next one may be. Without this, whichever test followed one that
    // stopped a busy browser would wait on a stop that the cooldown holds back.
    (ctx.browsers.capacity as unknown as { lastActiveShedAt: number }).lastActiveShedAt = 0;
  });
  afterEach(stopAll);

  it("admits on a browser's measured launch peak, and refuses one it has no room for", async () => {
    const b = browser("kraken");
    // 1000 - 700 - 50 headroom leaves 250, short of the 300 assumed for a browser never measured.
    pids(700);
    await assert.rejects(ctx.browsers.ensureRunning(b.id), (e: { code?: string; message?: string }) =>
      e.code === "fleet_full" && /700 of 1000/.test(e.message ?? "") && /needs about 300/.test(e.message ?? ""));
    assert.equal(ctx.browsers.row(b.id).status, "stopped", "a refused start goes back to where it was");
    // Measured at 150 on its last start: 150 * 1.25 + 25 = 213 fits in 250.
    ctx.browsers.recordThreads(b.id, 150, 190);
    await ctx.browsers.ensureRunning(b.id);
    assert.equal(ctx.browsers.row(b.id).status, "running");
  });

  it("counts concurrent starts, so they cannot all read the same free room", async () => {
    const rows = [1, 2, 3, 4].map((n) => browser(`burst-${n}`));
    // 850 of room after headroom fits two browsers of 300, not four.
    pids(100);
    const settled = await Promise.allSettled(rows.map((r) => ctx.browsers.ensureRunning(r.id)));
    const started = settled.filter((s) => s.status === "fulfilled").length;
    assert.equal(started, 2, `850 free must admit two concurrent starts, ${started} started`);
  });

  it("queues a start until there is room, rather than refusing it outright", async () => {
    process.env.TALLYLAMP_ADMISSION_WAIT_SEC = "10";
    const b = browser("patient");
    pids(900);
    const events: string[] = [];
    const listen = (ev: TallyEvent) => { if (ev.browserId === b.id) events.push(ev.type); };
    hub.on("event", listen);
    try {
      const started = ctx.browsers.ensureRunning(b.id);
      await sleep(300);
      assert.equal(ctx.browsers.row(b.id).status, "queued");
      pids(300); // something else stopped
      await started;
      assert.equal(ctx.browsers.row(b.id).status, "running");
      assert.deepEqual(events.slice(0, 2), ["browser.queued", "browser.starting"]);
    } finally {
      hub.off("event", listen);
    }
  });

  it("holds room for a stopped pinned browser, so another cannot start into it", async () => {
    const pinned = browser("production");
    ctx.browsers.recordThreads(pinned.id, 200, 220); // needs 275 to start
    const test = browser("test");
    await json(`${ctx.url}/api/v1/browsers/${pinned.id}/pinned`, {
      method: "PUT", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }),
    });
    assert.equal(ctx.browsers.row(pinned.id).pinned, 1);
    // 1000 - 500 - 50 = 450: room for the test browser's 300, but not while 275 is held.
    pids(500);
    await assert.rejects(ctx.browsers.ensureRunning(test.id), (e: { message?: string }) =>
      /275 more are held for pinned browsers/.test(e.message ?? ""));
    // The pinned browser itself starts into the room held for it.
    await ctx.browsers.ensureRunning(pinned.id);
  });

  it("lets only the administrator pin a browser", async () => {
    const { agent, token } = createAgent({ name: "Pinner", scopes: DEFAULT_AGENT_SCOPES, maxBrowsers: 2 });
    const own = ctx.browsers.create({ principal: agent, via: "control_api", name: "mine" });
    const r = await json(`${ctx.url}/api/v1/browsers/${own.id}/pinned`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }),
    });
    assert.ok(r.status === 401 || r.status === 403, `status ${r.status}`);
    assert.equal(ctx.browsers.row(own.id).pinned, 0);
  });

  it("stops an idle unpinned browser to start a pinned one, and tells its owner why", async () => {
    const test = browser("idle test");
    pids(100);
    await ctx.browsers.ensureRunning(test.id);
    idle(test.id);
    measured.set(test.id, usage(400));
    await ctx.browsers.capacity.sampleNow();

    const pinned = browser("kraken dashboard");
    ctx.browsers.setPinned(pinned.id, true, admin);
    ctx.browsers.recordThreads(pinned.id, 187, 190);
    // 1000 - 800 - 50 = 150 free, and the pinned browser needs 259. Stopping the idle one's
    // 400 is enough; the fake cgroup follows it down as the real one would.
    pids(800);
    const drop = (ev: TallyEvent) => { if (ev.type === "browser.stopped" && ev.browserId === test.id) pids(400); };
    hub.on("event", drop);
    try {
      await ctx.browsers.ensureRunning(pinned.id);
    } finally {
      hub.off("event", drop);
    }
    assert.equal(ctx.browsers.runtime(test.id), undefined, "the idle browser was stopped");
    assert.ok(ctx.browsers.runtime(pinned.id), "the pinned browser started");
    const note = ctx.browsers.noticesSince(test.id, 0).map((n) => n.text).join("\n");
    assert.match(note, /stopped this browser .* to make room for pinned browser kraken dashboard/);
    assert.match(note, /using 400 of the host's processes/);
    const audited = getDb().prepare(`SELECT 1 FROM audit_events WHERE action = 'browser.shed' AND target_id = ?`).get(test.id);
    assert.ok(audited);
  });

  it("admits as pinned a start that was pinned while it waited", async () => {
    // 29 September, 17:09: the reader's start was already queued, unpinned, when it was
    // pinned, and in 0.9.0 it went on waiting as unpinned until it failed.
    process.env.TALLYLAMP_ADMISSION_WAIT_SEC = "10";
    const busy = browser("dray-ai-pages");
    pids(100);
    await ctx.browsers.ensureRunning(busy.id);
    measured.set(busy.id, usage(707));
    await ctx.browsers.capacity.sampleNow();
    const reader = browser("kraken reader");
    ctx.browsers.recordThreads(reader.id, 235, 243); // needs 319
    pids(800);
    const drop = (ev: TallyEvent) => { if (ev.type === "browser.stopped" && ev.browserId === busy.id) pids(100); };
    hub.on("event", drop);
    try {
      const started = ctx.browsers.ensureRunning(reader.id);
      await sleep(300);
      assert.equal(ctx.browsers.row(reader.id).status, "queued");
      assert.ok(ctx.browsers.runtime(busy.id), "an unpinned start does not stop a busy browser");
      ctx.browsers.setPinned(reader.id, true, admin);
      await started;
    } finally {
      hub.off("event", drop);
    }
    assert.ok(ctx.browsers.runtime(reader.id), "pinned mid-wait, it started");
    assert.equal(ctx.browsers.runtime(busy.id), undefined, "and stopped the busy browser to do it");
  });

  it("forgets a stopped browser's thread counts on reset, so a start it fits is admitted", async () => {
    // A browser measured at 606 is sized at 606 * 1.25 + 25 = 783, and refused the 450 free.
    const b = browser("oversized");
    ctx.browsers.recordThreads(b.id, 606, 640);
    pids(500);
    await assert.rejects(ctx.browsers.ensureRunning(b.id), (e: { message?: string }) => /needs about 783/.test(e.message ?? ""));
    const r = await json(`${ctx.url}/api/v1/browsers/${b.id}/threads/reset`, { method: "POST", headers: { Cookie: ctx.cookie } });
    assert.equal(r.status, 200);
    const view = (r.body as { browser: { launchThreads: number | null; peakThreads: number | null; startThreads: number } }).browser;
    assert.deepEqual([view.launchThreads, view.peakThreads, view.startThreads], [null, null, 300]);
    await ctx.browsers.ensureRunning(b.id);
    assert.equal(ctx.browsers.row(b.id).status, "running");
    const audited = getDb().prepare(`SELECT detail_json FROM audit_events WHERE action = 'browser.threads_reset' AND target_id = ?`).get(b.id) as
      { detail_json: string } | undefined;
    assert.deepEqual(JSON.parse(audited!.detail_json), { launchThreads: 606, peakThreads: 640 });
  });

  it("lets only the administrator reset a browser's thread counts", async () => {
    const { agent, token } = createAgent({ name: "Resetter", scopes: DEFAULT_AGENT_SCOPES, maxBrowsers: 2 });
    const own = ctx.browsers.create({ principal: agent, via: "control_api", name: "measured" });
    ctx.browsers.recordThreads(own.id, 606, 640);
    const r = await json(`${ctx.url}/api/v1/browsers/${own.id}/threads/reset`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.ok(r.status === 401 || r.status === 403, `status ${r.status}`);
    assert.equal(ctx.browsers.row(own.id).launch_threads, 606);
  });

  it("measures a running browser again from its reset, and its launch on its next start", async () => {
    const b = browser("remeasured");
    pids(100);
    await ctx.browsers.ensureRunning(b.id);
    measured.set(b.id, usage(400));
    await ctx.browsers.capacity.sampleNow();
    assert.equal(ctx.browsers.row(b.id).peak_threads, 400);
    ctx.browsers.resetThreads(b.id, admin);
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(b.id)).peakThreads, null, "the peak this run had reached is forgotten too");
    measured.set(b.id, usage(250));
    await ctx.browsers.capacity.sampleNow();
    assert.equal(ctx.browsers.row(b.id).peak_threads, 250, "the new peak is not held up by the old one");
    // Stopped inside its first minute: without the reset, the 250 it reached would be kept as
    // its launch peak. Part of a launch is not a launch.
    await ctx.browsers.stop(b.id);
    assert.equal(ctx.browsers.row(b.id).launch_threads, null);
    assert.equal(ctx.browsers.row(b.id).peak_threads, 250);
  });

  it("admits a waiting start on its new size when its thread counts are reset", async () => {
    process.env.TALLYLAMP_ADMISSION_WAIT_SEC = "10";
    const b = browser("waiting oversized");
    ctx.browsers.recordThreads(b.id, 606, 640); // needs 783, with 450 free
    pids(500);
    const started = ctx.browsers.ensureRunning(b.id);
    await sleep(300);
    assert.equal(ctx.browsers.row(b.id).status, "queued");
    ctx.browsers.resetThreads(b.id, admin);
    await started;
    assert.equal(ctx.browsers.row(b.id).status, "running");
  });

  it("names the reset in a refusal only when a reset would let the browser in", async () => {
    // An agent cannot reset a browser, so the refusal is how it learns to ask somebody who can.
    const hint = /That estimate comes from an earlier start\. If it needs less now, the administrator can reset its thread counts on its page\./;
    const b = browser("heavy once");
    ctx.browsers.recordThreads(b.id, 606, 640); // sized at 783
    const refusal = () => ctx.browsers.ensureRunning(b.id).then(() => assert.fail("the start was admitted"), (e: Error) => e.message);
    pids(500); // 450 of room: 783 does not fit, and the 300 of a browser never measured would
    assert.match(await refusal(), hint);
    pids(800); // 150 of room: a reset would not let it in either
    assert.doesNotMatch(await refusal(), /reset/);
    ctx.browsers.resetThreads(b.id, admin);
    assert.doesNotMatch(await refusal(), /reset/, "a browser never measured has nothing to reset");
  });

  it("never stops a browser that is in use to start an unpinned one", async () => {
    const busy = browser("active test");
    pids(100);
    await ctx.browsers.ensureRunning(busy.id);
    measured.set(busy.id, usage(400));
    await ctx.browsers.capacity.sampleNow();
    const other = browser("another test");
    pids(800);
    await assert.rejects(ctx.browsers.ensureRunning(other.id), (e: { message?: string }) =>
      /largest running browsers are active test \(400\)/.test(e.message ?? ""));
    assert.ok(ctx.browsers.runtime(busy.id), "the active browser is still running");
  });

  it("stops an active unpinned browser that is starving a running pinned one", async () => {
    const pinned = browser("pinned reader");
    const hog = browser("dray test");
    pids(100);
    ctx.browsers.setPinned(pinned.id, true, admin);
    await ctx.browsers.ensureRunning(pinned.id);
    await ctx.browsers.ensureRunning(hog.id);
    measured.set(pinned.id, usage(187));
    measured.set(hog.id, usage(612));
    // The incident: 612 + 187 + 89 everything else, and still climbing.
    pids(960);
    const stopped = new Promise<void>((resolve) => {
      const on = (ev: TallyEvent) => {
        if (ev.type === "browser.stopped" && ev.browserId === hog.id) { hub.off("event", on); pids(350); resolve(); }
      };
      hub.on("event", on);
    });
    // A single sample over the line is not enough; the shortfall has to last.
    await ctx.browsers.capacity.sampleNow();
    assert.ok(ctx.browsers.runtime(hog.id), "one sample stops nothing");
    await ctx.browsers.capacity.sampleNow();
    await stopped;
    assert.ok(ctx.browsers.runtime(pinned.id), "the pinned browser kept running");
    assert.match(ctx.browsers.noticesSince(hog.id, 0).map((n) => n.text).join("\n"), /while it was in use, to keep a pinned browser/);
  });

  it("keeps a pinned browser through the idle reaper", async () => {
    process.env.TALLYLAMP_IDLE_TTL_SEC = "1";
    try {
      const pinned = browser("keep me");
      const plain = browser("reap me");
      pids(100);
      ctx.browsers.setPinned(pinned.id, true, admin);
      await ctx.browsers.ensureRunning(pinned.id);
      await ctx.browsers.ensureRunning(plain.id);
      idle(pinned.id);
      idle(plain.id);
      await ctx.browsers.reapIdle();
      assert.ok(ctx.browsers.runtime(pinned.id));
      assert.equal(ctx.browsers.runtime(plain.id), undefined);
    } finally {
      delete process.env.TALLYLAMP_IDLE_TTL_SEC;
    }
  });

  it("restarts a browser that lost its renderer zygote, and stops restarting it after the budget", async () => {
    process.env.TALLYLAMP_UNHEALTHY_RESTARTS = "1";
    const b = browser("zygote");
    pids(100);
    await ctx.browsers.ensureRunning(b.id);
    const first = ctx.browsers.runtime(b.id);
    measured.set(b.id, usage(187, 1));
    await ctx.browsers.capacity.sampleNow();
    const restarted = new Promise<void>((resolve) => {
      const on = (ev: TallyEvent) => { if (ev.type === "browser.restarted" && ev.browserId === b.id) { hub.off("event", on); resolve(); } };
      hub.on("event", on);
    });
    // The zygote dies; two samples in a row without it, with the browser process still up.
    measured.set(b.id, usage(150, 0));
    await ctx.browsers.capacity.sampleNow();
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(b.id)).status, "running", "one miss is not enough");
    await ctx.browsers.capacity.sampleNow();
    await restarted;
    assert.notEqual(ctx.browsers.runtime(b.id), first, "a new Chrome");
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(b.id)).status, "running");
    assert.match(ctx.browsers.noticesSince(b.id, 0).map((n) => n.text).join("\n"), /lost the zygote .* so Tallylamp restarted it/);

    // Past the budget it is reported, not restarted in a loop.
    await ctx.browsers.markUnhealthy(b.id, "test says so");
    const view = ctx.browsers.publicView(ctx.browsers.row(b.id));
    assert.equal(view.status, "unhealthy");
    assert.equal(view.health?.reason, "test says so");
    await ctx.browsers.stop(b.id);
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(b.id)).health, null);
  });

  it("treats a streak of net::ERR_ABORTED across hosts as broken, and one site's as the site's", async () => {
    process.env.TALLYLAMP_UNHEALTHY_RESTARTS = "3";
    const b = browser("aborts");
    pids(100);
    await ctx.browsers.ensureRunning(b.id);
    const first = ctx.browsers.runtime(b.id);
    for (let i = 0; i < 4; i++) ctx.browsers.noteNavigation(b.id, "aborted", "https://one.example/");
    assert.equal(ctx.browsers.runtime(b.id), first, "one host aborting is that host's business");
    ctx.browsers.noteNavigation(b.id, "ok");
    const restarted = new Promise<void>((resolve) => {
      const on = (ev: TallyEvent) => { if (ev.type === "browser.restarted" && ev.browserId === b.id) { hub.off("event", on); resolve(); } };
      hub.on("event", on);
    });
    ctx.browsers.noteNavigation(b.id, "aborted", "https://example.com/");
    ctx.browsers.noteNavigation(b.id, "aborted", "https://cloudflare.com/");
    ctx.browsers.noteNavigation(b.id, "aborted", "https://pro.kraken.com/");
    await restarted;
    assert.notEqual(ctx.browsers.runtime(b.id), first);
  });

  it("reads a navigation's outcome off the bridge's text", () => {
    const text = (t: string, isError = false) => ({ isError, content: [{ type: "text", text: t }] });
    assert.deepEqual(navigationOutcome(text("Unable to navigate in the selected page: net::ERR_ABORTED at https://example.com/.")),
      { outcome: "aborted", url: "https://example.com/" });
    assert.deepEqual(navigationOutcome(text("Error: net::ERR_ABORTED at https://pro.kraken.com/", true)),
      { outcome: "aborted", url: "https://pro.kraken.com/" });
    assert.deepEqual(navigationOutcome(text("Successfully navigated to https://example.com/.")), { outcome: "ok" });
    assert.deepEqual(navigationOutcome(text("Unable to navigate in the selected page: net::ERR_NAME_NOT_RESOLVED at https://x.invalid/.")),
      { outcome: "other" });
  });

  it("tells the dashboard and every running browser's agent when the kernel refuses processes", async () => {
    const b = browser("witness");
    pids(100, 0);
    await ctx.browsers.capacity.sampleNow(); // baseline refusal count
    await ctx.browsers.ensureRunning(b.id);
    const seen: TallyEvent[] = [];
    const on = (ev: TallyEvent) => { if (ev.type === "host.pids_refused") seen.push(ev); };
    hub.on("event", on);
    try {
      pids(991, 412);
      await ctx.browsers.capacity.sampleNow();
    } finally {
      hub.off("event", on);
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.payload.refused, 412);
    assert.match(ctx.browsers.noticesSince(b.id, 0).map((n) => n.text).join("\n"), /refused 412 new processes and threads \(991 of 1000 in use\)/);
    const status = await json(`${ctx.url}/api/v1/status`, { headers: { Cookie: ctx.cookie } });
    const host = (status.body as { host: { pids: { max: number }; lastRefusal: { count: number } } }).host;
    assert.equal(host.pids.max, 1000);
    assert.equal(host.lastRefusal.count, 412);
  });

  it("delivers a note about the browser on the agent's next tool call, once", async () => {
    const { agent, token } = createAgent({ name: "Noted", scopes: DEFAULT_AGENT_SCOPES, maxBrowsers: 2 });
    const own = ctx.browsers.create({ principal: agent, via: "mcp", name: "noted" });
    pids(100);
    const post = (method: string, params: unknown, extra: Record<string, string> = {}) =>
      json(`${ctx.url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25", ...extra },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const init = await post("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "notes", version: "1" } });
    const headers = { "MCP-Session-Id": init.headers.get("mcp-session-id")! };
    const texts = async (name: string, args: Record<string, unknown>) => {
      const res = await post("tools/call", { name, arguments: args }, headers);
      const line = String(res.body).split("\n").find((l) => l.startsWith("data:"));
      const result = (typeof res.body === "object" ? res.body : JSON.parse(line!.slice(5))) as { result: { content: Array<{ text: string }> } };
      return result.result.content.map((c) => c.text);
    };
    await texts("tallylamp_use_browser", { browserId: own.id });
    ctx.browsers.notice(own.id, "the host refused 3 new processes");
    const withNote = await texts("tallylamp_list_browsers", {});
    assert.ok(withNote.some((t) => t === "[tallylamp] the host refused 3 new processes"), withNote.join(" | "));
    const again = await texts("tallylamp_list_browsers", {});
    assert.ok(!again.some((t) => t.includes("refused 3")), "shown once per session");
  });
});
