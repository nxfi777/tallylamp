import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { getDb } from "../src/db.js";
import { profileDir } from "../src/config.js";
import { allocatePort } from "../src/chrome.js";
import { browserWsUrl, CdpClient, listPages } from "../src/cdp.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { makeJoinToken, parseJoinToken, startWorker, WorkerFatal } from "../src/worker.js";
import { hub, type TallyEvent } from "../src/events.js";
import { forwardHttp } from "../src/relay.js";

let ctx: TestCtx;
const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
const dirs: string[] = [];

type Worker = Awaited<ReturnType<typeof startWorker>> & { dataDir: string; url: string; name: string };

/** A worker in this process, on its own data directory, joined with a fresh token. */
async function addWorker(name: string, token?: string): Promise<Worker> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "tallylamp-worker-"));
  dirs.push(dataDir);
  const port = await allocatePort();
  const url = `http://127.0.0.1:${port}`;
  const join = token ?? ctx.browsers.workers.createJoinToken(admin).token;
  const w = await startWorker({ dataDir, host: "127.0.0.1", port, join, selfUrl: url, name });
  await ctx.browsers.workers.poll();
  return { ...w, dataDir, url, name };
}

const browserOn = async (workerId: string | null, name: string) =>
  (await ctx.browsers.create({ principal: admin, via: "control_api", name, workerId }));

describe("workers", () => {
  let worker: Worker;
  before(async () => {
    ctx = await startTestServer();
    ctx.browsers.workers.stopPolling(); // driven by hand, so a poll cannot land between a test's steps
    worker = await addWorker("worker-a");
  });
  after(async () => {
    await worker.close().catch(() => undefined);
    await ctx.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("reads a join token, and says so plainly when it is not one", () => {
    const token = makeJoinToken("https://main.example/", "a".repeat(48));
    assert.deepEqual(parseJoinToken(token), { controlUrl: "https://main.example", secret: "a".repeat(48) });
    for (const junk of ["", "hello", "tlw1.not-base64", makeJoinToken("ftp://x", "a".repeat(48)), makeJoinToken("https://x", "short")]) {
      assert.throws(() => parseJoinToken(junk), /not a join token\. Copy it again from Add worker/);
    }
  });

  it("joins with a token, shows on the dashboard's list, and the token does not work twice", async () => {
    const list = await json(`${ctx.url}/api/v1/workers`, { headers: { Cookie: ctx.cookie } });
    const body = list.body as { workers: Array<{ id: string; name: string; online: boolean; problem: string | null; url: string }>; release: string };
    assert.equal(body.workers.length, 1);
    assert.deepEqual(
      { name: body.workers[0]!.name, online: body.workers[0]!.online, problem: body.workers[0]!.problem, url: body.workers[0]!.url },
      { name: "worker-a", online: true, problem: null, url: worker.url },
    );
    assert.ok(!JSON.stringify(list.body).includes(worker.identity.secret), "the secret never leaves the instance");

    // The token is stored only as a hash, and is spent.
    const made = await json(`${ctx.url}/api/v1/workers/join-tokens`, { method: "POST", headers: { Cookie: ctx.cookie } });
    const token = (made.body as { token: string }).token;
    assert.equal(made.status, 201);
    const second = await addWorker("worker-b", token);
    await assert.rejects(addWorker("worker-c", token), (e: Error) => e instanceof WorkerFatal && /already been used/.test(e.message));
    await second.close();
    ctx.browsers.workers.remove(second.identity.workerId, admin);
  });

  it("refuses a worker on another release, a token from elsewhere, and an agent making tokens", async () => {
    const token = ctx.browsers.workers.createJoinToken(admin).token;
    const secret = parseJoinToken(token).secret;
    assert.throws(
      () => ctx.browsers.workers.join({ token: secret, name: "old", url: "http://old.internal:8080", version: "0.0.1" }),
      /This worker runs 0\.0\.1 and the main instance runs .*Deploy the same release on both/,
    );
    const foreign = await json(`${ctx.url}/api/v1/workers/join`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "b".repeat(48), name: "x", url: "http://x.internal:8080", version: "1" }),
    });
    assert.equal(foreign.status, 403);
    assert.match(JSON.stringify(foreign.body), /not from this instance/);
    const asAgent = await json(`${ctx.url}/api/v1/workers/join-tokens`, { method: "POST", headers: { Authorization: `Bearer ${ctx.agentToken}` } });
    assert.equal(asAgent.status, 403);
  });

  it("answers nobody without its secret", async () => {
    assert.equal((await fetch(`${worker.url}/healthz`)).status, 200);
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${"0".repeat(64)}` }]) {
      assert.equal((await fetch(`${worker.url}/worker/v1/state`, { headers })).status, 401);
      assert.equal((await fetch(`${worker.url}/worker/v1/browsers/${"a".repeat(16)}/cdp/json/version`, { headers })).status, 401);
    }
    const ok = await fetch(`${worker.url}/worker/v1/state`, { headers: { Authorization: `Bearer ${worker.identity.secret}` } });
    assert.equal(ok.status, 200);
    // Ids are hex and nothing else, so one can never name a path.
    const traversal = await fetch(`${worker.url}/worker/v1/browsers/..%2F..%2Fetc/stop`, { method: "POST", headers: { Authorization: `Bearer ${worker.identity.secret}` } });
    assert.equal(traversal.status, 400);
  });

  it("starts a browser on the worker and drives it through a local endpoint", async () => {
    const row = (await browserOn(worker.identity.workerId, "remote"));
    assert.equal(existsSync(profileDir(row.id)), false, "nothing of its profile is kept on the main instance");
    const rt = await ctx.browsers.ensureRunning(row.id);
    assert.match(rt.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    // /json through both hops, and every address in it rewritten to the local endpoint.
    const pages = await listPages(rt.cdpUrl);
    assert.equal(pages[0]!.type, "page");
    const ws = await browserWsUrl(rt.cdpUrl);
    assert.ok(ws.startsWith(`ws://127.0.0.1:${rt.cdpPort}/devtools/`), ws);

    // A WebSocket through both hops, carrying a real exchange.
    const cdp = new CdpClient(ws);
    await cdp.connect();
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string }> };
    assert.ok(targetInfos.length >= 1);
    await cdp.close();

    const view = ctx.browsers.publicView(ctx.browsers.row(row.id));
    assert.equal(view.status, "running");
    // The test worker runs the fake Chrome, which has no display, and says so.
    assert.deepEqual(view.worker, { id: worker.identity.workerId, name: "worker-a", online: true, fullBrowser: false });
    assert.equal(ctx.browsers.managedIds().includes(row.id), false, "it draws on the worker's ceiling, not this host's");

    await ctx.browsers.stop(row.id);
    const state = (await (await fetch(`${worker.url}/worker/v1/state`, { headers: { Authorization: `Bearer ${worker.identity.secret}` } })).json()) as { browsers: unknown[] };
    assert.equal(state.browsers.length, 0, "stopping here stops it there");
    await assert.rejects(fetch(`${rt.cdpUrl}/json/version`), "and the local endpoint is closed");
  });

  it("lets only the administrator choose where a browser runs", async () => {
    const { agent } = createAgent({ name: "Placer", scopes: DEFAULT_AGENT_SCOPES, maxBrowsers: 2 });
    await assert.rejects(
      async () => (await ctx.browsers.create({ principal: agent, via: "mcp", name: "sneaky", workerId: worker.identity.workerId })),
      /only the administrator can choose where a browser runs/,
    );
  });

  it("keeps a new browser on the main instance while it has room, and overflows to a worker when it has not", async () => {
    // No process ceiling on this host: it has all the room there is, so it keeps its browsers.
    assert.equal(ctx.browsers.workers.pick(), null);
    const hostView = ctx.browsers.capacity.hostView.bind(ctx.browsers.capacity);
    const localWith = (current: number) => {
      ctx.browsers.capacity.hostView = (() => ({
        pids: { max: 1000, current, refused: 0 }, free: 1000 - current, headroom: 50, held: 0, other: 0, lastRefusal: null,
      })) as typeof ctx.browsers.capacity.hostView;
    };
    try {
      // Room for one more here: a worker's browser cannot use Full browser or uploads yet, so
      // it should not land there without a reason.
      localWith(400);
      assert.equal(ctx.browsers.workers.pick(), null);
      process.env.TALLYLAMP_PLACEMENT = "spread";
      assert.equal(ctx.browsers.workers.pick(), worker.identity.workerId, "spread always takes the emptiest host");
      delete process.env.TALLYLAMP_PLACEMENT;
      // No room for one more here.
      localWith(900);
      assert.equal(ctx.browsers.workers.pick(), worker.identity.workerId);
      const { agent } = createAgent({ name: "Overflow", scopes: DEFAULT_AGENT_SCOPES, maxBrowsers: 2 });
      assert.equal((await ctx.browsers.create({ principal: agent, via: "mcp", name: "placed" })).worker_id, worker.identity.workerId);
      process.env.TALLYLAMP_PLACEMENT = "local";
      assert.equal(ctx.browsers.workers.pick(), null);
    } finally {
      delete process.env.TALLYLAMP_PLACEMENT;
      ctx.browsers.capacity.hostView = hostView;
    }
  });

  it("says what does not reach a worker's browser yet, by name: saving it as a saved profile", async () => {
    const row = (await browserOn(worker.identity.workerId, "limited"));
    const sentence = /Saving a profile is not available yet for a browser on a worker, and limited is on worker-a\. Move it to the main instance first/;
    await assert.rejects(ctx.browsers.saveProfile(row.id, admin, { name: "x" }), sentence);
    // Desktop access and extensions go by the worker's own display. This one has none.
    assert.throws(() => ctx.browsers.updateAgentDesktop(row.id, true, admin), /requires a dedicated Xvfb display/);
    assert.throws(() => ctx.browsers.updateExtensions(row.id, true, admin), /requires a real browser on a dedicated Xvfb display/);
    assert.equal(row.extensions_enabled, 0, "extension support needs an X display, so it starts off there");
    await assert.rejects(
      async () => (await ctx.browsers.create({ principal: admin, via: "control_api", name: "seeded", workerId: worker.identity.workerId, seedId: "nope" })),
      /starts on the main instance, where saved profiles are kept/,
    );
  });

  it("moves a running browser in one step: stops it, copies its profile, and starts it on the new host", async () => {
    const row = (await browserOn(null, "mover"));
    mkdirSync(path.join(profileDir(row.id), "Default"), { recursive: true });
    writeFileSync(path.join(profileDir(row.id), "Default", "Cookies"), "signed-in");
    const there = path.join(worker.dataDir, "profiles", row.id, "Default", "Cookies");
    await ctx.browsers.ensureRunning(row.id);

    const phases: string[] = [];
    const listen = (ev: TallyEvent) => {
      if (ev.browserId !== row.id) return;
      if (ev.type === "browser.moving") phases.push(String(ev.payload.phase));
      if (ev.type === "browser.moved") phases.push(`moved:${ev.payload.restarted}`);
    };
    hub.on("event", listen);
    let moved;
    try {
      moved = await json(`${ctx.url}/api/v1/browsers/${row.id}/move`, {
        method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workerId: worker.identity.workerId }),
      });
    } finally {
      hub.off("event", listen);
    }
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const body = moved.body as { restarted: boolean; browser: { status: string; worker: { name: string } | null; moving: unknown } };
    assert.equal(body.restarted, true);
    assert.equal(body.browser.status, "running", "it is running again, on the worker");
    assert.equal(body.browser.worker?.name, "worker-a");
    assert.equal(body.browser.moving, null);
    assert.deepEqual(phases, ["stopping", "copying", "starting", "moved:true"]);
    assert.equal(readFileSync(there, "utf8"), "signed-in");
    assert.equal(existsSync(profileDir(row.id)), false, "the copy left behind is deleted");
    assert.match(ctx.browsers.noticesSince(row.id, 0).map((n) => n.text).join("\n"), /moved this browser from the main instance to worker-a .* Its tabs and logins came with it\. Everything works there as before, apart from saving it as a saved profile\./);

    // Stopped stays stopped.
    await ctx.browsers.stop(row.id);
    const back = await ctx.browsers.moveTo(row.id, null, admin);
    assert.equal(back.restarted, false);
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(row.id)).status, "stopped");
    assert.equal(readFileSync(path.join(profileDir(row.id), "Default", "Cookies"), "utf8"), "signed-in");
    assert.equal(existsSync(there), false);
    assert.equal(ctx.browsers.row(row.id).worker_id, null);
  });

  it("leaves a running browser running where it was when its move fails", async () => {
    const dead = await addWorker("worker-dead");
    const row = (await browserOn(null, "stayer"));
    await ctx.browsers.ensureRunning(row.id);
    // Answering the poll a moment ago, gone by the time the copy starts.
    await dead.close();
    await assert.rejects(ctx.browsers.moveTo(row.id, dead.identity.workerId, admin),
      /Could not move stayer to worker-dead: .*It is still on the main instance, and running again\./);
    const view = ctx.browsers.publicView(ctx.browsers.row(row.id));
    assert.deepEqual([view.status, view.worker, view.moving], ["running", null, null]);
    await ctx.browsers.stop(row.id);
    ctx.browsers.workers.remove(dead.identity.workerId, admin);
  });

  it("keeps a browser whose worker cannot confirm its profile is deleted", async () => {
    const gone = await addWorker("worker-gone");
    const row = (await browserOn(gone.identity.workerId, "stranded"));
    await gone.close();
    await assert.rejects(ctx.browsers.destroy(row.id, admin), /Worker worker-gone cannot be reached/);
    assert.equal(ctx.browsers.row(row.id).id, row.id, "the record stays, so the profile is not forgotten");
    assert.throws(() => ctx.browsers.workers.remove(gone.identity.workerId, admin), /1 browser still lives on worker-gone\. Move or delete it first/);
    getDb().prepare(`DELETE FROM browsers WHERE id = ?`).run(row.id);
    ctx.browsers.workers.remove(gone.identity.workerId, admin);
  });

  it("marks a browser crashed when its worker restarts or stops answering", async () => {
    const row = (await browserOn(worker.identity.workerId, "orphaned"));
    const rt = await ctx.browsers.ensureRunning(row.id);
    // The worker restarted: it says hello again, and whatever it was running is gone.
    ctx.browsers.workers.hello({ workerId: worker.identity.workerId, secret: worker.identity.secret, name: "worker-a", url: worker.url, version: ctx.browsers.workers.view(ctx.browsers.workers.row(worker.identity.workerId)).version });
    assert.notEqual(rt.chrome.exitCode, null);
    await ctx.browsers.reapIdle();
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(row.id)).status, "crashed");
    assert.equal(ctx.browsers.runtime(row.id), undefined);
    // A wrong secret is no hello at all.
    assert.throws(() => ctx.browsers.workers.hello({ workerId: worker.identity.workerId, secret: "nope", name: "x", url: worker.url, version: "1" }), /does not know that worker/);
    // The Chrome it left behind on the worker is stopped on the next poll.
    await ctx.browsers.workers.poll();
    await new Promise((r) => setTimeout(r, 200));
    const state = (await (await fetch(`${worker.url}/worker/v1/state`, { headers: { Authorization: `Bearer ${worker.identity.secret}` } })).json()) as { browsers: unknown[] };
    assert.equal(state.browsers.length, 0);
  });

  it("forgets thread measurements when a Chrome thread setting changes, and only then", async () => {
    const row = (await browserOn(null, "measured"));
    ctx.browsers.recordThreads(row.id, 606, 710);
    await ctx.browsers.recoverOnBoot(); // first boot of a release that keeps the record: nothing is known to have changed
    assert.equal(ctx.browsers.row(row.id).launch_threads, 606);
    await ctx.browsers.recoverOnBoot();
    assert.equal(ctx.browsers.row(row.id).launch_threads, 606, "an unchanged setting clears nothing");
    process.env.TALLYLAMP_CHROME_CPUS = "4";
    try {
      await ctx.browsers.recoverOnBoot();
      assert.deepEqual([ctx.browsers.row(row.id).launch_threads, ctx.browsers.row(row.id).peak_threads], [null, null]);
    } finally {
      delete process.env.TALLYLAMP_CHROME_CPUS;
    }
  });

  it("says when a reset would let a browser into its worker's room, and only then", async () => {
    // The worker checks a start against its own limit, so it is the worker that has to say so.
    // Here it reads the same fake cgroup as this instance, which does not check a worker's
    // browser against its own room at all.
    const cgroup = mkdtempSync(path.join(os.tmpdir(), "tallylamp-cgroup-"));
    dirs.push(cgroup);
    const pids = (current: number) => {
      writeFileSync(path.join(cgroup, "pids.max"), "1000\n");
      writeFileSync(path.join(cgroup, "pids.current"), `${current}\n`);
      writeFileSync(path.join(cgroup, "pids.events"), "max 0\n");
    };
    const row = (await browserOn(worker.identity.workerId, "heavy on the worker"));
    ctx.browsers.recordThreads(row.id, 606, 640); // sized at 783
    const refusal = () => ctx.browsers.ensureRunning(row.id)
      .then(() => assert.fail("the start was admitted"), (e: { code?: string; message: string }) => `${e.code}: ${e.message}`);
    process.env.TALLYLAMP_CGROUP_DIR = cgroup;
    try {
      pids(500); // 450 of room on the worker
      const refused = await refusal();
      assert.match(refused, /^fleet_full: Worker worker-a is out of room/);
      assert.match(refused, /needs about 783\. That estimate comes from an earlier start\. If it needs less now, the administrator can reset its thread counts on its page\. Stop a browser/);
      pids(800); // 150: a reset would not let it in either
      assert.doesNotMatch(await refusal(), /reset/);
    } finally {
      delete process.env.TALLYLAMP_CGROUP_DIR;
    }
  });

  it("relays a refusal as a refusal", async () => {
    // A relay that cannot reach its target answers 502 with a reason, not a hang.
    const http = await import("node:http");
    const dead = await allocatePort();
    const server = http.createServer((req, res) => forwardHttp(req, res, { host: "127.0.0.1", port: dead, path: "/x" }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/anything`);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "relay_failed");
    server.close();
  });
});
