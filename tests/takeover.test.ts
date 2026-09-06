import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { fakeCdpCalls, resetFakeCdp, setFakeTargets } from "../src/fake-chrome.js";
import { hub } from "../src/events.js";
import { safeCursor, safeNavigationUrl, cleanPaste } from "../src/viewer.js";

let ctx: TestCtx;
let browserId: string;

describe("human takeover", () => {
  before(async () => {
    ctx = await startTestServer();
    const r = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "takeover", start: true }),
    });
    browserId = (r.body as { browser: { id: string } }).browser.id;
  });
  after(async () => ctx.close());

  it("watch ticket is issued without granting control", async () => {
    const t = await json(`${ctx.url}/api/v1/browsers/${browserId}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "watch" }),
    });
    assert.equal(t.status, 200);
    const b = await json(`${ctx.url}/api/v1/browsers/${browserId}`, { headers: { Cookie: ctx.cookie } });
    assert.notEqual((b.body as { browser: { control: { controllerType: string } } }).browser.control.controllerType, "human");
  });

  it("interactive viewer ticket is refused while the agent holds the browser", async () => {
    const t = await json(`${ctx.url}/api/v1/browsers/${browserId}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "control" }),
    });
    assert.equal(t.status, 403);
  });

  it("admin can take control of the same browser", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers/${browserId}/control`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { control: { controllerType: string } }).control.controllerType, "human");
    assert.ok(ctx.browsers.isHumanControlled(browserId));
  });

  it("forced takeover is audited", async () => {
    const audit = await json(`${ctx.url}/api/v1/audit`, { headers: { Cookie: ctx.cookie } });
    const events = (audit.body as { events: Array<{ action: string }> }).events;
    assert.ok(events.some((e) => e.action === "human.takeover" || e.action === "control.forced"));
  });

  it("returning control releases the human lease", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers/${browserId}/control`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { control: { controllerType: string } }).control.controllerType, "none");
  });

  it("stale leases expire", async () => {
    process.env.TALLYLAMP_HUMAN_LEASE_TTL_SEC = "0";
    ctx.browsers.acquireControl(browserId, "human", "admin");
    await new Promise((r) => setTimeout(r, 20));
    const state = ctx.browsers.controlState(browserId);
    assert.equal(state.controllerType, "none");
    delete process.env.TALLYLAMP_HUMAN_LEASE_TTL_SEC;
  });
});

describe("watching keeps a browser alive", () => {
  let own: TestCtx;
  before(async () => {
    own = await startTestServer();
  });
  after(async () => own.close());

  it("counts a live viewer as attachment and survives the idle reaper", async () => {
    const created = await json(`${own.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "watched", start: true }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "watch" }),
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(own.browsers.viewerCount(id), 1, "an open watch socket must register as a viewer");

    // A 1s unattached TTL: only being attached can save it. (A TTL of 0 disables the
    // reaper entirely, so it would prove nothing.)
    process.env.TALLYLAMP_IDLE_TTL_SEC = "1";
    try {
      await new Promise((r) => setTimeout(r, 1200));
      await own.browsers.reapIdle();
      const still = await json(`${own.url}/api/v1/browsers/${id}`, { headers: { Cookie: own.cookie } });
      assert.equal(
        (still.body as { browser: { status: string } }).browser.status,
        "running",
        "a watched browser must not be reaped",
      );

      ws.close();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(own.browsers.viewerCount(id), 0, "closing the tab must release the viewer");
    } finally {
      delete process.env.TALLYLAMP_IDLE_TTL_SEC;
      try { ws.close(); } catch { /* ignore */ }
    }
  });

  it("does not let a watch tab's heartbeat pass for activity", async () => {
    const created = await json(`${own.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unwatched-really", start: true }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "watch" }),
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 300));

    try {
      const before = own.browsers.row(id).last_activity_at;
      // The dashboard sends this on a timer with nobody necessarily in front of it. It used to
      // touch(), which reset the idle clock forever and, with the attached TTL on top, pinned
      // ~1 GB of Chrome for the life of the process.
      await new Promise((r) => setTimeout(r, 1100));
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: "not-a-lease" }));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        own.browsers.row(id).last_activity_at,
        before,
        "a watch-mode heartbeat must not count as activity",
      );
      assert.equal(own.browsers.viewerCount(id), 1, "it must still register as attachment, though");
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  });

  it("reaps the same browser once nobody is watching", async () => {
    const created = await json(`${own.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unwatched", start: true }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    process.env.TALLYLAMP_IDLE_TTL_SEC = "1";
    try {
      await new Promise((r) => setTimeout(r, 1200));
      await own.browsers.reapIdle();
      const after = await json(`${own.url}/api/v1/browsers/${id}`, { headers: { Cookie: own.cookie } });
      assert.notEqual((after.body as { browser: { status: string } }).browser.status, "running");
    } finally {
      delete process.env.TALLYLAMP_IDLE_TTL_SEC;
    }
  });
});

/**
 * The viewer socket gained two mutating message types — switching the tab the agent is on,
 * and resizing the real Chrome window. Both share state with a running agent, so both have to
 * sit behind the same gate as mouse and key input, and the size has to be clamped before it
 * reaches Chrome.
 */
describe("viewer tab strip and 1:1 window", () => {
  let own: TestCtx;
  let id: string;

  const openSocket = async (mode: "watch" | "control") => {
    const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    assert.equal(t.status, 200, `${mode} ticket must be issued`);
    const ticket = (t.body as { ticket: string }).ticket;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`);
    const seen: Array<Record<string, unknown>> = [];
    ws.on("message", (raw) => {
      try {
        seen.push(JSON.parse(String(raw)));
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    // Let the connect sequence (discover, attach, hello, tabs) finish.
    await new Promise((r) => setTimeout(r, 250));
    return { ws, seen };
  };

  /**
   * What the dashboard actually does: send on the socket's own `open` event, with no wait.
   * The server finishes several CDP round trips before it can look at a message, and ws
   * discards anything that arrives with no listener — so this is the shape that matters.
   */
  const openSocketSendingImmediately = async (mode: "watch" | "control", msgs: unknown[]) => {
    const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`);
    const seen: Array<Record<string, unknown>> = [];
    ws.on("message", (raw) => {
      try {
        seen.push(JSON.parse(String(raw)));
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        for (const m of msgs) ws.send(JSON.stringify(m));
        resolve();
      });
      ws.on("error", reject);
    });
    return { ws, seen };
  };

  const settle = () => new Promise((r) => setTimeout(r, 900));
  const sized = () => fakeCdpCalls.filter((c) => c.method === "Browser.setContentsSize");
  const attaches = () => fakeCdpCalls.filter((c) => c.method === "Target.attachToTarget");

  before(async () => {
    own = await startTestServer();
    const created = await json(`${own.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "viewer-surface", start: true }),
    });
    id = (created.body as { browser: { id: string } }).browser.id;
  });
  after(async () => own.close());

  it("streams the tab that went somewhere, not the about:blank startup tab", async () => {
    const { ws, seen } = await openSocket("watch");
    try {
      const tabs = seen.find((m) => m.type === "tabs") as
        | { tabs: Array<{ targetId: string; url: string }>; activeTargetId: string }
        | undefined;
      assert.ok(tabs, "the viewer must push a tab list");
      assert.equal(tabs!.tabs.length, 2, "both page targets must be listed");
      assert.equal(
        tabs!.activeTargetId,
        "t2",
        "a browser whose agent opened a second tab must not strand the human on about:blank",
      );
    } finally {
      ws.close();
    }
  });

  it("a watch socket cannot resize the window or switch the tab", async () => {
    const { ws } = await openSocket("watch");
    try {
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "viewport", width: 900, height: 700 }));
      ws.send(JSON.stringify({ type: "selectTab", targetId: "t1" }));
      await settle();
      assert.equal(sized().length, 0, "watch mode must not reach Browser.setContentsSize");
      assert.equal(attaches().length, 0, "watch mode must not switch the streamed target");
      assert.equal(ws.readyState, ws.OPEN, "an ignored message must not kill the socket");
    } finally {
      ws.close();
    }
  });

  it("a control socket that never heartbeats is not bound to the lease", async () => {
    own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      resetFakeCdp();
      // No heartbeat: the socket has not proved which lease it holds.
      ws.send(JSON.stringify({ type: "viewport", width: 900, height: 700 }));
      await settle();
      assert.equal(sized().length, 0, "an unbound control socket must not resize the window");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("a control socket bound to a superseded lease is cut off", async () => {
    const first = own.browsers.acquireControl(id, "human", "admin-a", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: first.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      // A second operator takes the browser. The first socket's lease token is now stale.
      own.browsers.acquireControl(id, "human", "admin-b", { force: true });
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "viewport", width: 900, height: 700 }));
      await settle();
      assert.equal(sized().length, 0, "a socket whose lease was taken must stop driving");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("a bound control socket resizes the window once, coalescing a burst", async () => {
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      resetFakeCdp();
      for (let i = 0; i < 200; i++) {
        ws.send(JSON.stringify({ type: "viewport", width: 900 + i, height: 700 }));
      }
      await settle();
      const calls = sized();
      assert.ok(calls.length >= 1, "a bound control socket must be able to resize");
      assert.ok(calls.length <= 2, `200 requests must coalesce, got ${calls.length}`);
      // Latest wins, not first: a burst is a drag in progress, and the size the operator
      // stopped at is the one they want.
      assert.equal(calls[calls.length - 1]!.params.width, 1099);
      assert.equal(calls[calls.length - 1]!.params.height, 700);
      // The screencast clamp has to follow the window, or every click is scaled by the ratio.
      const cast = fakeCdpCalls.filter((c) => c.method === "Page.startScreencast").pop();
      assert.equal(cast!.params.maxWidth, 1099, "the screencast clamp must track the new size");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("clamps every hostile dimension instead of passing it to Chrome", async () => {
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      // NaN and Infinity reach the server as null, because that is what JSON.stringify does
      // with them; Chrome's int32 deserializer rejects those into an unhandled rejection.
      const hostile = [
        { width: -1, height: -1 },
        { width: 999999, height: 999999 },
        { width: Number.NaN, height: Number.NaN },
        { width: "800", height: "600" },
        {},
      ];
      for (const h of hostile) {
        resetFakeCdp();
        ws.send(JSON.stringify({ type: "viewport", ...h }));
        await settle();
        for (const c of sized()) {
          const w = c.params.width as number;
          const hh = c.params.height as number;
          assert.ok(Number.isInteger(w) && w >= 320 && w <= 2560, `width ${w} escaped the clamp`);
          assert.ok(Number.isInteger(hh) && hh >= 240 && hh <= 1600, `height ${hh} escaped the clamp`);
        }
      }
      assert.equal(ws.readyState, ws.OPEN, "hostile input must not take the socket down");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("honours the heartbeat and viewport the dashboard sends on open, before setup finished", async () => {
    // Regression: ws.on("message") was registered only after the whole CDP setup, and ws does
    // not buffer — so the dashboard's open-time heartbeat and viewport were silently dropped.
    // The lease never bound (every later action came back "lease expired") and the 1:1 resize
    // request was lost with no path to recover it, because the client had already recorded the
    // size it thought it had asked for.
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    resetFakeCdp();
    const { ws, seen } = await openSocketSendingImmediately("control", [
      { type: "heartbeat", leaseToken: lease.leaseToken },
      { type: "viewport", width: 900, height: 700 },
    ]);
    try {
      await settle();
      assert.ok(
        sized().some((c) => c.params.width === 900 && c.params.height === 700),
        "the viewport sent on open must reach Chrome",
      );
      assert.ok(
        !seen.some((m) => m.type === "error" && m.message === "lease expired"),
        "a heartbeat sent on open must bind the lease, not be refused",
      );
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("a socket that dies mid-setup does not leak a viewer or a listener", async () => {
    // Regression: attachViewer and the hub subscription both ran before ws.on("close") was
    // registered, so an aborted connect left a phantom viewer that kept the browser off the
    // idle reaper and permanently blocked the window-restore fallback.
    // Let the previous test's socket finish closing, or the baseline is its viewer, not ours.
    await settle();
    const before = own.browsers.viewerCount(id);
    const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "watch" }),
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`);
    ws.on("error", () => undefined);
    ws.on("upgrade", () => ws.terminate());
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(own.browsers.viewerCount(id), before, "an aborted connect must not leave a viewer behind");
    assert.ok(
      hub.listenerCount(`browser:${id}`) <= 1,
      `an aborted connect must not leave a hub listener behind, saw ${hub.listenerCount(`browser:${id}`)}`,
    );
  });

  it("navigates where the operator asks, and refuses schemes the proxy cannot police", async () => {
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws, seen } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));

      resetFakeCdp();
      ws.send(JSON.stringify({ type: "navigate", url: "https://example.test/page" }));
      await settle();
      const nav = fakeCdpCalls.filter((c) => c.method === "Page.navigate");
      assert.equal(nav.length, 1, "a plain https address must be opened");
      assert.equal(nav[0]!.params.url, "https://example.test/page");

      // file: reads the container's disk and javascript: runs in the current page's origin;
      // neither goes through the egress proxy, which is where the SSRF policy lives.
      for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "devtools://x"]) {
        resetFakeCdp();
        seen.length = 0;
        ws.send(JSON.stringify({ type: "navigate", url }));
        await settle();
        assert.equal(
          fakeCdpCalls.filter((c) => c.method === "Page.navigate").length,
          0,
          `${url} must not reach Page.navigate`,
        );
        assert.ok(seen.some((m) => m.type === "notice"), `${url} must be reported back, not dropped silently`);
      }
      assert.equal(ws.readyState, ws.OPEN);
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("a watch socket cannot navigate, open or close a tab", async () => {
    const { ws } = await openSocket("watch");
    try {
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "navigate", url: "https://example.test/" }));
      ws.send(JSON.stringify({ type: "newTab" }));
      ws.send(JSON.stringify({ type: "closeTab", targetId: "t1" }));
      ws.send(JSON.stringify({ type: "reload" }));
      await settle();
      for (const m of ["Page.navigate", "Target.createTarget", "Target.closeTarget", "Page.reload"]) {
        assert.equal(fakeCdpCalls.filter((c) => c.method === m).length, 0, `watch mode must not reach ${m}`);
      }
    } finally {
      ws.close();
    }
  });

  it("opens a new tab and refuses to close the last one", async () => {
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));

      resetFakeCdp();
      ws.send(JSON.stringify({ type: "newTab" }));
      await settle();
      assert.equal(
        fakeCdpCalls.filter((c) => c.method === "Target.createTarget").length,
        1,
        "the new tab button must create a target",
      );

      // The fake reports two tabs, so one close is allowed; a browser down to its last tab
      // must not be closeable, or Chrome exits with the window.
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "closeTab", targetId: "t1" }));
      await settle();
      assert.equal(fakeCdpCalls.filter((c) => c.method === "Target.closeTarget").length, 1);

      resetFakeCdp();
      ws.send(JSON.stringify({ type: "closeTab", targetId: "nope" }));
      await settle();
      assert.equal(
        fakeCdpCalls.filter((c) => c.method === "Target.closeTarget").length,
        0,
        "an unknown target must not be closed",
      );
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("refuses to close the second-to-last tab twice in one batch", async () => {
    // Regression: the last-tab guard counted `targets`, which is only pruned when Chrome
    // answers targetDestroyed. Two closes in one batch both saw two tabs, both fired, and the
    // browser exited with its last window — the exact outcome the guard exists to prevent.
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "closeTab", targetId: "t1" }));
      ws.send(JSON.stringify({ type: "closeTab", targetId: "t2" }));
      await settle();
      const closes = fakeCdpCalls.filter((c) => c.method === "Target.closeTarget");
      assert.equal(closes.length, 1, `only one of two tabs may close, got ${closes.length}`);
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("strips the start page from a tab before switching away from it", async () => {
    // Regression: the injection was tracked by one boolean, so switching tabs stranded a copy
    // on every tab it had ever dressed and only the last was cleaned on release.
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      // Land on the blank tab so it gets dressed, then move off it.
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "selectTab", targetId: "t1" }));
      await settle();
      const injected = fakeCdpCalls.filter(
        (c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("tallylamp-start"),
      );
      assert.ok(injected.length >= 1, "an about:blank tab must get the start page");

      resetFakeCdp();
      ws.send(JSON.stringify({ type: "selectTab", targetId: "t2" }));
      await settle();
      const removed = fakeCdpCalls.filter(
        (c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("tallylamp-start-style"),
      );
      assert.ok(removed.length >= 1, "leaving a dressed tab must strip it on the way out");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("does not dress a tab once the lease it bound to is gone", async () => {
    // The socket's mode is fixed for its lifetime; the lease is not.
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      own.browsers.releaseControl(id);
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "selectTab", targetId: "t1" }));
      await settle();
      const injected = fakeCdpCalls.filter(
        (c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("tl-card"),
      );
      assert.equal(injected.length, 0, "an expired lease must not write into the agent's page");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("dresses the tab it landed on once the lease binds", async () => {
    // Regression: showStartPage was gated on the bound lease but called from attach(), which
    // runs during socket setup — before any message, including the heartbeat that binds it. So
    // the tab you actually land on was never dressed and about:blank stayed a white void.
    // A browser sitting on its blank startup tab alone, which is what the operator reported.
    setFakeTargets([{ targetId: "t1", type: "page", title: "New Tab", url: "about:blank" }]);
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    resetFakeCdp();
    const { ws } = await openSocket("control");
    try {
      // Nothing may be dressed yet: setup has not read a message, so no lease is bound.
      assert.equal(
        fakeCdpCalls.filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("tl-card")).length,
        0,
        "an unbound socket must not write into the page",
      );
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await settle();
      const injected = fakeCdpCalls.filter(
        (c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("tl-card"),
      );
      assert.equal(injected.length, 1, "the blank tab must be dressed exactly once, when the lease binds");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
      setFakeTargets(null);
    }
  });

  it("types a pasted clipboard into the page, and only for a bound controller", async () => {
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      resetFakeCdp();
      // Before the heartbeat binds the lease, a paste must go nowhere.
      ws.send(JSON.stringify({ type: "paste", text: "secret" }));
      await settle();
      assert.equal(
        fakeCdpCalls.filter((c) => c.method === "Input.insertText").length,
        0,
        "an unbound socket must not type into the page",
      );

      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "paste", text: "user@example.com" }));
      await settle();
      const typed = fakeCdpCalls.filter((c) => c.method === "Input.insertText");
      assert.equal(typed.length, 1, "a bound controller's paste must reach the page");
      assert.equal(typed[0]!.params.text, "user@example.com");
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("a watch socket cannot paste", async () => {
    const { ws } = await openSocket("watch");
    try {
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "paste", text: "nope" }));
      await settle();
      assert.equal(fakeCdpCalls.filter((c) => c.method === "Input.insertText").length, 0);
      assert.equal(ws.readyState, ws.OPEN);
    } finally {
      ws.close();
    }
  });

  it("caps the encoded frame however big the stage gets", async () => {
    // The window follows the stage so the layout and aspect stay right, but the number of
    // pixels actually encoded does not: 1440x800 at q70 measured 143 KB a frame, which is
    // 2.2 MB/s at 15fps and more than a link to a hosted container will carry. Clicks map
    // through the frame's own reported size, so a smaller encode stays exact.
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));
      resetFakeCdp();
      ws.send(JSON.stringify({ type: "viewport", width: 2400, height: 1400 }));
      await settle();
      const sized = fakeCdpCalls.filter((c) => c.method === "Browser.setContentsSize");
      assert.equal(sized[0]!.params.width, 2400, "the window itself follows the stage");
      const cast = fakeCdpCalls.filter((c) => c.method === "Page.startScreencast").pop();
      assert.ok(cast, "the screencast must restart at the new size");
      const w = cast!.params.maxWidth as number;
      const h = cast!.params.maxHeight as number;
      assert.ok(w <= 1280, `the encode must be capped, got ${w}`);
      // Aspect has to survive the cap, or the picture is stretched and clicks skew with it.
      assert.ok(Math.abs(w / h - 2400 / 1400) < 0.02, `aspect drifted: ${w}x${h}`);
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });

  it("switches to a tab it knows about, and ignores one it does not", async () => {
    const lease = own.browsers.acquireControl(id, "human", "admin", { force: true });
    const { ws } = await openSocket("control");
    try {
      ws.send(JSON.stringify({ type: "heartbeat", leaseToken: lease.leaseToken }));
      await new Promise((r) => setTimeout(r, 100));

      resetFakeCdp();
      ws.send(JSON.stringify({ type: "selectTab", targetId: "does-not-exist" }));
      await settle();
      assert.equal(attaches().length, 0, "an undiscovered target must not be attached");

      resetFakeCdp();
      ws.send(JSON.stringify({ type: "selectTab", targetId: "t1" }));
      await settle();
      const att = attaches();
      assert.equal(att.length, 1, "switching must attach exactly once");
      assert.equal(att[0]!.params.targetId, "t1");
      // A background tab does not composite, so it would stream nothing without this.
      assert.ok(
        fakeCdpCalls.some((c) => c.method === "Target.activateTarget" && c.params.targetId === "t1"),
        "the tab must be brought to the foreground before it is streamed",
      );
      assert.ok(
        fakeCdpCalls.some((c) => c.method === "Target.detachFromTarget"),
        "the previous tab's session must be detached, not left streaming",
      );
    } finally {
      ws.close();
      own.browsers.releaseControl(id);
    }
  });
});

/**
 * The cursor the dashboard applies to a style property comes from a remote page, so it is a
 * security boundary rather than a cosmetic one: a computed cursor may legitimately be
 * `url("https://attacker/x.png"), pointer`, and assigning that unfiltered would make the
 * operator's browser fetch an attacker-chosen URL on hover.
 */
describe("remote cursor values are filtered to keywords", () => {
  it("keeps real keywords", () => {
    for (const c of ["pointer", "text", "grab", "not-allowed", "ns-resize", "zoom-in", "default"]) {
      assert.equal(safeCursor(c), c);
    }
  });

  it("strips a url() cursor down to its keyword fallback", () => {
    // Exactly what Chrome returns for `cursor: url(...), pointer` — verified against a real browser.
    assert.equal(safeCursor('url("https://evil.example/x.png"), pointer'), "pointer");
    assert.equal(safeCursor('url("https://evil.example/a,b.png"), text'), "text");
  });

  it("falls back to default for anything it does not recognise", () => {
    for (const c of ['url("https://evil.example/x.png")', "expression(alert(1))", "", "POINTER; x", 42, null, undefined, {}]) {
      const got = safeCursor(c as unknown);
      assert.ok(got === "default" || CURSOR_OK.has(got), `unexpected cursor ${JSON.stringify(got)} from ${JSON.stringify(c)}`);
    }
    assert.equal(safeCursor('url("https://evil.example/x.png")'), "default");
    assert.equal(safeCursor("javascript:alert(1)"), "default");
  });

  it("is case-insensitive, as CSS is", () => {
    assert.equal(safeCursor("POINTER"), "pointer");
  });
});

const CURSOR_OK = new Set(["pointer", "text", "default", "auto"]);

describe("address bar URLs are checked before they reach Chrome", () => {
  it("accepts http and https", () => {
    assert.equal(safeNavigationUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
    assert.equal(safeNavigationUrl("  http://example.com/  "), "http://example.com/");
    assert.equal(safeNavigationUrl("about:blank"), "about:blank");
  });

  it("refuses every scheme that bypasses the egress proxy", () => {
    for (const u of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "chrome://settings",
      "devtools://devtools/bundled/x.html",
      "data:text/html,<h1>x",
      "view-source:https://example.com",
      "blob:https://example.com/x",
      "ws://example.com",
    ]) {
      assert.equal(safeNavigationUrl(u), null, `${u} must be refused`);
    }
  });

  it("refuses junk without throwing", () => {
    for (const u of ["", "   ", "not a url", 42, null, undefined, {}, "https://" + "a".repeat(5000)]) {
      assert.equal(safeNavigationUrl(u as unknown), null);
    }
  });
});

describe("pasted text is cleaned before it is typed", () => {
  it("keeps ordinary text, tabs and newlines", () => {
    assert.equal(cleanPaste("user@example.com"), "user@example.com");
    assert.equal(cleanPaste("a\tb\nc"), "a\tb\nc");
    assert.equal(cleanPaste("  spaces kept  "), "  spaces kept  ");
  });

  it("normalises CRLF, so a Windows paste is not double-spaced", () => {
    assert.equal(cleanPaste("one\r\ntwo\rthree"), "one\ntwo\nthree");
  });

  it("drops control characters nobody meant to paste", () => {
    assert.equal(cleanPaste("a\u0000b\u0007c\u001bd\u007f"), "abcd");
  });

  it("caps the length, because a frame over 64 KiB kills the socket", () => {
    const big = "x".repeat(20000);
    assert.equal(cleanPaste(big)!.length, 16 * 1024);
  });

  it("refuses junk without throwing", () => {
    for (const v of ["", 42, null, undefined, {}, "\u0000"]) {
      assert.equal(cleanPaste(v as unknown), null);
    }
  });
});

describe("a viewer that goes away releases what it was holding", () => {
  let own: TestCtx;
  let id: string;

  before(async () => {
    own = await startTestServer();
    const created = await json(`${own.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "handback", start: true }),
    });
    id = (created.body as { browser: { id: string } }).browser.id;
  });
  after(async () => own.close());

  /** Take control as the operator, then open the control socket and bind it to that lease. */
  const takeAndBind = async () => {
    const r = await json(`${own.url}/api/v1/browsers/${id}/control`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const leaseToken = (r.body as { control: { leaseToken: string } }).control.leaseToken;
    const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "control" }),
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // The heartbeat is what binds this socket to the lease; nothing else is accepted first.
        ws.send(JSON.stringify({ type: "heartbeat", leaseToken }));
        resolve();
      });
      ws.on("error", reject);
    });
    await new Promise((r2) => setTimeout(r2, 300));
    assert.ok(own.browsers.isHumanControlled(id), "the operator must hold the browser first");
    return ws;
  };

  it("hands control back to the agent when the operator leaves the page", async () => {
    const ws = await takeAndBind();
    // Exactly what the dashboard does on leaving the detail view for the fleet list, and on
    // unload: teardownViewer() closes the socket with 1000.
    ws.close(1000, "navigated away");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      own.browsers.controlState(id).controllerType,
      "none",
      "leaving the page must hand the browser back, not make the agent wait out the lease",
    );
  });

  it("keeps the lease when the link merely drops, so a blip does not interrupt the operator", async () => {
    const ws = await takeAndBind();
    // 1006: no close frame, which is what a dropped connection or a slept laptop looks like.
    // The client reconnects on this, so handing the browser over would be wrong.
    ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      own.browsers.controlState(id).controllerType,
      "human",
      "an abnormal close is transient; only the lease TTL should resolve it",
    );
    await json(`${own.url}/api/v1/browsers/${id}/control`, { method: "DELETE", headers: { Cookie: own.cookie } });
  });

  it("reclaims a socket that stops answering pings", async () => {
    process.env.TALLYLAMP_VIEWER_PING_SEC = "1";
    try {
      const t = await json(`${own.url}/api/v1/browsers/${id}/viewer-ticket`, {
        method: "POST",
        headers: { Cookie: own.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "watch" }),
      });
      const ticket = (t.body as { ticket: string }).ticket;
      const WebSocket = (await import("ws")).default;
      // autoPong off is the whole point: this is a socket that is open at the TCP level and
      // answers nothing, which is what a slept laptop looks like from here.
      const ws = new WebSocket(`${own.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`, {
        autoPong: false,
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(own.browsers.viewerCount(id), 1, "it must register as a viewer to begin with");
      // One interval to send the ping, a second to notice it was never answered.
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(
        own.browsers.viewerCount(id),
        0,
        "a socket that answers nothing must not keep a browser pinned as watched",
      );
      try { ws.close(); } catch { /* already gone */ }
    } finally {
      delete process.env.TALLYLAMP_VIEWER_PING_SEC;
    }
  });
});
