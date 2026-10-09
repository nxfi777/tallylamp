import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { KEYSYMS } from "./desktop-viewer.js";

/**
 * Full browser and the agent desktop tools, for a browser whose Chrome is on a worker.
 *
 * Both come down to two programs pointed at the browser's X display: ffmpeg to capture it and
 * xdotool to move the pointer and press keys. For a browser on this host they are spawned
 * here. A worker's browser has its display on the worker, so the same command is sent there,
 * run against that browser's own Xvfb, and handed back shaped like the child process the
 * caller would have spawned: its stdout, then its exit. desktop-viewer.ts and
 * agent-desktop.ts already take the spawn function as a parameter, so neither knows the
 * difference.
 *
 * The worker runs only what the two checks below allow. xdotool can also run programs
 * (`exec`) and ffmpeg can also write files, so an open argument list would turn the worker's
 * secret into a shell on the worker. Each check accepts exactly the commands the two modules
 * build, and nothing else.
 */

/** Response frames: a type byte, a 4-byte length, then the payload. */
export const X_STDOUT = 1;
export const X_EXIT = 2;
export const X_ERROR = 3;

export function xFrame(type: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(payload.length, 1);
  payload.copy(out, 5);
  return out;
}

const int = (s: string | undefined, max: number) => s !== undefined && /^\d{1,6}$/.test(s) && Number(s) <= max;

const XDOTOOL_COMMANDS = new Set(["mousemove", "mousedown", "mouseup", "click", "key", "keydown", "keyup", "type"]);
// One part of a keysym argument such as "Control_L+U006c". desktopKey() makes U+hex for any
// character and names the rest; "ctrl" and single letters come from the fixed chords in
// agent-desktop.ts. No part can spell an xdotool command, which is what matters: xdotool
// reads a command name anywhere in the list as the start of the next command.
const KEYSYM_PART = new RegExp(`^(U[0-9a-f]{4,6}|F([1-9]|1[0-2])|[a-z]|ctrl|${[...KEYSYMS].join("|")}|(Shift|Control|Alt|Super)_[LR])$`);

/** Pointer moves, button and key presses, and typed text. Never a command that runs anything. */
export function allowedXdotool(args: readonly string[]): boolean {
  let i = 0;
  if (!args.length) return false;
  while (i < args.length) {
    const command = args[i++]!;
    if (!XDOTOOL_COMMANDS.has(command)) return false;
    while (args[i]?.startsWith("--") && args[i] !== "--") {
      const option = args[i++];
      if (option === "--clearmodifiers") continue;
      if ((option === "--delay" || option === "--repeat") && int(args[i], 10_000)) {
        i++;
        continue;
      }
      return false;
    }
    if (command === "type") {
      // type takes the rest of the command line as the text to type, so nothing after it is
      // read as a command. Text that could be read as an option needs the "--" first.
      if (args[i] === "--") i++;
      else if (args[i]?.startsWith("-")) return false;
      return i < args.length;
    }
    if (command === "mousemove") {
      if (!int(args[i], 100_000) || !int(args[i + 1], 100_000)) return false;
      i += 2;
    } else if (command === "mousedown" || command === "mouseup" || command === "click") {
      if (!/^[1-7]$/.test(args[i] ?? "")) return false;
      i++;
    } else {
      let keys = 0;
      while (i < args.length && !XDOTOOL_COMMANDS.has(args[i]!)) {
        if (!args[i]!.split("+").every((part) => KEYSYM_PART.test(part))) return false;
        i++;
        keys++;
      }
      if (!keys) return false;
    }
  }
  return true;
}

const FFMPEG_VALUES: Record<string, (v: string, display: string) => boolean> = {
  "-loglevel": (v) => v === "error",
  "-threads": (v) => int(v, 16),
  "-filter_threads": (v) => int(v, 16),
  "-probesize": (v) => v === "32",
  "-f": (v) => v === "x11grab" || v === "image2pipe",
  "-draw_mouse": (v) => v === "0",
  "-framerate": (v) => int(v, 30),
  "-video_size": (v) => /^\d{2,5}x\d{2,5}$/.test(v),
  "-i": (v, display) => v === `${display}.0`,
  "-vf": (v) => /^scale=w=(\d{2,5}|'min\(\d{2,5},iw\)'):h=-2$/.test(v),
  "-c:v": (v) => v === "mjpeg",
  "-q:v": (v) => int(v, 31),
  "-frames:v": (v) => int(v, 10),
};

/** A capture of this browser's own display, as JPEGs on stdout. No other input, no file output. */
export function allowedFfmpeg(args: readonly string[], display: string): boolean {
  if (args.at(-1) !== "pipe:1" || !args.includes("-i")) return false;
  for (let i = 0; i < args.length - 1; i++) {
    const a = args[i]!;
    if (a === "-nostdin") continue;
    if (!Object.hasOwn(FFMPEG_VALUES, a) || !FFMPEG_VALUES[a]!(args[i + 1] ?? "", display)) return false;
    i++;
  }
  return true;
}

export type RemoteRun = (body: { tool: string; args: string[]; stdout: boolean }, signal: AbortSignal) => Promise<Response>;

/**
 * Stands in for the child process the caller would have spawned. It emits what a real one
 * does, in the same order: stdout data, "exit", then "close"; or "error" when the program
 * cannot be started. kill() cuts the request, and the worker kills the program when it sees
 * the request go.
 */
class RemoteProcess extends EventEmitter {
  readonly stdout: PassThrough | null;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private done = false;
  private readonly controller = new AbortController();

  constructor(run: RemoteRun, tool: string, args: string[], wantsStdout: boolean) {
    super();
    this.stdout = wantsStdout ? new PassThrough() : null;
    void this.start(run, tool, args, wantsStdout);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.done) return false;
    this.killed = true;
    this.controller.abort();
    this.finish(null, typeof signal === "string" ? signal : "SIGKILL");
    return true;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout?.end();
    this.emit("exit", code, signal);
    setImmediate(() => this.emit("close", code, signal));
  }

  private fail(code: string, message: string): void {
    if (this.done) return;
    // An emitter with no "error" listener throws. Every caller listens; this is the backstop.
    if (this.listenerCount("error")) this.emit("error", Object.assign(new Error(message), { code }));
    this.finish(1, null);
  }

  private async start(run: RemoteRun, tool: string, args: string[], wantsStdout: boolean): Promise<void> {
    let res: Response;
    try {
      res = await run({ tool, args, stdout: wantsStdout }, this.controller.signal);
    } catch (e) {
      this.fail("EREMOTE", `the worker could not be reached: ${(e as Error).message}`);
      return;
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      this.fail("EREMOTE", `the worker refused: ${body.error?.message ?? `HTTP ${res.status}`}`);
      return;
    }
    const reader = res.body.getReader();
    let pending = Buffer.alloc(0);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending = pending.length ? Buffer.concat([pending, Buffer.from(value)]) : Buffer.from(value);
        while (pending.length >= 5) {
          const len = pending.readUInt32BE(1);
          if (pending.length < 5 + len) break;
          const type = pending[0];
          const payload = pending.subarray(5, 5 + len);
          pending = pending.subarray(5 + len);
          if (type === X_STDOUT) {
            if (!this.done) this.stdout?.write(Buffer.from(payload));
          } else if (type === X_EXIT) {
            const { code, signal } = JSON.parse(payload.toString("utf8")) as { code: number | null; signal: NodeJS.Signals | null };
            this.finish(code, signal);
          } else if (type === X_ERROR) {
            const { code, message } = JSON.parse(payload.toString("utf8")) as { code: string; message: string };
            this.fail(code, message);
          }
        }
      }
    } catch {
      // Cut by kill(), or the connection dropped. The first is already finished.
    }
    this.fail("EREMOTE", "the worker stopped answering");
  }
}

/** A spawn() that runs the command on the worker holding this browser's display. */
export function remoteSpawner(run: RemoteRun): typeof spawn {
  return ((command: string, args: readonly string[] = [], options?: { stdio?: unknown }) => {
    const stdio = options?.stdio;
    const wantsStdout = Array.isArray(stdio) ? stdio[1] === "pipe" : stdio === "pipe";
    return new RemoteProcess(run, command, [...args], wantsStdout) as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}
