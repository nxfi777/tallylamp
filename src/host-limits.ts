import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Processes and threads to keep free for one more Chrome. Measured on Railway with Chrome
 * 154: 228 for a browser on one quiet tab, 418 for one with three busy tabs.
 */
export const PIDS_PER_BROWSER = 450;

export type PidLimit = { max: number; current: number; refused: number };

/**
 * The container's process ceiling, from the cgroup pids controller (v2, then v1). Threads
 * count against it, and each Chrome runs hundreds. At the ceiling the kernel refuses every
 * new process and thread: Chrome cannot start a renderer, so tabs crash and go blank, and
 * ffmpeg and xdotool cannot start. Railway sets 1000, which three browsers can reach.
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
