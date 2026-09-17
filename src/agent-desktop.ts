import { spawn, type ChildProcess } from "node:child_process";
import type { Principal } from "./auth.js";
import { getAgent, requireScope } from "./auth.js";
import type { BrowserManager } from "./browsers.js";
import type { ChromeRuntime } from "./chrome.js";
import { config } from "./config.js";
import { Err } from "./errors.js";
import { hub } from "./events.js";
import { audit } from "./audit.js";
import { desktopInput, desktopKey, JpegFrames } from "./desktop-viewer.js";

type Action = { action?: unknown; [key: string]: unknown };
type Command = { args: string[]; release: string[] };
const busy = new Set<string>();

/** Atomic actions only: agents cannot leave keys/buttons pressed across tool calls. */
export function agentDesktopCommand(input: Action, size: { width: number; height: number }): Command {
  const move = () => {
    const args = desktopInput({ type: "mouse", event: "mouseMoved", x: input.x, y: input.y }, size);
    if (!args) throw Err.invalid("x and y must be within the screenshot's screenWidth and screenHeight");
    return args;
  };
  if (input.action === "move") return { args: move(), release: [] };
  if (input.action === "click") {
    const button = input.button ?? "left";
    if (button !== "left" && button !== "middle" && button !== "right") throw Err.invalid("invalid mouse button");
    const b = { left: "1", middle: "2", right: "3" }[button];
    return { args: [...move(), "click", "--repeat", input.doubleClick === true ? "2" : "1", "--delay", "80", b], release: ["mouseup", b] };
  }
  if (input.action === "scroll") {
    move();
    const args = desktopInput({ type: "scroll", x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY }, size);
    if (!args) throw Err.invalid("supply a finite, nonzero scroll delta");
    return { args, release: [] };
  }
  if (input.action === "type") {
    const args = desktopInput({ type: "paste", text: input.text }, size);
    if (!args) throw Err.invalid("text must contain 1 to 2048 characters");
    const typedKeys = [...new Set([...String(input.text)].map(desktopKey).filter((key): key is string => key !== null))];
    return { args, release: ["keyup", ...typedKeys, "Return", "Tab", "Shift_L", "Shift_R", "Control_L", "Control_R", "Alt_L", "Alt_R", "Super_L", "Super_R"] };
  }
  if (input.action === "key") {
    if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 4) throw Err.invalid("keys must be an array of 1 to 4 keys, for example ['Control', 'l']");
    const keys = input.keys.map(desktopKey);
    if (keys.some(k => !k)) throw Err.invalid("unsupported key; use named keys or single characters, not command strings");
    return { args: ["key", "--clearmodifiers", keys.join("+")], release: ["keyup", ...keys as string[]] };
  }
  if (input.action === "openExtensions") {
    // xdotool type consumes the rest of argv. Use a trailing newline for Enter, not a
    // second command that would be typed literally into Chrome's address bar.
    return { args: ["key", "--clearmodifiers", "ctrl+l", "type", "--clearmodifiers", "--delay", "0", "--", "chrome://extensions/\n"], release: ["keyup", "Control_L", "l", "Return"] };
  }
  throw Err.invalid("unknown desktop action");
}

export function authorizeAgentDesktop(browsers: BrowserManager, p: Principal, id: string) {
  const row = browsers.row(id);
  browsers.assertAccess(p, row, "control");
  // Lending never includes this higher privilege, even if the borrower has ordinary control.
  if (p.type !== "admin" && (row.owner_type !== "agent" || row.owner_id !== p.id)) throw Err.unauthorized("native browser access is owner-only; borrowing is not permission");
  if (p.type !== "admin") requireScope(p, "browser:read:own");
  if (p.type === "agent") {
    const live = getAgent(p.id);
    if (!live || live.type !== "agent" || !live.enabled) throw Err.credentialRevoked("agent disabled");
    requireScope(live, "browser:read:own");
    requireScope(live, "browser:control:own");
  }
  if (!row.agent_desktop_enabled) throw Err.unauthorized("User permission required. Ask the user or administrator to open this browser in the dashboard, go to Extensions, and turn on Allow agent control. Explain that this grants full Chrome UI access, including settings and host-file dialogs. Wait for approval; do not retry or try to enable it yourself.");
  if (browsers.isHumanControlled(id)) throw Err.humanControlling();
  const control = browsers.controlState(id);
  if (control.controllerType === "agent" && control.controllerId !== p.id) throw Err.alreadyControlled();
  const rt = browsers.runtime(id);
  if (!config.fullBrowser || !rt?.xvfb || !rt.display || rt.chrome.exitCode !== null) throw Err.browserUnavailable("native browser tools need a running browser with a dedicated Xvfb display");
  if (rt.screen.width * rt.screen.height > 16_000_000) throw Err.invalid("desktop exceeds the capture size limit");
  return rt;
}

/** Short-lived processes, never a desktop WebSocket or a human viewer ticket. */
export async function agentDesktop(browsers: BrowserManager, principal: Principal, id: string, input: Action,
  screenshot: boolean, spawnProcess: typeof spawn = spawn): Promise<{ image?: Buffer; screenWidth: number; screenHeight: number; imageWidth?: number; imageHeight?: number }> {
  const rt = authorizeAgentDesktop(browsers, principal, id);
  const command = screenshot ? null : agentDesktopCommand(input, rt.screen);
  if (busy.has(id)) throw Err.browserUnavailable("another native browser operation is in progress; retry after it finishes");
  const initialLease = browsers.controlState(id).leaseToken;
  busy.add(id);
  const env = { PATH: process.env.PATH, DISPLAY: rt.display!, LANG: "C.UTF-8" };
  let child: ChildProcess | undefined;
  let abort: ((reason: Error) => void) | undefined;
  const check = () => {
    const current: ChromeRuntime = authorizeAgentDesktop(browsers, principal, id);
    if (current !== rt || browsers.controlState(id).leaseToken !== initialLease) throw Err.browserUnavailable("browser or control lease changed during the native operation");
  };
  const onEvent = () => { try { check(); } catch (e) { abort?.(e as Error); } };
  hub.on(`browser:${id}`, onEvent);
  const guard = setInterval(onEvent, 50);
  guard.unref();
  browsers.touch(id);
  audit({ actorType: principal.type, actorId: principal.id, action: screenshot ? "agent.desktop.screenshot" : "agent.desktop.action", targetType: "browser", targetId: id,
    detail: screenshot ? {} : { action: String(input.action) } }); // Never log typed text or image data.
  try {
    check();
    const image = await new Promise<Buffer | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, frame?: Buffer) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        child?.kill("SIGKILL");
        if (error) reject(error); else resolve(frame);
      };
      const timeout = setTimeout(() => finish(Err.browserUnavailable("native operation timed out; inspect the browser before retrying")), screenshot ? 10_000 : 3000);
      timeout.unref();
      abort = (error) => finish(error);
      const args = screenshot ? ["-nostdin", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-f", "x11grab", "-draw_mouse", "0",
        "-video_size", `${rt.screen.width}x${rt.screen.height}`, "-i", `${rt.display}.0`, "-frames:v", "1", "-vf", "scale=w='min(1600,iw)':h=-2",
        "-c:v", "mjpeg", "-threads", "1", "-q:v", "6", "-f", "image2pipe", "pipe:1"] : command!.args;
      try { child = spawnProcess(screenshot ? "ffmpeg" : "xdotool", args, { env, stdio: ["ignore", screenshot ? "pipe" : "ignore", "ignore"] }); }
      catch { finish(Err.browserUnavailable("native operation could not start")); return; }
      const frames = new JpegFrames();
      if (screenshot) child.stdout!.on("data", (chunk: Buffer) => {
        try { const frame = frames.push(chunk)[0]; if (frame) { check(); finish(undefined, Buffer.from(frame)); } }
        catch (e) { finish(e as Error); }
      });
      child.on("error", () => finish(Err.browserUnavailable(`native operation could not start; check ${screenshot ? "ffmpeg" : "xdotool"} on the host`)));
      child.on("close", (code) => {
        if (settled) return;
        try { check(); if (code !== 0 || screenshot) throw Err.browserUnavailable("native operation failed; inspect the browser before retrying"); finish(); }
        catch (e) { finish(e as Error); }
      });
    });
    check();
    const imageWidth = Math.min(1600, rt.screen.width);
    const imageHeight = Math.round(rt.screen.height * imageWidth / rt.screen.width / 2) * 2;
    return { ...(image ? { image, imageWidth, imageHeight } : {}), screenWidth: rt.screen.width, screenHeight: rt.screen.height };
  } finally {
    abort = undefined; clearInterval(guard); hub.off(`browser:${id}`, onEvent); child?.kill("SIGKILL");
    // Release keys even on cancellation. Keep the operation lock until cleanup completes so
    // another agent call cannot start typing while these keyups are still in flight.
    try {
      if (command?.release.length) await new Promise<void>(resolve => {
        const release = spawnProcess("xdotool", command.release, { env, stdio: "ignore" });
        const timeout = setTimeout(() => { release.kill("SIGKILL"); resolve(); }, 1000);
        timeout.unref();
        const done = () => { clearTimeout(timeout); resolve(); };
        release.on("error", done); release.on("close", done);
      });
    } finally { busy.delete(id); }
  }
}
