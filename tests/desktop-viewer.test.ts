import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { desktopInput, desktopKey, JpegFrames, runDesktopViewer } from "../src/desktop-viewer.js";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import type { ChromeRuntime } from "../src/chrome.js";

describe("desktop input and framing", () => {
  it("parses split markers and multiple frames without retaining the whole stream", () => {
    const p = new JpegFrames();
    assert.deepEqual(p.push(Buffer.from([255, 216, 1, 255])), []);
    assert.deepEqual(p.push(Buffer.from([217, 255, 216, 2, 255, 217])), [Buffer.from([255, 216, 1, 255, 217]), Buffer.from([255, 216, 2, 255, 217])]);
    assert.throws(() => p.push(Buffer.alloc(4 * 1024 * 1024 + 1)), /limit/);
    assert.throws(() => new JpegFrames().push(Buffer.from([1, 255, 217])), /invalid/);
  });
  it("bounds coordinates, keys, paste and wheel repeats; never accepts command strings", () => {
    const size = { width: 1280, height: 800 };
    assert.equal(desktopKey("ctrl+alt+Delete"), null);
    assert.equal(desktopKey("é"), "U00e9");
    assert.equal(desktopKey("Enter"), "Return");
    assert.deepEqual(desktopInput({ type: "key", event: "rawKeyDown", key: "Tab" }, size), ["keydown", "Tab"]);
    // Each press carries the modifiers really held. Whatever else the display still has down is
    // stale, and one stale Shift turned every later letter uppercase.
    assert.deepEqual(desktopInput({ type: "key", event: "keyDown", key: "d", modifiers: 0 }, size),
      ["keyup", "Alt_L", "keyup", "Control_L", "keyup", "Super_L", "keyup", "Shift_L", "keydown", "U0064"]);
    assert.deepEqual(desktopInput({ type: "key", event: "keyDown", key: "D", modifiers: 8 }, size).slice(-4), ["keyup", "Super_L", "keydown", "U0044"]);
    assert.deepEqual(desktopInput({ type: "key", event: "rawKeyDown", key: "Shift", modifiers: 8 }, size).slice(-2), ["keydown", "Shift_L"]);
    assert.deepEqual(desktopInput({ type: "key", event: "keyUp", key: "d", modifiers: 0 }, size), ["keyup", "U0064"]);
    assert.deepEqual(desktopInput({ type: "mouse", event: "mousePressed", button: "left", x: 1, y: 1, modifiers: 8 }, size),
      ["keyup", "Alt_L", "keyup", "Control_L", "keyup", "Super_L", "mousemove", "1", "1", "mousedown", "1"]);
    assert.equal(desktopKey("CapsLock"), null, "the operator's key already has Caps Lock applied");
    assert.equal(desktopInput({ type: "mouse", event: "mouseMoved", x: -1, y: 0 }, size), null);
    assert.equal(desktopInput({ type: "mouse", event: "mouseMoved", x: Infinity, y: 0 }, size), null);
    assert.equal(desktopInput({ type: "mouse", event: "exec", x: 1, y: 2 }, size), null);
    assert.deepEqual(desktopInput({ type: "paste", text: "--window 1; $(bad)" }, size), ["type", "--clearmodifiers", "--delay", "0", "--", "--window 1; $(bad)"]);
    assert.equal(desktopInput({ type: "paste", text: "a".repeat(2049) }, size), null);
    assert.deepEqual(desktopInput({ type: "scroll", x: 1, y: 1, deltaY: 1e9 }, size), ["mousemove", "1", "1", "click", "--repeat", "5", "--delay", "0", "5"]);
  });
});

describe("extensions and full-browser authorization", () => {
  let ctx: TestCtx;
  let id: string;
  before(async () => {
    ctx = await startTestServer();
    const r = await json(`${ctx.url}/api/v1/browsers`, { method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "extensions", start: false }) });
    id = (r.body as { browser: { id: string } }).browser.id;
  });
  after(async () => { await ctx.close(); delete process.env.TALLYLAMP_XVFB; });
  const setting = (enabled: unknown, agent = false) => json(`${ctx.url}/api/v1/browsers/${id}/extensions`, {
    method: "PUT", headers: { ...(agent ? { Authorization: `Bearer ${ctx.agentToken}` } : { Cookie: ctx.cookie }), "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  });
  it("defaults extensions off, requires admin and a supported host, and validates boolean input", async () => {
    assert.equal(ctx.browsers.row(id).extensions_enabled, 0);
    assert.equal((await setting(true, true)).status, 403);
    assert.equal((await setting("yes")).status, 400);
    assert.equal((await setting(true)).status, 400);
  });
  it("enables from the dashboard API without a feature flag, persists the choice and refuses live changes", async () => {
    process.env.TALLYLAMP_XVFB = "1";
    process.env.TALLYLAMP_FAKE_CHROME = "0";
    try {
      const status = await json(`${ctx.url}/api/v1/status`, { headers: { Cookie: ctx.cookie } });
      assert.equal((status.body as { fullBrowser: boolean }).fullBrowser, true);
      // A control lease outlives a stop. The operator holding one is the only principal who can
      // flip this, so it must not lock them out of their own stopped browser.
      ctx.browsers.acquireControl(id, "human", "admin", { force: true });
      assert.equal((await setting(true)).status, 200);
      ctx.browsers.releaseControl(id);
      const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
      assert.equal(ctx.browsers.create({ principal: admin, via: "dashboard" }).extensions_enabled, 0);
      process.env.TALLYLAMP_EXTENSIONS_DEFAULT = "1";
      const defaulted = ctx.browsers.create({ principal: admin, via: "dashboard" });
      assert.equal(defaulted.extensions_enabled, 1);
      process.env.TALLYLAMP_FAKE_CHROME = "1";
      assert.equal(ctx.browsers.create({ principal: admin, via: "dashboard" }).extensions_enabled, 0, "no default on a host that cannot show Full browser");
      process.env.TALLYLAMP_FAKE_CHROME = "0";
      assert.equal((await json(`${ctx.url}/api/v1/browsers/${defaulted.id}/extensions`, { method: "PUT", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status, 200);
      assert.equal(ctx.browsers.row(defaulted.id).extensions_enabled, 0, "a saved choice wins while the default is on");
    }
    finally { process.env.TALLYLAMP_FAKE_CHROME = "1"; delete process.env.TALLYLAMP_EXTENSIONS_DEFAULT; }
    assert.equal(ctx.browsers.row(id).extensions_enabled, 1);
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(id)).extensionsEnabled, true);
    await ctx.browsers.ensureRunning(id);
    assert.equal((await setting(false)).status, 409);
  });
  it("refuses desktop access to fake/shared displays even with a valid viewer ticket", async () => {
    const t = await json(`${ctx.url}/api/v1/browsers/${id}/viewer-ticket`, { method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "watch" }) });
    const ws = new WebSocket(`${ctx.url.replace("http", "ws")}/api/v1/browsers/${id}/view?surface=desktop&ticket=${(t.body as { ticket: string }).ticket}`);
    const code = await new Promise<number>((resolve, reject) => { ws.on("close", resolve); ws.on("error", reject); });
    assert.equal(code, 1008);
    assert.equal(ctx.browsers.viewerCount(id), 0);
  });
  it("releases what a press pressed, however the release is spelled, and never forwards Caps Lock", () => {
    const rt = ctx.browsers.runtime(id)!;
    const original = { xvfb: rt.xvfb, display: rt.display };
    rt.xvfb = {} as ChromeRuntime["xvfb"]; rt.display = ":99";
    process.env.TALLYLAMP_FAKE_CHROME = "0";
    const children: EventEmitter[] = [];
    const calls: string[][] = [];
    const notices: string[] = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() { return true; } });
      if (cmd === "xdotool") { calls.push(args); queueMicrotask(() => child.emit("close", 0)); }
      children.push(child); return child;
    }) as unknown as typeof spawn;
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send(raw: string) { const m = JSON.parse(raw); if (m.type === "notice") notices.push(m.message); }, ping() {}, close(code: number) { this.emit("close", code); }, terminate() { this.emit("close", 1006); } });
    const send = (msg: object) => ws.emit("message", JSON.stringify(msg));
    try {
      const lease = ctx.browsers.acquireControl(id, "human", "admin", { force: true });
      runDesktopViewer(ws as unknown as WebSocket, ctx.browsers, id, "control", fakeSpawn);
      send({ type: "heartbeat", leaseToken: lease.leaseToken });
      send({ type: "key", event: "rawKeyDown", key: "CapsLock", code: "CapsLock", modifiers: 0 });
      assert.deepEqual(calls, []);
      assert.deepEqual(notices, [], "Caps Lock is ignored, not reported as a dropped key");
      // Option+2 types "@" on some layouts. Option comes up first, so the release reads "2".
      send({ type: "key", event: "keyDown", key: "@", code: "Digit2", modifiers: 1 });
      return new Promise<void>(resolve => setImmediate(() => {
        send({ type: "key", event: "keyUp", key: "2", code: "Digit2", modifiers: 0 });
        setImmediate(() => {
          try {
            assert.deepEqual(calls.at(-2)!.slice(-2), ["keydown", "U0040"]);
            assert.deepEqual(calls.at(-1), ["keyup", "U0040"], "xdotool pressed Shift for @; releasing 2 would leave it down");
          } finally {
            ws.close(1000); Object.assign(rt, original); process.env.TALLYLAMP_FAKE_CHROME = "1";
            for (const child of children) child.emit("close", 0);
            ctx.browsers.releaseControl(id);
          }
          resolve();
        });
      }));
    } catch (err) {
      ws.close(1000); Object.assign(rt, original); process.env.TALLYLAMP_FAKE_CHROME = "1";
      ctx.browsers.releaseControl(id);
      throw err;
    }
  });
  it("keeps watch read-only, binds input to a lease, revokes queued work, and cleans up children", () => {
    const rt = ctx.browsers.runtime(id)!;
    const original = { xvfb: rt.xvfb, display: rt.display };
    rt.xvfb = {} as ChromeRuntime["xvfb"];
    rt.display = ":99";
    process.env.TALLYLAMP_FAKE_CHROME = "0";
    const children: Array<EventEmitter & { stdout: PassThrough; killed: boolean; kill: () => boolean }> = [];
    const commands: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      commands.push(cmd);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
      children.push(child); return child;
    }) as unknown as typeof spawn;
    const socket = () => Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send() {}, ping() {}, close(code: number) { this.emit("close", code); }, terminate() { this.emit("close", 1006); } });
    const send = (ws: EventEmitter, msg: object) => ws.emit("message", JSON.stringify(msg));
    const watch = socket();
    const control = socket();
    try {
      const lease = ctx.browsers.acquireControl(id, "human", "admin");
      runDesktopViewer(watch as unknown as WebSocket, ctx.browsers, id, "watch", fakeSpawn);
      send(watch, { type: "heartbeat", leaseToken: lease.leaseToken });
      send(watch, { type: "key", event: "keyDown", key: "a" });
      assert.deepEqual(commands, ["ffmpeg"]);
      watch.close(4000);
      assert.equal(children[0].killed, true);
      runDesktopViewer(control as unknown as WebSocket, ctx.browsers, id, "control", fakeSpawn);
      send(control, { type: "key", event: "keyDown", key: "a" });
      assert.equal(commands.length, 2, "unbound socket cannot type");
      send(control, { type: "heartbeat", leaseToken: lease.leaseToken });
      send(control, { type: "key", event: "keyDown", key: "Shift" });
      send(control, { type: "key", event: "keyDown", key: "b" });
      assert.equal(commands.length, 3, "second input is queued, not spawned concurrently");
      ctx.browsers.acquireControl(id, "human", "another-admin", { force: true });
      assert.equal(children[2].killed, true, "forced takeover kills in-flight typing");
      const before = commands.length;
      children[2].emit("close", 0);
      send(control, { type: "key", event: "keyDown", key: "c" });
      assert.equal(commands.length, before, "old lease cannot execute queued or new input");
      control.close(1000);
      assert.equal(children[1].killed, true);
      assert.equal(ctx.browsers.viewerCount(id), 0);
      assert.equal(ctx.browsers.controlState(id).controllerId, "another-admin", "old socket must not release new lease");
    } finally {
      watch.close(4000); control.close(4000);
      Object.assign(rt, original); process.env.TALLYLAMP_FAKE_CHROME = "1";
      for (const child of children) child.emit("close", 0);
      ctx.browsers.releaseControl(id);
    }
  });
});
