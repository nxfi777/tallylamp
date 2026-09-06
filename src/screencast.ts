import { CdpClient, browserWsUrl } from "./cdp.js";
import { log } from "./log.js";

/**
 * Bounded, ephemeral motion capture for agents.
 *
 * A screenshot answers "what does this look like"; it cannot answer "how long did that take",
 * and a stepped screenshot-act-screenshot loop lands at an arbitrary point on the curve. The
 * questions this exists for are all durations: did anything acknowledge the click inside the
 * ~400 ms people notice, does the skeleton arrive before the data, is the transition crisp or
 * sluggish, does the hero stay blank until hydration.
 *
 * Two things make it safe to run alongside a human watching the same browser. Frames are only
 * emitted on a compositor update, so a still page produces nothing and costs nothing — that is
 * correct behaviour rather than a hang. And a capture runs on its own CDP session: verified
 * against Chrome 152 that two sessions screencast one target independently, each at its own
 * resolution, with neither disturbed when the other starts or stops. The note in viewer.ts
 * about a size change blanking the stage is about restarting the screencast on the *same*
 * session, and does not apply here.
 */

export type CaptureFrame = { tMs: number; data: string };

export type CaptureOptions = {
  targetId?: string;
  maxFrames?: number;
  maxSeconds?: number;
  armSeconds?: number;
  settleMs?: number;
  everyMs?: number;
  quality?: number;
  maxWidth?: number;
};

export type CaptureResult = {
  targetId: string;
  url: string;
  title: string;
  frames: CaptureFrame[];
  /** The page before the motion, taken `armedMs` earlier. Null if the capture never opened. */
  baseline: CaptureFrame | null;
  droppedFrames: number;
  stoppedBy: "settled" | "maxFrames" | "maxSeconds" | "maxBytes" | "noMotion" | "stopped" | "gone";
  /** Time spent waiting for the page to move at all. Mostly the round trip back to the agent. */
  armedMs: number | null;
  /** Span from the first frame to the last. The duration the capture is actually about. */
  motionMs: number;
  elapsedMs: number;
  frameWidth: number;
};

/**
 * Ceilings, not suggestions. A capture is bounded server-side and says which bound it hit, so
 * a truncated recording can never be mistaken for a complete one. Thirty frames of an 800px
 * JPEG is already most of a megabyte of base64, and the payload has to survive being read by a
 * model, so the defaults sit well under the caps.
 */
const LIMITS = {
  frames: { def: 12, max: 30 },
  /** Measured from the FIRST FRAME, not from this call. See `armSeconds`. */
  seconds: { def: 8, max: 30 },
  /**
   * How long to hold the window open waiting for motion that has not started yet.
   *
   * This is the whole reason the budget is not wall-clock. A tool call has to travel back to
   * the agent before the agent can perform the interaction it wants recorded, and over a
   * connector that round trip is seconds: measured in the field, a capture asked for 4 seconds
   * and reported 12.4 elapsed, with the interaction landing at 6.9s — long after a wall-clock
   * window would have shut. Waiting costs no frames, because frames only exist when the page
   * repaints, so waiting should not cost budget either.
   */
  arm: { def: 60, max: 180 },
  /**
   * Stop once the page has been still this long. A transition that finishes in 600ms should
   * return in 600ms rather than padding to the full window, and it means the common case needs
   * no guess about duration at all. 0 disables it.
   */
  settle: { def: 600, min: 0, max: 5000 },
  quality: { def: 60, min: 20, max: 90 },
  width: { def: 800, min: 200, max: 1280 },
  /** Total base64 across the capture. Reached before the frame cap on a busy full-width page. */
  bytes: 3 * 1024 * 1024,
};

const clamp = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
};

type Running = {
  browserId: string;
  cdp: CdpClient;
  session: string;
  targetId: string;
  url: string;
  title: string;
  startedAt: number;
  t0: number | null;
  frames: CaptureFrame[];
  dropped: number;
  bytes: number;
  everyMs: number;
  maxFrames: number;
  frameWidth: number;
  stoppedBy: CaptureResult["stoppedBy"] | null;
  /** The page as it was before anything moved. Not part of the timing sequence. */
  baseline: CaptureFrame | null;
  firstFrameAt: number | null;
  lastFrameAt: number | null;
  settleMs: number;
  maxSeconds: number;
  timers: Set<NodeJS.Timeout>;
  finish: (why: CaptureResult["stoppedBy"]) => void;
};

const running = new Map<string, Running>();

/** Is a capture already in flight for this browser? */
export function isCapturing(browserId: string): boolean {
  return running.has(browserId);
}

function pickTarget(
  targets: Array<{ targetId: string; type: string; url?: string; title?: string; subtype?: string }>,
  wanted?: string,
): { targetId: string; url: string; title: string } {
  const pages = targets.filter((t) => t.type === "page" && !t.subtype && !String(t.url ?? "").startsWith("devtools://"));
  if (!pages.length) throw new Error("this browser has no page to record");
  if (wanted) {
    const found = pages.find((t) => t.targetId === wanted);
    if (!found) throw new Error(`no page with targetId ${wanted}; call tallylamp_screencast_start without one to record the active page`);
    return { targetId: found.targetId, url: String(found.url ?? ""), title: String(found.title ?? "") };
  }
  // The agent's own tab, not the startup tab: a browser whose work happens in a second tab
  // would otherwise record a blank page and look broken.
  const real = pages.filter((t) => t.url && t.url !== "about:blank");
  const pick = real.length ? real[real.length - 1]! : pages[0]!;
  return { targetId: pick.targetId, url: String(pick.url ?? ""), title: String(pick.title ?? "") };
}

export async function startCapture(
  browserId: string,
  cdpUrl: string,
  opts: CaptureOptions,
): Promise<{
  targetId: string;
  url: string;
  title: string;
  maxFrames: number;
  maxSeconds: number;
  armSeconds: number;
  settleMs: number;
}> {
  if (running.has(browserId)) {
    throw new Error("a recording is already running for this browser; stop it before starting another");
  }
  const maxFrames = clamp(opts.maxFrames, LIMITS.frames.def, 1, LIMITS.frames.max);
  const maxSeconds = clamp(opts.maxSeconds, LIMITS.seconds.def, 1, LIMITS.seconds.max);
  const armSeconds = clamp(opts.armSeconds, LIMITS.arm.def, 1, LIMITS.arm.max);
  const settleMs = clamp(opts.settleMs, LIMITS.settle.def, LIMITS.settle.min, LIMITS.settle.max);
  const quality = clamp(opts.quality, LIMITS.quality.def, LIMITS.quality.min, LIMITS.quality.max);
  const width = clamp(opts.maxWidth, LIMITS.width.def, LIMITS.width.min, LIMITS.width.max);
  const everyMs = clamp(opts.everyMs, 0, 0, 5000);

  const cdp = new CdpClient(await browserWsUrl(cdpUrl));
  await cdp.connect();
  try {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url?: string; title?: string; subtype?: string }>;
    };
    const target = pickTarget(targetInfos, opts.targetId);
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
      sessionId: string;
    };
    await cdp.send("Page.enable", {}, sessionId);

    const rec: Running = {
      browserId,
      cdp,
      session: sessionId,
      targetId: target.targetId,
      url: target.url,
      title: target.title,
      startedAt: Date.now(),
      t0: null,
      frames: [],
      dropped: 0,
      bytes: 0,
      everyMs,
      maxFrames,
      frameWidth: width,
      stoppedBy: null,
      baseline: null,
      firstFrameAt: null,
      lastFrameAt: null,
      settleMs,
      maxSeconds,
      timers: new Set(),
      finish: () => undefined,
    };

    const arm = (ms: number, why: CaptureResult["stoppedBy"]): NodeJS.Timeout => {
      const t = setTimeout(() => {
        rec.timers.delete(t);
        rec.finish(why);
      }, ms);
      t.unref?.();
      rec.timers.add(t);
      return t;
    };

    rec.finish = (why) => {
      if (rec.stoppedBy) return;
      rec.stoppedBy = why;
      for (const t of rec.timers) clearTimeout(t);
      rec.timers.clear();
      void cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
    };

    // Two clocks, not one. `armTimer` bounds how long we wait for the page to move at all and
    // is cancelled by the first frame; `maxSeconds` then bounds the motion itself. A wall-clock
    // budget spent the window on the round trip back to the agent and shut before the
    // interaction it was supposed to record had even started.
    let armTimer = arm(armSeconds * 1000, "noMotion");
    let settleTimer: NodeJS.Timeout | undefined;

    const onMotion = (): void => {
      if (rec.firstFrameAt === null) {
        rec.firstFrameAt = Date.now();
        clearTimeout(armTimer);
        rec.timers.delete(armTimer);
        armTimer = arm(rec.maxSeconds * 1000, "maxSeconds");
      }
      rec.lastFrameAt = Date.now();
      if (!rec.settleMs) return;
      // Each frame pushes the settle deadline out, so the capture ends when the page stops
      // rather than when the clock runs out. A 600 ms transition returns in ~600 ms.
      if (settleTimer) {
        clearTimeout(settleTimer);
        rec.timers.delete(settleTimer);
      }
      settleTimer = arm(rec.settleMs, "settled");
    };

    /**
     * The first frame is not motion.
     *
     * Verified against Chrome 152: startScreencast delivers exactly one frame immediately —
     * 153 ms, on a page that had been completely static for a second and a half — and then
     * nothing at all until something genuinely repaints. So the opening frame is a picture of
     * the page as it already was.
     *
     * Treating it as the start of the recording is what produced timings like
     * [0, 6882, 6981, ... 7496]: a baseline at zero, a gap that was really the round trip back
     * to the agent, and only then the 600 ms of movement the capture was about. Held aside as
     * a before-shot instead, so every number in the timing sequence is about the motion.
     */
    const takeBaseline = (data: string): void => {
      rec.baseline = { tMs: 0, data };
      rec.bytes += data.length;
    };

    cdp.onEvent = (method, params) => {
      if (method !== "Page.screencastFrame") return;
      const ackId = params.sessionId as number | undefined;
      // Ack straight away. A capture is short and bounded, and withholding the ack here would
      // throttle the very motion it is trying to measure.
      if (ackId !== undefined) {
        void cdp.send("Page.screencastFrameAck", { sessionId: ackId }, sessionId).catch(() => undefined);
      }
      if (rec.stoppedBy) return;
      const data0 = params.data as string;
      // The opening frame arms nothing: no motion clock, and above all no settle countdown,
      // or the capture would end 600 ms later having recorded only the page standing still.
      if (rec.baseline === null && rec.frames.length === 0) {
        takeBaseline(data0);
        return;
      }
      onMotion();
      const md = params.metadata as { timestamp?: number } | undefined;
      // Chrome's timestamp is wall-clock seconds. Relative milliseconds from the first frame is
      // the only form a consumer can reason about, and it is the entire point of this tool.
      const stamp = typeof md?.timestamp === "number" ? md.timestamp * 1000 : Date.now();
      if (rec.t0 === null) rec.t0 = stamp;
      const tMs = Math.max(0, Math.round(stamp - rec.t0));
      // everyMs decimates the stream; it does not drive it. Frames arrive only when the page
      // repaints, so a lower rate means "keep fewer of them", never "poll for more".
      const last = rec.frames[rec.frames.length - 1];
      if (rec.everyMs && last && tMs - last.tMs < rec.everyMs) {
        rec.dropped += 1;
        return;
      }
      const data = params.data as string;
      if (rec.bytes + data.length > LIMITS.bytes) {
        rec.finish("maxBytes");
        return;
      }
      rec.frames.push({ tMs, data });
      rec.bytes += data.length;
      if (rec.frames.length >= rec.maxFrames) rec.finish("maxFrames");
    };

    await cdp.send(
      "Page.startScreencast",
      { format: "jpeg", quality, maxWidth: width, maxHeight: Math.round(width * 2), everyNthFrame: 1 },
      sessionId,
    );
    running.set(browserId, rec);
    return { targetId: target.targetId, url: target.url, title: target.title, maxFrames, maxSeconds, armSeconds, settleMs };
  } catch (e) {
    await cdp.close();
    throw e;
  }
}

export async function stopCapture(browserId: string): Promise<CaptureResult> {
  const rec = running.get(browserId);
  if (!rec) throw new Error("no recording is running for this browser; call tallylamp_screencast_start first");
  running.delete(browserId);
  rec.finish("stopped");
  const result: CaptureResult = {
    targetId: rec.targetId,
    url: rec.url,
    title: rec.title,
    frames: rec.frames,
    baseline: rec.baseline,
    droppedFrames: rec.dropped,
    stoppedBy: rec.stoppedBy ?? "stopped",
    armedMs: rec.firstFrameAt === null ? null : rec.firstFrameAt - rec.startedAt,
    motionMs: rec.frames.length ? rec.frames[rec.frames.length - 1]!.tMs : 0,
    elapsedMs: Date.now() - rec.startedAt,
    frameWidth: rec.frameWidth,
  };
  await rec.cdp.send("Target.detachFromTarget", { sessionId: rec.session }).catch(() => undefined);
  await rec.cdp.close();
  return result;
}

/** Drop a capture without returning it. For a browser that is stopping or being torn down. */
export async function abandonCapture(browserId: string): Promise<void> {
  const rec = running.get(browserId);
  if (!rec) return;
  running.delete(browserId);
  rec.finish("gone");
  try {
    await rec.cdp.close();
  } catch (e) {
    log.debug("screencast abandon failed", { browserId, error: (e as Error).message });
  }
}
