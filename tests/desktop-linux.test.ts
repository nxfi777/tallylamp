import { it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startTestServer, json } from "./helpers.js";
import { CdpClient, browserWsUrl, listPages } from "../src/cdp.js";
import { getAgent } from "../src/auth.js";
import { agentDesktop } from "../src/agent-desktop.js";

// Explicit opt-in: this launches a real browser and Xvfb. Never silently substitute fake Chrome.
it("captures real Xvfb frames and types through Chrome's native address bar", {
  skip: process.platform !== "linux" || process.env.TALLYLAMP_TEST_DESKTOP !== "1",
  timeout: 60_000,
}, async () => {
  const ctx = await startTestServer();
  const previous = { ...process.env };
  let ws: WebSocket | undefined;
  const headers = { Cookie: ctx.cookie, "Content-Type": "application/json" };
  const until = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("native desktop smoke test timed out");
  };
  try {
    Object.assign(process.env, { TALLYLAMP_FAKE_CHROME: "0", TALLYLAMP_XVFB: "1",
      TALLYLAMP_XVFB_SCREEN: "1280,800", TALLYLAMP_WINDOW_SIZE: "1000,700" });
    const created = await json(`${ctx.url}/api/v1/browsers`, { method: "POST", headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "native-desktop-smoke", start: false }) });
    assert.equal(created.status, 201);
    const id = (created.body as { browser: { id: string } }).browser.id;
    assert.equal((await json(`${ctx.url}/api/v1/browsers/${id}/extensions`, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) })).status, 200);
    const rt = await ctx.browsers.ensureRunning(id);
    const lease = ctx.browsers.acquireControl(id, "human", "admin");
    const ticket = await json(`${ctx.url}/api/v1/browsers/${id}/viewer-ticket`, { method: "POST", headers, body: JSON.stringify({ mode: "control" }) });
    ws = new WebSocket(`${ctx.url.replace("http", "ws")}/api/v1/browsers/${id}/view?surface=desktop&ticket=${(ticket.body as { ticket: string }).ticket}`);
    let frames = 0;
    let dimensions: unknown;
    const errors: string[] = [];
    ws.on("message", (raw, binary) => {
      if (binary) {
        const frame = Buffer.from(raw as Buffer);
        if (frame[0] === 255 && frame[1] === 216 && frame.at(-2) === 255 && frame.at(-1) === 217) frames++;
      } else {
        const msg = JSON.parse(String(raw));
        if (msg.type === "hello") dimensions = msg.content;
        if (msg.type === "error" || msg.type === "notice") errors.push(msg.message);
      }
    });
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    const send = (msg: object) => ws!.send(JSON.stringify(msg));
    send({ type: "heartbeat", leaseToken: lease.leaseToken });
    await until(() => frames > 0 || errors.length > 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(dimensions, { width: 1280, height: 800 });
    assert.ok(frames > 0, "ffmpeg must produce actual JPEG frames");
    // Binding the lease is what fits the window, and the fit is not cosmetic. Nothing runs a
    // window manager on these displays, so X leaves the input focus on PointerRoot and keys
    // reach whatever window the pointer is over. Chrome launched at 1000x700 on a 1280x800
    // desktop leaves bare root window around it, and every keystroke that lands there is
    // swallowed without a word. Fitted, there is nowhere else for one to go.
    const cdp = new CdpClient(await browserWsUrl(rt.cdpUrl));
    await cdp.connect();
    try {
      await until(async () => {
        const { targetInfos } = await cdp.send("Target.getTargets") as { targetInfos: Array<{ type: string; targetId: string }> };
        const page = targetInfos.find(t => t.type === "page");
        if (!page) return false;
        const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: page.targetId }) as { windowId: number };
        const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId }) as { bounds: { width: number; height: number } };
        // Chromium keeps an X11 window one pixel short of the display so that no window manager
        // mistakes it for fullscreen: asked for 1280x800 it settles at 1279x799. Measured on
        // production, 2560x1600 -> 2559x1599. Launched at 1000x700, so this still proves the fit.
        return bounds.width >= 1279 && bounds.height >= 799;
      });
    } finally { await cdp.close(); }
    const key = (key: string, event: string) => send({ type: "key", key, event });
    key("Control", "rawKeyDown"); key("l", "rawKeyDown"); key("l", "keyUp"); key("Control", "keyUp");
    // The input fills the viewport so a click anywhere on the page lands on it and keeps focus.
    // Two quick clicks on one spot are a double-click, which selects a word; collapse it so the
    // agent's later typing appends instead of replacing.
    const html = '<title>desktop-smoke</title><input autofocus style="position:fixed;inset:0;width:100%;height:100%" oninput="document.title=\'typed:\'+this.value" onclick="document.title=\'clicks:\'+(this.dataset.n=(+this.dataset.n||0)+1);this.setSelectionRange(this.value.length,this.value.length)">';
    send({ type: "paste", text: `data:text/html,${encodeURIComponent(html)}` });
    key("Enter", "rawKeyDown"); key("Enter", "keyUp");
    await until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === "desktop-smoke"));
    send({ type: "paste", text: "Native UI" });
    await until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === "typed:Native UI"));
    // The operator's shape, not the agent's: motion parks the pointer on the target, then the
    // press and the release arrive at those same coordinates as separate xdotool processes.
    // `mousemove --sync` hung for 15s whenever the pointer was already there, so hover worked
    // and no click ever landed. The second click repeats it with the pointer provably at rest.
    const mouse = (event: string) => send({ type: "mouse", event, x: 640, y: 450, button: "left" });
    mouse("mouseMoved"); mouse("mousePressed"); mouse("mouseReleased");
    await until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === "clicks:1"));
    mouse("mousePressed"); mouse("mouseReleased");
    await until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === "clicks:2"));
    assert.deepEqual(errors, []);
    ws.close(1000);
    await until(() => ctx.browsers.viewerCount(id) === 0);
    assert.equal(ctx.browsers.controlState(id).controllerType, "none");
    assert.equal((await json(`${ctx.url}/api/v1/browsers/${id}/agent-desktop`, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) })).status, 200);
    const owner = getAgent(ctx.browsers.row(id).owner_id)!;
    const native = await agentDesktop(ctx.browsers, owner, id, {}, true);
    assert.ok(native.image && native.image.length > 100);
    await agentDesktop(ctx.browsers, owner, id, { action: "type", text: "-agent" }, false);
    await until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === "typed:Native UI-agent"));
    // Same trap on the agent path: a second click where the pointer already rests timed out.
    await agentDesktop(ctx.browsers, owner, id, { action: "click", x: 640, y: 450 }, false);
    await agentDesktop(ctx.browsers, owner, id, { action: "click", x: 640, y: 450 }, false);
    await until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === "clicks:4"));
  } finally {
    ws?.terminate();
    await ctx.close();
    for (const key of ["TALLYLAMP_FAKE_CHROME", "TALLYLAMP_XVFB", "TALLYLAMP_XVFB_SCREEN", "TALLYLAMP_WINDOW_SIZE"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
