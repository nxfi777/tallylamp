import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import type { BrowserManager } from "./browsers.js";
import { config } from "./config.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { CdpClient, browserWsUrl } from "./cdp.js";

type Message = { type: string; [key: string]: unknown };
const active = new Set<string>();
const MAX_JPEG = 4 * 1024 * 1024;

/** ffmpeg image2pipe has no framing. JPEG entropy escapes FF, so FF D9 is unambiguous. */
export class JpegFrames {
  private pending: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    if (this.pending.length + chunk.length > MAX_JPEG) throw new Error("desktop frame exceeds limit");
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    let end: number;
    while ((end = this.pending.indexOf(Buffer.from([0xff, 0xd9]))) !== -1) {
      const frame = this.pending.subarray(0, end + 2);
      if (frame[0] !== 0xff || frame[1] !== 0xd8) throw new Error("invalid desktop frame");
      frames.push(frame);
      this.pending = this.pending.subarray(end + 2);
    }
    return frames;
  }
}

const KEYS: Record<string, string> = {
  Enter: "Return", Tab: "Tab", Backspace: "BackSpace", Delete: "Delete", Escape: "Escape",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next", Insert: "Insert",
  Shift: "Shift_L", Control: "Control_L", Alt: "Alt_L", Meta: "Super_L",
};
// Never forward Caps Lock. The operator's `key` already has its effect applied ("D", not "d"),
// and xdotool adds Shift for an uppercase keysym, so a remote Lock on top inverts every letter:
// X reads Shift+Lock as lowercase. macOS makes it worse by sending only a keydown when Caps Lock
// turns on and only a keyup when it turns off, which leaves the remote Lock on for good.
const IGNORED_KEYS = new Set(["CapsLock"]);
const MODIFIERS: Array<[bit: number, key: string, keysym: string]> = [[1, "Alt", "Alt_L"], [2, "Control", "Control_L"], [4, "Meta", "Super_L"], [8, "Shift", "Shift_L"]];
/**
 * Modifiers the remote display must not be holding, going by the operator's own event. A keyup
 * that never arrives -- the OS took the chord, the page lost focus without a blur, xdotool
 * pressed Shift for "@" and the release came back as "2" -- left Shift down on the display and
 * every later letter uppercase until the pointer left the stage. Each press says which
 * modifiers are really down, so let go of the rest first. Release only: never press from this.
 */
export function staleModifiers(msg: Message): string[] {
  if (typeof msg.modifiers !== "number") return [];
  const held = msg.modifiers;
  return MODIFIERS.filter(([bit, key]) => !(held & bit) && msg.key !== key).map(([, , keysym]) => keysym);
}
export function desktopKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  if (Object.hasOwn(KEYS, key)) return KEYS[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  if ([...key].length === 1 && key.codePointAt(0)! >= 32) return `U${key.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  return null;
}

/** Pure validation: no shell strings or client-controlled xdotool commands. */
export function desktopInput(msg: Message, size: { width: number; height: number }): string[] | null {
  // Never `mousemove --sync`. The man page says it does not wait when no movement is needed;
  // xdotool 3.20160805 (bookworm) only has that early return on the --step path. Otherwise it
  // polls until the pointer LEAVES where it started: 500 tries x 30ms = 15s when the pointer is
  // already at X,Y. It always is for a click, because the operator's last motion event put it
  // there, so `mousemove --sync X Y mousedown 1` hung until the watchdog SIGKILLed it and the
  // press never ran. Hover worked, clicks did not. Ordering does not need it: the warp and the
  // button event share one X connection, and XCloseDisplay syncs before the process exits.
  const point = () => typeof msg.x === "number" && Number.isFinite(msg.x) && typeof msg.y === "number" && Number.isFinite(msg.y)
    && msg.x >= 0 && msg.y >= 0 && msg.x < size.width && msg.y < size.height
    ? ["mousemove", String(Math.min(size.width - 1, Math.round(msg.x))), String(Math.min(size.height - 1, Math.round(msg.y)))] : null;
  if (msg.type === "mouse") {
    const pos = point();
    if (!pos) return null;
    if (msg.event === "mouseMoved") return pos;
    const button = msg.button === "left" ? "1" : msg.button === "middle" ? "2" : msg.button === "right" ? "3" : null;
    if (!button || !["mousePressed", "mouseReleased"].includes(String(msg.event))) return null;
    if (msg.event === "mouseReleased") return [...pos, "mouseup", button];
    return [...staleModifiers(msg).flatMap(k => ["keyup", k]), ...pos, "mousedown", button];
  }
  if (msg.type === "scroll") {
    const pos = point();
    if (!pos) return null;
    const x = typeof msg.deltaX === "number" && Number.isFinite(msg.deltaX) ? msg.deltaX : 0;
    const y = typeof msg.deltaY === "number" && Number.isFinite(msg.deltaY) ? msg.deltaY : 0;
    const delta = Math.abs(y) >= Math.abs(x) ? y : x;
    if (!delta) return null;
    return [...pos, "click", "--repeat", String(Math.min(5, Math.max(1, Math.ceil(Math.abs(delta) / 100)))),
      "--delay", "0", Math.abs(y) >= Math.abs(x) ? (y > 0 ? "5" : "4") : (x > 0 ? "7" : "6")];
  }
  if (msg.type === "key") {
    const key = desktopKey(msg.key);
    if (!key || !["keyDown", "rawKeyDown", "keyUp"].includes(String(msg.event))) return null;
    return msg.event === "keyUp" ? ["keyup", key] : [...staleModifiers(msg).flatMap(k => ["keyup", k]), "keydown", key];
  }
  if (msg.type === "paste" && typeof msg.text === "string" && msg.text.length <= 2048) {
    const text = msg.text.replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    return text ? ["type", "--clearmodifiers", "--delay", "0", "--", text] : null;
  }
  if (msg.type === "extensions") return ["key", "--clearmodifiers", "ctrl+l", "type", "--clearmodifiers", "--delay", "0", "chrome://extensions/"];
  return null;
}

/**
 * How wide to send the desktop.
 *
 * It used to be a flat 1600. The display is 2560 across, so every frame was shrunk to 62% and
 * then blown back up by the operator's screen, and two resamples at a non-integer ratio is what
 * made the text soft: measured on one page, native width at the same JPEG quality is
 * indistinguishable from the source, while 1600 and 1920 both blur 12px type. So the display's
 * own width is the default, and the only reason to go under it is a stage that cannot show
 * more. The viewer says how many device pixels its stage has; below 1280 nothing is legible
 * whatever the stage, so that is the floor.
 */
export function streamWidth(displayWidth: number, stageWidth?: number): number {
  if (typeof stageWidth !== "number" || !Number.isFinite(stageWidth) || stageWidth <= 0) return displayWidth;
  const wanted = Math.min(displayWidth, Math.max(1280, Math.ceil(stageWidth)));
  return wanted - (wanted % 2);
}

/**
 * A frame goes out only while less than this is still queued on the socket. Native-width frames
 * run to 400 KB, and the shared 2 MB high-water mark would let five of them pile up: most of a
 * second of lag on a good link, several on a poor one, in a view someone is steering by. Holding
 * it to about one frame means a slow link gets fewer frames, each one current and sharp.
 */
const DESKTOP_SEND_GATE_BYTES = 512 * 1024;

/** Separate from CDP: the native toolbar, popups and side panels are all X11 surfaces. */
export function runDesktopViewer(ws: WebSocket, browsers: BrowserManager, id: string, mode: "watch" | "control", spawnProcess: typeof spawn = spawn, stageWidth?: number) {
  const send = (data: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const reject = (message: string) => { send({ type: "error", message }); ws.close(1008, "desktop unavailable"); };
  const rt = browsers.runtime(id);
  // Never capture the host's DISPLAY. Only this browser's service-owned Xvfb is eligible.
  if (!config.fullBrowser || !rt?.xvfb || !rt.display) return reject("Full browser requires a real browser on a dedicated Xvfb display.");
  if (active.has(id)) return reject("Full browser is already open in another viewer. Close that view and try again.");
  const size = rt.screen;
  if (size.width * size.height > 16_000_000) return reject("The desktop is too large to stream. Reduce TALLYLAMP_XVFB_SCREEN.");
  active.add(id);
  browsers.attachViewer(id);
  audit({ actorType: "admin", actorId: "admin", action: "viewer.desktop.opened", targetType: "browser", targetId: id, detail: { mode } });
  // Do not forward service secrets to either child.
  const env = { PATH: process.env.PATH, DISPLAY: rt.display, LANG: "C.UTF-8" };
  let boundLease: string | null = null;
  let closed = false;
  let input: ChildProcess | null = null;
  let queue: Message[] = [];
  // Physical key -> the keysym its press sent. The release names the key as it reads *then*:
  // Shift let go first turns "R" into "r", Option let go first turns "@" into "2". Releasing
  // that keysym instead leaves the pressed one down, and with it the Shift xdotool added.
  const keys = new Map<string, string>();
  const physical = (msg: Message) => typeof msg.code === "string" && msg.code ? msg.code : desktopKey(msg.key)!;
  const buttons = new Set<string>();
  // Once per socket per distinct reason. A refusal refuses every event of that kind, and a
  // notice per keystroke would bury the stage in the same sentence.
  let inputFailureReported = false;
  const reported = new Set<string>();
  const reportOnce = (message: string) => {
    if (reported.has(message) || reported.size > 8) return;
    reported.add(message);
    send({ type: "notice", message });
  };
  const isInput = (type: unknown) => type === "mouse" || type === "key" || type === "scroll" || type === "paste";
  const validLease = () => {
    const state = browsers.controlState(id);
    return mode === "control" && !!boundLease && state.controllerType === "human" && state.leaseToken === boundLease;
  };
  let releaseWhenIdle = false;
  /** Let go of whatever is physically held down. Nothing queued is touched. */
  const releaseHeldNow = () => {
    releaseWhenIdle = false;
    const args = [...[...new Set(keys.values())].flatMap(k => ["keyup", k]), ...[...buttons].flatMap(b => ["mouseup", b])];
    keys.clear(); buttons.clear();
    if (args.length) {
      const child = spawnProcess("xdotool", args, { env, stdio: "ignore" });
      child.on("error", () => {});
      const timeout = setTimeout(() => child.kill("SIGKILL"), 1000);
      timeout.unref(); child.on("close", () => clearTimeout(timeout));
    }
  };
  /**
   * The pointer leaving the stage, or focus moving off it, means "let go of anything you are
   * holding" -- not "throw away what I just did".
   *
   * This used to wipe the queue and SIGKILL the running xdotool. Every motion event spawns an
   * xdotool process, one at a time, so the queue can run behind the operator. A click is a
   * press and a release sitting in that queue, and moving the pointer off the canvas right
   * after clicking -- which is what you do -- killed both before they ran. Drain first, then
   * let go. (This was real but not why clicks failed; see the --sync note in desktopInput.)
   */
  const releaseHeld = () => {
    if (queue.length || input) { releaseWhenIdle = true; return; }
    releaseHeldNow();
  };
  /** Lease lost, or the socket is going away: drop everything, including work not yet run. */
  const releaseInputs = () => {
    queue = [];
    input?.kill("SIGKILL");
    input = null;
    releaseHeldNow();
  };
  const pump = () => {
    if (closed || input || !queue.length) return;
    if (!validLease()) { releaseInputs(); return; }
    const msg = queue.shift()!;
    let args = desktopInput(msg, size);
    if (!args) { pump(); return; }
    if (msg.type === "key") {
      if (msg.event !== "keyUp") keys.set(physical(msg), desktopKey(msg.key)!);
      else if (keys.has(physical(msg))) args = ["keyup", keys.get(physical(msg))!];
    }
    if (msg.event !== "keyUp" && msg.event !== "mouseReleased") {
      for (const keysym of staleModifiers(msg)) for (const [k, v] of keys) if (v === keysym) keys.delete(k);
    }
    if (msg.type === "mouse") {
      const button = ({ left: "1", middle: "2", right: "3" } as Record<string, string>)[String(msg.button)];
      if (msg.event === "mousePressed") buttons.add(button);
    }
    const child = spawnProcess("xdotool", args, { env, stdio: "ignore" });
    input = child;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    timeout.unref();
    child.on("error", () => send({ type: "notice", message: "Desktop input failed. Check that xdotool is installed." }));
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (input !== child) return;
      input = null;
      // `error` only fires when the process cannot be spawned at all. An xdotool that starts
      // and then fails -- a display it cannot open, no XTEST on the server, a keysym it
      // cannot map -- exits non-zero, and this dropped that on the floor. The agent path has
      // always checked the code; the viewer did not, so every click and keystroke vanished in
      // silence and looked exactly like a dead stream. releaseInputs() clears `input` before
      // it kills, so a deliberate cancellation returns above and is never reported here.
      if ((code !== 0 || signal) && !inputFailureReported) {
        inputFailureReported = true;
        send({ type: "notice", message: signal
          ? `Desktop input stopped responding on the host: xdotool was killed (${signal}). Nothing you click or type is reaching Chrome.`
          : `Desktop input failed on the host: xdotool exited ${code}. Nothing you click or type is reaching Chrome.` });
      }
      if (msg.type === "key" && msg.event === "keyUp") keys.delete(physical(msg));
      if (msg.type === "mouse" && msg.event === "mouseReleased") buttons.delete(({ left: "1", middle: "2", right: "3" } as Record<string, string>)[String(msg.button)]);
      if (msg.type === "extensions" && validLease()) queue.unshift({ type: "key", event: "keyDown", key: "Enter" }, { type: "key", event: "keyUp", key: "Enter" });
      pump();
      // A deferred "let go" waits for the queue it must not discard.
      if (releaseWhenIdle && !input && !queue.length) releaseHeldNow();
    });
  };
  const capture = spawnProcess("ffmpeg", ["-nostdin", "-loglevel", "error", "-threads", "1", "-filter_threads", "1",
    "-f", "x11grab", "-draw_mouse", "0", "-framerate", "6", "-video_size", `${size.width}x${size.height}`,
    "-i", `${rt.display}.0`, "-vf", `scale=w=${streamWidth(size.width, stageWidth)}:h=-2`, "-c:v", "mjpeg", "-threads", "1",
    "-q:v", "6", "-f", "image2pipe", "pipe:1"], { env, stdio: ["ignore", "pipe", "ignore"] });
  let pong = true;
  const ping = setInterval(() => { if (!pong) ws.terminate(); else { pong = false; ws.ping(); } }, config.viewerPingMs);
  ping.unref();
  const leaseCheck = setInterval(() => {
    if (browsers.runtime(id) !== rt || rt.chrome.exitCode !== null) { ws.close(1011, "browser stopped"); return; }
    if (boundLease && !validLease()) { releaseInputs(); boundLease = null; send({ type: "error", message: "lease expired" }); }
  }, 250);
  leaseCheck.unref();
  const onEvent = (event: { type?: string }) => {
    if (event.type === "control.released" || event.type === "control.human" || event.type === "control.agent") {
      if (!validLease()) releaseInputs();
    }
    if (event.type === "browser.stopped" || event.type === "browser.deleted") ws.close(1011, "browser stopped");
  };
  hub.on(`browser:${id}`, onEvent);
  const cleanup = (code: number) => {
    if (closed) return;
    closed = true;
    clearInterval(ping); clearInterval(leaseCheck); clearTimeout(firstFrame);
    hub.off(`browser:${id}`, onEvent);
    releaseInputs(); capture.kill("SIGKILL"); active.delete(id); browsers.detachViewer(id);
    if ((code === 1000 || code === 1001) && validLease()) browsers.releaseControl(id);
  };
  ws.on("close", cleanup);
  ws.on("error", () => {});
  ws.on("pong", () => { pong = true; });
  let fitting = false;
  /**
   * Fill the display with the Chrome window, whenever this view opens.
   *
   * Every viewer, watching or controlling. A read-only viewer resizing a live browser is a
   * real side effect -- it changes the window the agent is working in -- and the owner's call
   * is that Full browser should show Chrome rather than Chrome adrift on a desktop four times
   * its size. Watching an unfitted window is not a useful read-only guarantee; it just looks
   * broken, which is how it was reported twice.
   */
  const fitWindow = () => {
    if (fitting) return;
    fitting = true;
    void (async () => {
      let cdp: CdpClient | undefined;
      try {
        cdp = new CdpClient(await browserWsUrl(rt.cdpUrl));
        await cdp.connect();
        const { targetInfos } = await cdp.send("Target.getTargets") as { targetInfos: Array<{ type: string; targetId: string }> };
        const page = targetInfos.find(t => t.type === "page");
        if (!page) return;
        const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: page.targetId }) as { windowId: number };
        if (closed) return;
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        if (closed) return;
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: size.width, height: size.height } });
      } catch { send({ type: "notice", message: "Could not fit the Chrome window." }); }
      finally { await cdp?.close(); fitting = false; }
    })();
  };
  fitWindow();
  ws.on("message", raw => {
    if (closed) return;
    let msg: Message;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (mode !== "control") return;
    if (msg.type === "heartbeat" && typeof msg.leaseToken === "string") {
      try {
        browsers.heartbeatControl(id, msg.leaseToken, "admin"); boundLease = msg.leaseToken; browsers.touch(id);
      }
      catch { send({ type: "error", message: "lease expired" }); }
      return;
    }
    if (!validLease()) {
      // Refusing input without a bound lease is right; doing it silently is not. Everything is
      // refused until the heartbeat binds, and after a takeover elsewhere it goes back to
      // being refused, and in both cases every click and keystroke simply vanished.
      if (isInput(msg.type)) reportOnce("Input is being ignored: this view does not hold the control lease. Take control again, or reload the page.");
      return;
    }
    if (msg.type === "releaseInputs") { releaseHeld(); return; }
    if (msg.type === "fitBrowser") { fitWindow(); return; }
    if (msg.type === "key" && IGNORED_KEYS.has(String(msg.key))) return;
    if (!desktopInput(msg, size)) {
      // The last silent drop. A pointer mapped outside the display and a key with no keysym
      // both land here, and both looked exactly like a view that had stopped responding.
      if (msg.type === "paste") send({ type: "notice", message: "Full-browser paste accepts up to 2,048 characters." });
      else if (msg.type === "mouse" || msg.type === "scroll") reportOnce(`Pointer input is being dropped: it maps to ${Math.round(Number(msg.x))},${Math.round(Number(msg.y))}, outside this ${size.width}x${size.height} display.`);
      else if (msg.type === "key") reportOnce(`That key has no keysym for the remote display, so it was dropped.`);
      return;
    }
    browsers.touch(id);
    if (msg.type === "mouse" && msg.event === "mouseMoved" && queue.at(-1)?.event === "mouseMoved") queue[queue.length - 1] = msg;
    else if (queue.length < 32) queue.push(msg);
    else { releaseInputs(); send({ type: "notice", message: "Desktop input is busy. Try again." }); }
    pump();
  });
  send({ type: "hello", content: size, surface: "desktop" });
  const frames = new JpegFrames();
  let last: Buffer | null = null;
  const firstFrame = setTimeout(() => { send({ type: "error", message: "Desktop capture did not start. Check ffmpeg and Xvfb, then reopen Full browser." }); ws.close(1008); }, 10_000);
  firstFrame.unref();
  capture.stdout!.on("data", (chunk: Buffer) => {
    try {
      for (const frame of frames.push(chunk)) {
        clearTimeout(firstFrame);
        if (closed || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > DESKTOP_SEND_GATE_BYTES) continue;
        if (last?.equals(frame)) continue;
        last = Buffer.from(frame);
        ws.send(frame, { binary: true });
      }
    } catch { send({ type: "error", message: "Desktop capture failed. Reopen Full browser to try again." }); ws.close(1008); }
  });
  capture.on("error", () => { send({ type: "error", message: "Desktop capture requires ffmpeg on the host." }); ws.close(1008); });
  capture.on("exit", () => { if (!closed) { send({ type: "error", message: "Desktop capture stopped. Check ffmpeg and Xvfb, then reopen Full browser." }); ws.close(1008); } });
}
