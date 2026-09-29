import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { Err } from "./errors.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { activity } from "./audit.js";
import {
  browserUsage,
  growthTarget,
  launchEstimate,
  readPidLimit,
  scanProcesses,
  type PidLimit,
  type Usage,
} from "./host-limits.js";
import type { BrowserManager } from "./browsers.js";

/** A start's first minute: session restore and the first page loads, which is its launch peak. */
const LAUNCH_WINDOW_MS = 60_000;
const SAMPLE_MS = 2_000;
/** A full /proc walk every tenth second, and every tick while anything is launching or tight. */
const FULL_SCAN_EVERY = 5;
const RESTART_WINDOW_MS = 30 * 60_000;
/** How long after stopping one active browser before another may be stopped for a pinned one. */
const ACTIVE_SHED_COOLDOWN_MS = 10_000;
/** One refusal notice per browser per minute: a fork storm refuses hundreds in a second. */
const REFUSAL_NOTICE_MS = 60_000;

type Track = {
  startedAt: number;
  usage: Usage | null;
  launchPeak: number;
  peak: number;
  /** What was last written to peak_threads, so the row is not rewritten every sample. */
  savedPeak: number;
  launchSaved: boolean;
  sawRendererZygote: boolean;
  zygoteMisses: number;
};

type Waiter = { id: string; pinned: boolean; need: number; since: number };

export type Refusal = { at: string; count: number; total: number; current: number; max: number };

/**
 * The host's process ceiling, shared by every browser.
 *
 * Railway caps a container at 1,000 processes and threads (cgroup v2 pids.max), and it cannot
 * be raised on a normal plan or subdivided from inside: /sys/fs/cgroup is read-only. One
 * browser loading heavy pages can take 600 of those on its own. At the ceiling the kernel
 * refuses every fork, from whichever browser asks next, and that is silent from Chrome's side:
 * on 2026-09-29 it killed a production browser's renderer zygote, leaving a Chrome that was
 * alive, listed as running, and unable to load any page.
 *
 * So this does, from outside, what a per-browser cgroup would have done:
 *
 * - counts each browser's threads by process tree (host-limits.ts), and remembers the peaks;
 * - admits a start on that browser's measured launch peak, and queues it rather than
 *   refusing outright when there is no room yet;
 * - holds room for pinned browsers, so an unpinned one cannot start into it;
 * - stops idle unpinned browsers when the room runs short, and stops active unpinned ones
 *   only to keep a running pinned browser from being starved;
 * - notices a browser that has lost its renderer zygote and has it restarted;
 * - tells the dashboard and the affected agents when the kernel refuses anything.
 */
export class Capacity {
  private tracks = new Map<string, Track>();
  /** Admitted and launching: counted at their full estimate until they have a track. */
  private launching = new Map<string, number>();
  private waiting = new Map<string, Waiter>();
  private restarts = new Map<string, number[]>();
  private refusalNoticeAt = new Map<string, number>();
  private refusedSeen: number;
  private tick = 0;
  private forceScans = 0;
  private shedding = false;
  private pressureTicks = 0;
  private lastActiveShedAt = 0;
  lastPids: PidLimit | null;
  lastRefusal: Refusal | null = null;
  /** Per-browser usage, keyed by browser id. Tests stand in for /proc here. */
  measure: () => Map<string, Usage> | null = () => this.measureFromProc();

  private timer: NodeJS.Timeout;

  constructor(private fleet: BrowserManager) {
    this.lastPids = readPidLimit();
    this.refusedSeen = this.lastPids?.refused ?? 0;
    this.timer = setInterval(() => {
      void this.sampleNow().catch((e) => log.warn("host capacity sample failed", { error: (e as Error).message }));
    }, SAMPLE_MS);
    this.timer.unref?.();
  }

  /** Stop sampling: at shutdown, and in tests that drive sampleNow() themselves. */
  stopSampling(): void {
    clearInterval(this.timer);
  }

  /** A browser that has just started: its launch window opens now. */
  launched(id: string): void {
    this.launching.delete(id);
    this.tracks.set(id, {
      startedAt: Date.now(),
      usage: null,
      launchPeak: 0,
      peak: 0,
      savedPeak: this.fleet.row(id).peak_threads ?? 0,
      launchSaved: false,
      sawRendererZygote: false,
      zygoteMisses: 0,
    });
    this.forceScans = Math.max(this.forceScans, 1);
  }

  /** A browser that has stopped or died. What it reached is kept for its next start. */
  stopped(id: string): void {
    const t = this.tracks.get(id);
    this.tracks.delete(id);
    if (!t) return;
    const row = this.fleet.row(id);
    // A run cut short inside its first minute has not shown its full launch peak, so it may
    // only raise what is on record, never lower it.
    const launch = t.launchSaved ? null : t.launchPeak > 0 ? Math.max(t.launchPeak, row.launch_threads ?? 0) : null;
    this.fleet.recordThreads(id, launch, t.peak > 0 ? t.peak : null);
  }

  /** The start has launched or failed; either way it is no longer held at its estimate. */
  release(id: string): void {
    this.launching.delete(id);
    this.waiting.delete(id);
  }

  estimate(id: string): number {
    return launchEstimate(this.fleet.row(id).launch_threads);
  }

  threads(id: string): number | null {
    return this.tracks.get(id)?.usage?.threads ?? null;
  }

  view(id: string) {
    const t = this.tracks.get(id);
    const row = this.fleet.row(id);
    return {
      threads: t?.usage?.threads ?? null,
      peakThreads: t && t.peak > 0 ? t.peak : row.peak_threads ?? null,
      launchThreads: row.launch_threads ?? null,
    };
  }

  hostView() {
    const pids = this.lastPids;
    if (!pids) return { pids: null, lastRefusal: this.lastRefusal };
    const measured = [...this.tracks.values()].reduce((n, t) => n + (t.usage?.threads ?? 0), 0);
    return {
      pids,
      free: pids.max - pids.current,
      headroom: config.processHeadroom,
      held: this.holds().total,
      // Tallylamp itself, the bridges of browsers it did not launch, ffmpeg: whatever is not in
      // a browser's tree.
      other: Math.max(0, pids.current - measured),
      lastRefusal: this.lastRefusal,
    };
  }

  /** Whether the kernel refused a process or thread within the last `ms`. */
  refusedWithin(ms: number): boolean {
    return Boolean(this.lastRefusal && Date.now() - Date.parse(this.lastRefusal.at) < ms);
  }

  /** Take one of the browser's automatic restarts, if it has any left in this window. */
  takeRestart(id: string): boolean {
    const now = Date.now();
    const recent = (this.restarts.get(id) ?? []).filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length >= config.unhealthyRestarts) {
      this.restarts.set(id, recent);
      return false;
    }
    recent.push(now);
    this.restarts.set(id, recent);
    return true;
  }

  /**
   * Wait until there is room to start this browser, making room where that is allowed.
   *
   * Room is the ceiling, less what is in use, less the fixed headroom, less what is held for
   * others: starts in flight, browsers still in their first minute, pinned browsers, and
   * starts that were queued first. A pinned browser is admitted ahead of any unpinned one and
   * may stop unpinned browsers to get in; an unpinned one may stop only idle ones.
   *
   * The check and the reservation happen with no await between them, which is what stops two
   * concurrent starts from both reading the same free room and both launching.
   */
  async admit(id: string, onQueued: (need: number, free: number) => void): Promise<void> {
    if (!readPidLimit()) return;
    const row = this.fleet.row(id);
    const me: Waiter = { id, pinned: row.pinned === 1, need: this.estimate(id), since: Date.now() };
    const deadline = me.since + config.admissionWaitMs;
    let queued = false;
    for (;;) {
      // Re-read every pass. A browser pinned while its start is waiting must be admitted as
      // pinned: in 0.9.0 a pin made mid-wait changed nothing until the next start.
      me.pinned = this.fleet.row(id).pinned === 1;
      const pids = readPidLimit();
      if (!pids) return;
      const held = this.holds(me).total;
      const room = pids.max - pids.current - config.processHeadroom - held;
      if (room >= me.need) {
        this.waiting.delete(id);
        this.launching.set(id, me.need);
        return;
      }
      const made = await this.shed(me.need - room, {
        active: me.pinned,
        whole: true,
        exclude: id,
        why: me.pinned ? `to make room for pinned browser ${row.name}` : `to make room for ${row.name}`,
      });
      if (made) continue;
      if (Date.now() >= deadline) {
        this.waiting.delete(id);
        throw Err.fleetFull(this.fullMessage(row.name, me.need, pids, held, config.admissionWaitMs));
      }
      if (!queued) {
        queued = true;
        this.waiting.set(id, me);
        log.info("browser start queued for host processes", { id, need: me.need, free: pids.max - pids.current, held });
        onQueued(me.need, pids.max - pids.current);
      }
      await sleep(1000);
    }
  }

  /**
   * What is held back from a start, and from nothing (the watchdog's view).
   *
   * One figure per browser, the largest that applies, so a pinned browser waiting in the queue
   * is not held twice.
   */
  private holds(requester?: Waiter): { total: number; pinnedGrowth: number; runningPinned: number } {
    const hold = new Map<string, number>();
    const put = (id: string, n: number) => {
      if (id === requester?.id || n <= 0) return;
      hold.set(id, Math.max(hold.get(id) ?? 0, n));
    };
    const now = Date.now();
    for (const [id, need] of this.launching) put(id, need);
    for (const [id, t] of this.tracks) {
      if (now - t.startedAt < LAUNCH_WINDOW_MS) put(id, this.estimate(id) - (t.usage?.threads ?? 0));
    }
    let pinnedGrowth = 0;
    let runningPinned = 0;
    for (const p of this.fleet.pinnedRows()) {
      if (p.id === requester?.id) continue;
      if (this.fleet.runtime(p.id)) {
        runningPinned++;
        const t = this.tracks.get(p.id);
        if (!t?.usage) continue;
        const grow = growthTarget(Math.max(t.peak, p.peak_threads ?? 0), p.launch_threads ?? 0) - t.usage.threads;
        if (grow > 0) pinnedGrowth += grow;
        put(p.id, grow);
      } else {
        // Stopped: enough to start it again, whenever someone asks.
        put(p.id, launchEstimate(p.launch_threads));
      }
    }
    for (const w of this.waiting.values()) {
      if (!requester || w.id === requester.id) continue;
      const ahead = (w.pinned && !requester.pinned) || (w.pinned === requester.pinned && w.since < requester.since);
      if (ahead) put(w.id, w.need);
    }
    let total = 0;
    for (const n of hold.values()) total += n;
    return { total, pinnedGrowth, runningPinned };
  }

  /**
   * Stop unpinned browsers until `need` threads are free. Idle ones go first, largest first;
   * active ones only when `active` is set, which is only ever on behalf of a pinned browser.
   *
   * `whole`: stop nothing unless the whole need can be met. A start that would still not fit
   * afterwards gains nothing from a browser being stopped for it.
   */
  private async shed(need: number, opts: { active: boolean; whole: boolean; exclude?: string; why: string }): Promise<boolean> {
    if (need <= 0 || this.shedding) return false;
    const now = Date.now();
    const candidates: Array<{ id: string; threads: number; idle: boolean }> = [];
    for (const id of this.fleet.managedIds()) {
      if (id === opts.exclude || this.fleet.row(id).pinned === 1 || this.fleet.busy(id)) continue;
      // Never stop a browser under a person who holds its keyboard.
      if (this.fleet.isHumanControlled(id)) continue;
      const threads = this.threads(id);
      if (threads === null) continue;
      candidates.push({ id, threads, idle: this.fleet.idleFor(id) >= config.shedIdleMs && config.shedIdleMs > 0 });
    }
    const pick: typeof candidates = [];
    let freed = 0;
    const take = (list: typeof candidates) => {
      for (const c of list.sort((a, b) => b.threads - a.threads)) {
        if (freed >= need) return;
        pick.push(c);
        freed += c.threads;
      }
    };
    take(candidates.filter((c) => c.idle));
    // After stopping one active browser, give the counts a moment to settle before the next.
    if (opts.active && freed < need && now - this.lastActiveShedAt >= ACTIVE_SHED_COOLDOWN_MS) {
      take(candidates.filter((c) => !c.idle));
    }
    if (!pick.length || (opts.whole && freed < need)) return false;
    this.shedding = true;
    try {
      for (const c of pick) {
        if (!c.idle) this.lastActiveShedAt = Date.now();
        await this.fleet.shedStop(c.id, c.threads, c.idle, opts.why);
      }
    } finally {
      this.shedding = false;
    }
    this.forceScans = Math.max(this.forceScans, 1);
    return true;
  }

  /** One sample of the ceiling, and a scan of every browser's tree when one is due. */
  async sampleNow(): Promise<void> {
    if (this.fleet.shuttingDown) return;
    const pids = readPidLimit();
    this.lastPids = pids;
    if (pids && pids.refused > this.refusedSeen) this.onRefused(pids);
    this.tick++;
    const now = Date.now();
    const launching = this.launching.size > 0 || [...this.tracks.values()].some((t) => now - t.startedAt < LAUNCH_WINDOW_MS);
    const tight = pids !== null && pids.max - pids.current < config.processHeadroom + this.holds().total + 50;
    if (this.tick % FULL_SCAN_EVERY === 0 || launching || tight || this.forceScans > 0) {
      if (this.forceScans > 0) this.forceScans--;
      this.scan();
    }
    if (pids) await this.relieve(pids);
  }

  private measureFromProc(): Map<string, Usage> | null {
    const procs = scanProcesses();
    if (!procs) return null;
    const out = new Map<string, Usage>();
    for (const id of this.fleet.managedIds()) {
      const rt = this.fleet.runtime(id);
      // The test fake's "Chrome" is this very process; counting it would count Tallylamp.
      if (!rt?.chrome.pid || this.fleet.isShim(id)) continue;
      out.set(id, browserUsage(procs, { chromePid: rt.chrome.pid, xvfbPid: rt.xvfb?.pid, cdpPort: rt.cdpPort }));
    }
    return out;
  }

  private scan(): void {
    const usages = this.measure();
    if (!usages) return;
    const now = Date.now();
    for (const [id, u] of usages) {
      const t = this.tracks.get(id);
      if (!t) continue;
      t.usage = u;
      t.peak = Math.max(t.peak, u.threads);
      if (now - t.startedAt < LAUNCH_WINDOW_MS) {
        t.launchPeak = Math.max(t.launchPeak, u.threads);
      } else if (!t.launchSaved) {
        t.launchSaved = true;
        if (t.launchPeak > 0) this.fleet.recordThreads(id, t.launchPeak, null);
      }
      if (t.peak >= t.savedPeak * 1.1 + 10) {
        t.savedPeak = t.peak;
        this.fleet.recordThreads(id, null, t.peak);
      }
      this.checkZygote(id, t, u);
    }
  }

  /**
   * A browser that had a renderer zygote and no longer has one cannot start a renderer for
   * anything: every navigation to a new site fails with net::ERR_ABORTED while the browser
   * process itself, and so its "running" status, carries on. Two misses in a row, with the
   * browser process still there, so a Chrome that is part-way through exiting is not mistaken
   * for a broken one. A Chrome that never had one (another platform, --no-zygote) is left alone.
   */
  private checkZygote(id: string, t: Track, u: Usage): void {
    if (u.rendererZygotes > 0) {
      t.sawRendererZygote = true;
      t.zygoteMisses = 0;
      return;
    }
    if (!t.sawRendererZygote || !u.byKind.browser?.processes) return;
    if (++t.zygoteMisses < 2) return;
    t.zygoteMisses = 0;
    void this.fleet.markUnhealthy(id, "Chrome lost the zygote that starts its renderers, so no new page can load")
      .catch((e) => log.warn("unhealthy browser handling failed", { id, error: (e as Error).message }));
  }

  /**
   * Keep room free without waiting for a start to ask for it.
   *
   * Idle unpinned browsers are stopped whenever free room falls below what is held. An active
   * unpinned browser is stopped only when a running pinned browser is about to be starved, and
   * only once the shortfall has lasted two samples, so a single spike stops nothing.
   */
  private async relieve(pids: PidLimit): Promise<void> {
    if (this.shedding) return;
    const free = pids.max - pids.current;
    const { total, pinnedGrowth, runningPinned } = this.holds();
    const short = total + config.processHeadroom - free;
    if (short > 0 && await this.shed(short, { active: false, whole: false, why: "because the host was running out of processes" })) {
      this.pressureTicks = 0;
      return;
    }
    const starving = runningPinned > 0 ? pinnedGrowth + config.processHeadroom - free : 0;
    if (starving <= 0) {
      this.pressureTicks = 0;
      return;
    }
    if (++this.pressureTicks < 2) return;
    this.pressureTicks = 0;
    await this.shed(starving, { active: true, whole: false, why: "to keep a pinned browser from running out of processes" });
  }

  private onRefused(pids: PidLimit): void {
    const delta = pids.refused - this.refusedSeen;
    this.refusedSeen = pids.refused;
    const now = Date.now();
    const prev = this.lastRefusal;
    // One episode, not one line per sample: a fork storm spans several.
    const count = prev && now - Date.parse(prev.at) < REFUSAL_NOTICE_MS ? prev.count + delta : delta;
    this.lastRefusal = { at: new Date(now).toISOString(), count, total: pids.refused, current: pids.current, max: pids.max };
    const running = this.fleet.managedIds();
    log.warn("host process limit reached: the kernel refused new processes and threads", {
      max: pids.max, current: pids.current, refused: delta, running: running.length,
      threads: Object.fromEntries(running.map((id) => [id, this.threads(id)])),
    });
    hub.emitEvent("host.pids_refused", { ...this.lastRefusal, refused: delta });
    const clock = new Date(now).toISOString().slice(11, 19);
    for (const id of running) {
      if (now - (this.refusalNoticeAt.get(id) ?? 0) < REFUSAL_NOTICE_MS) continue;
      this.refusalNoticeAt.set(id, now);
      activity(id, "host", `host refused ${delta} processes (${pids.current} of ${pids.max} in use)`);
      this.fleet.notice(
        id,
        `At ${clock} UTC the host refused ${delta} new processes and threads (${pids.current} of ${pids.max} in use). ` +
          `Tabs in this browser may have crashed. If pages stop loading, Tallylamp restarts it.`,
      );
    }
    // A zygote killed by the refusal may take a moment to be reaped: look now and again shortly.
    this.forceScans = Math.max(this.forceScans, 3);
  }

  private fullMessage(name: string, need: number, pids: PidLimit, held: number, waitedMs: number): string {
    const top = this.fleet.managedIds()
      .map((id) => ({ name: this.fleet.row(id).name, threads: this.threads(id) }))
      .filter((b): b is { name: string; threads: number } => b.threads !== null)
      .sort((a, b) => b.threads - a.threads)
      .slice(0, 3)
      .map((b) => `${b.name} (${b.threads})`);
    return (
      `This host is out of room for ${name}: ${pids.current} of ${pids.max} processes and threads are in use` +
      (held > 0 ? `, ${held} more are held for pinned browsers and starts in progress` : "") +
      `, and ${name} needs about ${need}. ` +
      (waitedMs > 0 ? `It waited ${Math.round(waitedMs / 1000)} seconds for room. ` : "") +
      (top.length ? `The largest running browsers are ${top.join(", ")}. ` : "") +
      `Stop a browser you are not using, then start this one.`
    );
  }
}
