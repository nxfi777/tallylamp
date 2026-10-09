import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { desktopInput, desktopKey, JpegFrames, runDesktopViewer, streamWidth } from "../src/desktop-viewer.js";
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
  it("streams the display's own width unless the stage cannot show it", () => {
    // 1600 was the old flat cap, and shrinking 2560 to it is what blurred the text.
    assert.equal(streamWidth(2560), 2560);
    assert.equal(streamWidth(2560, 2880), 2560, "a retina stage never asks for more than exists");
    assert.equal(streamWidth(2560, 1801), 1800, "ffmpeg's mjpeg needs an even width");
    assert.equal(streamWidth(2560, 640), 1280, "nothing is legible under the floor");
    assert.equal(streamWidth(1024, 640), 1024, "and the floor never upscales a small display");
    for (const junk of [0, -5, NaN, Infinity]) assert.equal(streamWidth(2560, junk), 2560);
  });
  it("bounds coordinates, keys, paste and wheel repeats; never accepts command strings", () => {
    const size = { width: 1280, height: 800 };
    assert.equal(desktopKey("ctrl+alt+Delete"), null);
    assert.equal(desktopKey("é"), "U00e9");
    assert.equal(desktopKey("Enter"), "Return");
    assert.deepEqual(desktopInput({ type: "key", event: "rawKeyDown", key: "Tab" }, size), ["keydown", "Tab"]);
    // Each press carries the modifiers really held. Whatever else the display still has down is
    // stale, and one stale Shift turned every later letter uppercase. Each cleanup release
    // skips xdotool's default 12ms sleep without changing the operator's actual key events.
    assert.deepEqual(desktopInput({ type: "key", event: "keyDown", key: "d", modifiers: 0 }, size),
      ["keyup", "--delay", "0", "Alt_L", "keyup", "--delay", "0", "Control_L", "keyup", "--delay", "0", "Super_L", "keyup", "--delay", "0", "Shift_L", "keydown", "U0064"]);
    assert.deepEqual(desktopInput({ type: "key", event: "keyDown", key: "D", modifiers: 8 }, size),
      ["keyup", "--delay", "0", "Alt_L", "keyup", "--delay", "0", "Control_L", "keyup", "--delay", "0", "Super_L", "keydown", "U0044"]);
    assert.deepEqual(desktopInput({ type: "key", event: "rawKeyDown", key: "Shift", modifiers: 8 }, size).slice(-2), ["keydown", "Shift_L"]);
    assert.deepEqual(desktopInput({ type: "key", event: "keyUp", key: "d", modifiers: 0 }, size), ["keyup", "U0064"]);
    assert.deepEqual(desktopInput({ type: "mouse", event: "mousePressed", button: "left", x: 1, y: 1, modifiers: 8 }, size),
      ["keyup", "--delay", "0", "Alt_L", "keyup", "--delay", "0", "Control_L", "keyup", "--delay", "0", "Super_L", "mousemove", "1", "1", "mousedown", "1"]);
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
  it("defaults extensions off without Full browser, requires admin and a supported host, and validates boolean input", async () => {
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
      const defaulted = (await ctx.browsers.create({ principal: admin, via: "dashboard" }));
      assert.equal(defaulted.extensions_enabled, 1, "extension support is on by default on a Full browser host");
      process.env.TALLYLAMP_EXTENSIONS_DEFAULT = "0";
      assert.equal((await ctx.browsers.create({ principal: admin, via: "dashboard" })).extensions_enabled, 0, "the env flag still turns the default off");
      delete process.env.TALLYLAMP_EXTENSIONS_DEFAULT;
      process.env.TALLYLAMP_FAKE_CHROME = "1";
      assert.equal((await ctx.browsers.create({ principal: admin, via: "dashboard" })).extensions_enabled, 0, "no default on a host that cannot show Full browser");
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
    const captureArgs: string[][] = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      commands.push(cmd);
      if (cmd === "ffmpeg") captureArgs.push(args);
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
      assert.equal(captureArgs[0][captureArgs[0].indexOf("-framerate") + 1], "6", "watch retains its lower capture cost");
      send(watch, { type: "heartbeat", leaseToken: lease.leaseToken });
      send(watch, { type: "key", event: "keyDown", key: "a" });
      assert.deepEqual(commands, ["ffmpeg"]);
      watch.close(4000);
      assert.equal(children[0].killed, true);
      runDesktopViewer(control as unknown as WebSocket, ctx.browsers, id, "control", fakeSpawn);
      const rateIndex = captureArgs[1].indexOf("-framerate") + 1;
      assert.equal(captureArgs[1][rateIndex], "15", "interactive control has a shorter frame interval");
      assert.deepEqual(captureArgs[1].map((value, index) => index === rateIndex ? "6" : value), captureArgs[0], "control changes cadence without reducing image quality or dimensions");
      send(control, { type: "key", event: "keyDown", key: "a" });
      assert.equal(commands.length, 2, "unbound socket cannot type");
      send(control, { type: "heartbeat", leaseToken: lease.leaseToken });
      send(control, { type: "key", event: "keyDown", key: "Shift" });
      send(control, { type: "key", event: "keyDown", key: "b" });
      assert.equal(commands.length, 3, "second input is queued, not spawned concurrently");
      send(control, { type: "visibility", visible: false });
      assert.equal(children[1].killed, true, "hiding stops capture");
      assert.equal(children[2].killed, false, "hiding does not cancel an accepted input");
      assert.equal(commands.length, 3, "hiding preserves the input queue");
      assert.equal(ctx.browsers.controlState(id).leaseToken, lease.leaseToken, "capture visibility does not release the lease");
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

  for (const remote of [false, true]) {
    it(`stops ${remote ? "remote" : "local"} capture while hidden and resumes with a fresh frame`, (t) => {
      const rt = ctx.browsers.runtime(id)!;
      const original = { xvfb: rt.xvfb, display: rt.display, desktopSpawn: rt.desktopSpawn };
      rt.xvfb = {} as ChromeRuntime["xvfb"]; rt.display = ":99";
      process.env.TALLYLAMP_FAKE_CHROME = "0";
      const sent: Buffer[] = [], errors: string[] = [];
      const captures: Array<EventEmitter & { stdout: PassThrough; killed: boolean; kill: () => boolean }> = [];
      const commands: string[][] = [];
      const firstFrameTimers = new Set<ReturnType<typeof setTimeout>>();
      const firstFrameCallbacks: Array<() => void> = [];
      const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
      t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        const timer = realSetTimeout(callback, delay, ...args);
        if (delay === 10_000) { firstFrameTimers.add(timer); firstFrameCallbacks.push(() => callback(...args)); }
        return timer;
      });
      t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
        firstFrameTimers.delete(timer as ReturnType<typeof setTimeout>); realClearTimeout(timer);
      });
      const fakeSpawn = ((cmd: string, args: string[]) => {
        assert.equal(cmd, "ffmpeg"); commands.push(args);
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), killed: false,
          kill() { this.killed = true; if (remote) this.emit("exit", null, "SIGKILL"); return true; } });
        captures.push(child); return child;
      }) as unknown as typeof spawn;
      if (remote) rt.desktopSpawn = fakeSpawn;
      const ws = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0,
        send(raw: string | Buffer) { if (Buffer.isBuffer(raw)) sent.push(Buffer.from(raw)); else { const data = JSON.parse(raw); if (data.type === "error") errors.push(data.message); } },
        ping() {}, close(code: number) { this.emit("close", code); }, terminate() { this.emit("close", 1006); } });
      const visible = (value: boolean) => ws.emit("message", JSON.stringify({ type: "visibility", visible: value }));
      const frame = Buffer.from([255, 216, 7, 255, 217]);
      try {
        runDesktopViewer(ws as unknown as WebSocket, ctx.browsers, id, "watch", remote ? (() => assert.fail("must use runtime's remote spawner")) as unknown as typeof spawn : fakeSpawn);
        assert.equal(captures.length, 1);
        assert.equal(firstFrameTimers.size, 1);
        // Hiding before the first frame cancels its deadline without closing the viewer.
        visible(false);
        assert.equal(captures[0].killed, true);
        assert.equal(firstFrameTimers.size, 0);
        firstFrameCallbacks[0]();
        assert.deepEqual(errors, []);
        assert.equal(ctx.browsers.viewerCount(id), 0);
        visible(true); visible(true);
        assert.equal(captures.length, 1, "wait for the canceled child to close before starting another");
        visible(false);
        captures[0].emit("error", new Error("expected canceled remote request"));
        captures[0].emit("exit", null, "SIGKILL");
        captures[0].emit("close", null, "SIGKILL");
        assert.equal(captures.length, 1, "a rapid second hide must not resurrect capture");
        captures[0].stdout.write(frame);
        assert.equal(sent.length, 0, "late canceled frames never reach the viewer");
        visible(true);
        assert.equal(captures.length, 2);
        assert.equal(firstFrameTimers.size, 1, "resume gets its own first-frame deadline");
        firstFrameCallbacks[0]();
        captures[1].stdout.write(frame);
        captures[1].stdout.write(frame);
        assert.equal(sent.length, 1, "unchanged visible frames remain deduplicated");
        assert.equal(firstFrameTimers.size, 0);
        // A partial JPEG belongs only to the capture process that produced it.
        captures[1].stdout.write(Buffer.from([255, 216, 9]));
        visible(false); visible(true);
        captures[1].emit("close", null, "SIGKILL");
        captures[1].stdout.write(Buffer.from([255, 217]));
        assert.equal(captures.length, 3);
        captures[2].stdout.write(frame);
        assert.deepEqual(sent, [frame, frame], "an unchanged desktop still sends a fresh frame after resume");
        assert.deepEqual(commands[1], commands[0]);
        assert.deepEqual(commands[2], commands[0], "resolution, JPEG quality and frame cadence stay unchanged");
        assert.deepEqual(errors, []);
        assert.equal(ctx.browsers.viewerCount(id), 1);
        ws.close(1000);
        assert.equal(captures[2].killed, true);
        assert.equal(firstFrameTimers.size, 0);
        captures[2].emit("close", null, "SIGKILL");
        assert.equal(captures.length, 3, "closing never restarts capture");
      } finally {
        ws.close(4000);
        for (const child of captures) child.emit("close", null, "SIGKILL");
        Object.assign(rt, original); process.env.TALLYLAMP_FAKE_CHROME = "1";
        t.mock.restoreAll();
      }
    });
  }
});
