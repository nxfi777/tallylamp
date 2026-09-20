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
  const errors: string[] = [];
  // A bare "timed out" cost a production redeploy per guess. Say what was awaited and what the
  // display had instead.
  const until = async (check: () => Promise<boolean> | boolean, what = "a condition", seen: () => Promise<unknown> | unknown = () => undefined) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`native desktop smoke test timed out waiting for ${what}; saw ${JSON.stringify(await seen())}; notices ${JSON.stringify(errors)}`);
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
    await until(() => frames > 0 || errors.length > 0, "a first frame");
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
      }, "the fitted window");
    } finally { await cdp.close(); }
    // Shaped like the dashboard's messages: every one carries the modifiers held at that moment,
    // and a press releases the rest before it acts.
    const key = (key: string, event: string, modifiers = 0) => send({ type: "key", key, event, modifiers });
    key("Control", "rawKeyDown", 2); key("l", "rawKeyDown", 2); key("l", "keyUp", 2); key("Control", "keyUp");
    const titled = (title: string) => until(async () => (await listPages(rt.cdpUrl)).some(p => p.title === title),
      `a page titled "${title}"`, async () => (await listPages(rt.cdpUrl)).map(p => p.title));
    // The input fills the viewport so a click anywhere on the page lands on it and keeps focus.
    // The title is set by a script after the input, so "loaded" means the input exists: waiting
    // on a parsed <title> and then typing raced autofocus and lost the first characters. Two
    // quick clicks on one spot are a double-click, which selects a word; collapse it so later
    // typing appends instead of replacing.
    const html = '<input autofocus style="position:fixed;inset:0;width:100%;height:100%" oninput="document.title=\'typed:\'+this.value" onmousemove="if(!this.dataset.h){this.dataset.h=1;document.title=\'hover\'}" onclick="document.title=\'clicks:\'+(this.dataset.n=(+this.dataset.n||0)+1);this.setSelectionRange(this.value.length,this.value.length)"><script>document.title="desktop-smoke"</script>';
    send({ type: "paste", text: `data:text/html,${encodeURIComponent(html)}` });
    key("Enter", "rawKeyDown"); key("Enter", "keyUp");
    await titled("desktop-smoke");
    // Chrome drops input that arrives before a new document's first paint, and the title above
    // is set while parsing. On a slow runner the click below went out in that window and was
    // never seen. Nudge the pointer until the page says it felt it; then input is flowing.
    let nudge = 0;
    await until(async () => {
      send({ type: "mouse", event: "mouseMoved", x: 600 + (nudge++ % 2), y: 450 });
      return (await listPages(rt.cdpUrl)).some(p => p.title === "hover");
    }, "the page to feel the pointer", async () => (await listPages(rt.cdpUrl)).map(p => p.title));
    // The operator's shape, not the agent's: motion parks the pointer on the target, then the
    // press and the release arrive at those same coordinates as separate xdotool processes.
    // `mousemove --sync` hung for 15s whenever the pointer was already there, so hover worked
    // and no click ever landed. The second click repeats it with the pointer provably at rest.
    // Clicking first also focuses the input, so the typing below does not lean on autofocus.
    const mouse = (event: string) => send({ type: "mouse", event, x: 640, y: 450, button: "left", modifiers: 0 });
    mouse("mouseMoved"); mouse("mousePressed"); mouse("mouseReleased");
    await titled("clicks:1");
    mouse("mousePressed"); mouse("mouseReleased");
    await titled("clicks:2");
    send({ type: "paste", text: "Native UI" });
    await titled("typed:Native UI");
    // A Shift whose release never arrives: the OS took the chord, or focus left without a blur.
    // The display kept it down and every later letter came out uppercase. The next press says
    // Shift is not held, and that has to be enough to let it go. Paste cannot prove this, since
    // `type --clearmodifiers` hides a stuck modifier; only a real key event shows it.
    send({ type: "key", event: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    send({ type: "key", event: "keyDown", key: "d", code: "KeyD", modifiers: 0 });
    send({ type: "key", event: "keyUp", key: "d", code: "KeyD", modifiers: 0 });
    await titled("typed:Native UId");
    assert.deepEqual(errors, []);
    ws.close(1000);
    await until(() => ctx.browsers.viewerCount(id) === 0, "the viewer to detach");
    assert.equal(ctx.browsers.controlState(id).controllerType, "none");
    assert.equal((await json(`${ctx.url}/api/v1/browsers/${id}/agent-desktop`, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) })).status, 200);
    const owner = getAgent(ctx.browsers.row(id).owner_id)!;
    const native = await agentDesktop(ctx.browsers, owner, id, {}, true);
    assert.ok(native.image && native.image.length > 100);
    await agentDesktop(ctx.browsers, owner, id, { action: "type", text: "-agent" }, false);
    await titled("typed:Native UId-agent");
    // Same trap on the agent path: a second click where the pointer already rests timed out.
    await agentDesktop(ctx.browsers, owner, id, { action: "click", x: 640, y: 450 }, false);
    await agentDesktop(ctx.browsers, owner, id, { action: "click", x: 640, y: 450 }, false);
    await titled("clicks:4");
  } finally {
    ws?.terminate();
    await ctx.close();
    for (const key of ["TALLYLAMP_FAKE_CHROME", "TALLYLAMP_XVFB", "TALLYLAMP_XVFB_SCREEN", "TALLYLAMP_WINDOW_SIZE"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
