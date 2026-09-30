import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Hand back the page cache a stopped Chrome leaves behind.
 *
 * Railway bills the container's cgroup memory, and that counts the page cache: every profile
 * file a browser read or wrote, and ~300 MB of Chrome's own binaries. Nothing in a 32 GB cgroup
 * ever makes the kernel reclaim it, so it stays resident, and billed, long after the last Chrome
 * exits. The cgroup is mounted read-only, which rules out memory.reclaim and memory.high.
 * posix_fadvise(DONTNEED) is per file and needs no privilege, and vmtouch -e applies it to a whole
 * tree in one process, which matters on a host that has run out of processes before.
 *
 * DONTNEED drops only clean, unmapped pages: a running Chrome's mapped binary is untouched, and
 * the delay gives writeback time to clean what Chrome flushed on its way out.
 */

export interface InUse {
  /** Profile directories a real Chrome has open, or is starting on. */
  dirs: string[];
  /** No real Chrome running or starting, so shared files can go too. */
  idle: boolean;
}

/** What to evict once the delay has passed. Pure, so the choice can be tested without vmtouch. */
export function evictionTargets(stopped: Iterable<string>, inUse: InUse, dataDir: string, chromeDir: string | null): string[] {
  const busy = new Set(inUse.dirs);
  const targets = new Set([...stopped].filter((d) => d && !busy.has(d)));
  // Idle, the whole volume is fair game: snapshots and clones are copied through the cache too.
  if (inUse.idle) {
    targets.add(dataDir);
    if (chromeDir) targets.add(chromeDir);
  }
  return [...targets];
}

/** The directory Chrome's binaries live in, or null where that is a shared bin directory. */
export function chromeInstallDir(bin = config.chromeBin): string | null {
  try {
    const dir = path.dirname(realpathSync(bin));
    return ["/bin", "/usr/bin", "/usr/local/bin"].includes(dir) ? null : dir;
  } catch {
    return null;
  }
}

let warned = false;

function vmtouchEvict(paths: string[]): void {
  // -m: vmtouch skips files over 500 MB by default, and a Chrome binary is not far off.
  const child = spawn("vmtouch", ["-e", "-q", "-m", "64G", ...paths], { stdio: "ignore" });
  child.on("error", (e) => {
    if (warned) return;
    warned = true;
    log.warn("page cache eviction unavailable", { error: e.message });
  });
  child.unref();
}

export class PageCacheEvictor {
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly inUse: () => InUse,
    private readonly opts: {
      delayMs?: number;
      run?: (paths: string[]) => void;
      dataDir?: () => string;
      chromeDir?: () => string | null;
    } = {},
  ) {}

  /** A real Chrome on this profile has exited. Sweeps once stops have been quiet for the delay. */
  stopped(profileDir: string): void {
    if (!config.evictPageCache) return;
    this.pending.add(profileDir);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sweep(), this.opts.delayMs ?? 60_000);
    this.timer.unref();
  }

  private sweep(): void {
    this.timer = undefined;
    const targets = evictionTargets(
      this.pending,
      this.inUse(),
      (this.opts.dataDir ?? (() => config.dataDir))(),
      (this.opts.chromeDir ?? chromeInstallDir)(),
    );
    this.pending.clear();
    if (targets.length) (this.opts.run ?? vmtouchEvict)(targets);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
