import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type PidLimit = { max: number; current: number; refused: number };

/**
 * The container's process ceiling, from the cgroup pids controller (v2, then v1). Threads
 * count against it, and each Chrome runs hundreds. At the ceiling the kernel refuses every
 * new process and thread: Chrome cannot start a renderer, so tabs crash and go blank, and
 * ffmpeg and xdotool cannot start. Railway sets 1000, which two busy browsers can reach.
 *
 * `refused` is the kernel's running count of refusals. Null when the host sets no ceiling or
 * does not expose one.
 */
export function readPidLimit(dir = config.cgroupDir): PidLimit | null {
  for (const d of [dir, path.join(dir, "pids")]) {
    let max: string;
    let current: number;
    try {
      max = readFileSync(path.join(d, "pids.max"), "utf8").trim();
      current = Number(readFileSync(path.join(d, "pids.current"), "utf8").trim());
    } catch {
      continue;
    }
    if (max === "max" || !Number.isFinite(Number(max)) || !Number.isFinite(current)) return null;
    let refused = 0;
    try {
      refused = Number(/^max (\d+)$/m.exec(readFileSync(path.join(d, "pids.events"), "utf8"))?.[1] ?? 0);
    } catch {
      /* v1 has no events file */
    }
    return { max: Number(max), current, refused };
  }
  return null;
}

export type ProcInfo = { pid: number; ppid: number; pgid: number; sid: number; threads: number; cmdline: string[] };

/**
 * Every process this user can see, with the three things accounting needs: who its parent is,
 * which process group it is in, and how many threads it holds against the ceiling.
 *
 * A sub-cgroup per browser would do this for free, but /sys/fs/cgroup is mounted read-only in
 * a Railway container, even for root. So the tree is rebuilt from /proc each time. Null where
 * there is no /proc to read (macOS), which callers treat as "cannot measure".
 */
export function scanProcesses(procDir = config.procDir): ProcInfo[] | null {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return null;
  }
  const out: ProcInfo[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(path.join(procDir, name, "stat"), "utf8");
      // The command name is in parentheses and may itself contain spaces and parentheses, so
      // the fixed fields are the ones after the last ")". Field 4 is ppid, 5 pgrp, 6 session,
      // 20 threads.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cmdline = parseCmdline(readFileSync(path.join(procDir, name, "cmdline"), "utf8"));
      out.push({
        pid: Number(name),
        ppid: Number(rest[1]),
        pgid: Number(rest[2]),
        sid: Number(rest[3]),
        threads: Number(rest[17]) || 1,
        cmdline,
      });
    } catch {
      /* exited between readdir and read */
    }
  }
  return out;
}

/**
 * A process's arguments from /proc/PID/cmdline, which separates them with NULs.
 *
 * Chrome on Linux retitles its child processes: it writes a new title over its own arguments,
 * so a renderer or zygote reads back as one string, "/opt/google/chrome/chrome --type=zygote
 * ...", with its flags joined by spaces. Read that way unsplit, no child had a --type, and in
 * production 0.9.0 counted every browser's renderer zygotes as zero.
 */
export function parseCmdline(raw: string): string[] {
  const args = raw.split("\0").filter(Boolean);
  return args.length === 1 && / --/.test(args[0]!) ? args[0]!.split(" ").filter(Boolean) : args;
}

export type ProcessKind =
  | "browser"
  | "renderer"
  | "extension"
  | "renderer-zygote"
  | "zygote"
  | "gpu"
  | "utility"
  | "crashpad"
  | "xvfb"
  | "bridge"
  | "other";

/** What a process in a browser's tree is, read off the flags Chrome gives each child. */
export function classify(cmdline: string[]): ProcessKind {
  const bin = path.basename(cmdline[0] ?? "");
  if (bin === "Xvfb") return "xvfb";
  if (bin.includes("crashpad")) return "crashpad";
  if (cmdline.some((a) => a.startsWith("--browser-url="))) return "bridge";
  const type = cmdline.find((a) => a.startsWith("--type="))?.slice(7);
  if (!type) return /chrom/i.test(bin) ? "browser" : "other";
  if (type === "zygote") return cmdline.includes("--no-zygote-sandbox") ? "zygote" : "renderer-zygote";
  if (type === "renderer") return cmdline.includes("--extension-process") ? "extension" : "renderer";
  if (type === "gpu-process") return "gpu";
  if (type === "utility" || type === "broker") return "utility";
  return "other";
}

export type Usage = {
  threads: number;
  processes: number;
  byKind: Partial<Record<ProcessKind, { processes: number; threads: number }>>;
  /**
   * The zygote renderers are forked from. Chrome runs two: this one, and the one started with
   * --no-zygote-sandbox for GPU and utility processes. Losing this one leaves a browser whose
   * process is alive and whose every navigation fails, because nothing can start a renderer.
   */
  rendererZygotes: number;
};

/**
 * One browser's share of the ceiling: Chrome's process group and everything descended from
 * it, its Xvfb, and the chrome-devtools-mcp bridges pointed at its debugging port.
 *
 * Group and session are what keep this honest after a failure. A renderer whose zygote died is
 * re-parented to PID 1, so it is no longer a descendant of anything, but it keeps the process
 * group Chrome was started in (stopRuntime kills by that same group). Chrome is spawned
 * detached, so it also leads a session of its own, which a child leaves only by calling setsid:
 * that still holds for a zygote that moved itself into a new process group.
 */
export function browserUsage(
  procs: ProcInfo[],
  root: { chromePid: number; xvfbPid?: number; cdpPort?: number },
): Usage {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const members = new Set<number>();
  const walk = (pid: number) => {
    if (members.has(pid)) return;
    members.add(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  walk(root.chromePid);
  const bridgeFlag = root.cdpPort ? `--browser-url=http://127.0.0.1:${root.cdpPort}` : null;
  for (const p of procs) {
    if (p.pgid === root.chromePid || p.sid === root.chromePid) walk(p.pid);
    else if (root.xvfbPid && (p.pid === root.xvfbPid || p.pgid === root.xvfbPid)) walk(p.pid);
    else if (bridgeFlag && p.cmdline.includes(bridgeFlag)) walk(p.pid);
  }
  const usage: Usage = { threads: 0, processes: 0, byKind: {}, rendererZygotes: 0 };
  for (const p of procs) {
    if (!members.has(p.pid)) continue;
    const kind = classify(p.cmdline);
    usage.threads += p.threads;
    usage.processes += 1;
    const k = (usage.byKind[kind] ??= { processes: 0, threads: 0 });
    k.processes += 1;
    k.threads += p.threads;
    if (kind === "renderer-zygote") usage.rendererZygotes += 1;
  }
  return usage;
}

/**
 * What to hold free for a browser about to start: the most it reached in the first minute of
 * its last start, plus a quarter and a fixed allowance. A launch restores the last session, so
 * that peak is the right shape for the next one. Never measured falls back to a flat figure.
 *
 * Measured on Railway with Chrome 154: 175-230 for one quiet tab, 418 for three busy ones. A
 * flat 450 for every browser refused the Kraken reader, which runs at about 187, with 356
 * free, which is what this replaced.
 */
export function launchEstimate(measured: number | null | undefined, fallback = config.browserThreads): number {
  if (!measured || measured <= 0) return fallback;
  return Math.ceil(measured * 1.25) + 25;
}

/**
 * The room a running browser should be allowed to grow into before anything is shed to keep
 * it alive. Its own peak plus a tenth; never less than it launched at.
 */
export function growthTarget(peak: number, launch: number): number {
  return Math.ceil(Math.max(peak, launch) * 1.1) + 25;
}

/** Parse the kernel's CPU list syntax ("0-3,8,10-11") into CPU numbers. */
export function parseCpuList(list: string): number[] {
  const out: number[] = [];
  for (const part of list.trim().split(",")) {
    if (!part) continue;
    const [a, b] = part.split("-").map(Number);
    if (!Number.isInteger(a)) continue;
    const end = Number.isInteger(b) ? b! : a!;
    for (let c = a!; c <= end; c++) out.push(c);
  }
  return out;
}

/** The CPUs this process may run on, from /proc/self/status. Null where it cannot be read. */
export function allowedCpus(procDir = config.procDir): number[] | null {
  try {
    const status = readFileSync(path.join(procDir, "self", "status"), "utf8");
    const list = /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1];
    const cpus = list ? parseCpuList(list) : [];
    return cpus.length ? cpus : null;
  } catch {
    return null;
  }
}
