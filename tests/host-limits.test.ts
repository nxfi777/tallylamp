import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  browserUsage,
  classify,
  growthTarget,
  launchEstimate,
  parseCpuList,
  readPidLimit,
  scanProcesses,
  type ProcInfo,
} from "../src/host-limits.js";

const root = mkdtempSync(path.join(os.tmpdir(), "tallylamp-pids-"));
const dir = (name: string, files: Record<string, string>, sub = "") => {
  const d = path.join(root, name);
  mkdirSync(path.join(d, sub), { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(d, sub, f), v);
  return d;
};

describe("host process limit", () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  it("reads a cgroup v2 ceiling, usage and the kernel's refusal count", () => {
    const d = dir("v2", { "pids.max": "1000\n", "pids.current": "702\n", "pids.events": "max 485\n" });
    assert.deepEqual(readPidLimit(d), { max: 1000, current: 702, refused: 485 });
  });

  it("reads the v1 layout, which has no events file", () => {
    const d = dir("v1", { "pids.max": "4096\n", "pids.current": "12\n" }, "pids");
    assert.deepEqual(readPidLimit(d), { max: 4096, current: 12, refused: 0 });
  });

  it("reports no limit when the host sets none or does not say", () => {
    assert.equal(readPidLimit(dir("unlimited", { "pids.max": "max\n", "pids.current": "40\n" })), null);
    assert.equal(readPidLimit(path.join(root, "missing")), null);
  });
});

/** A /proc entry: stat with ppid, pgrp and thread count in their real positions, and a cmdline. */
function proc(procDir: string, pid: number, ppid: number, pgid: number, threads: number, argv: string[], comm = "chrome", sid = pgid) {
  const d = path.join(procDir, String(pid));
  mkdirSync(d, { recursive: true });
  // Fields 3..20: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime
  // stime cutime cstime priority nice num_threads.
  writeFileSync(path.join(d, "stat"), `${pid} (${comm}) S ${ppid} ${pgid} ${sid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${threads} 0 0\n`);
  writeFileSync(path.join(d, "cmdline"), argv.join("\0") + "\0");
}

const CHROME = "/opt/google/chrome/chrome";

describe("per-browser process accounting", () => {
  const procDir = mkdtempSync(path.join(os.tmpdir(), "tallylamp-proc-"));
  after(() => rmSync(procDir, { recursive: true, force: true }));

  // The incident's shape: the renderer zygote is gone, its renderers were re-parented to PID 1,
  // and only the --no-zygote-sandbox zygote is left under the browser process.
  proc(procDir, 1, 0, 1, 1, ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"], "tini");
  proc(procDir, 50, 1, 50, 11, ["node", "/app/dist/index.js"], "node");
  proc(procDir, 100, 50, 100, 40, [CHROME, "--remote-debugging-port=9222", "--user-data-dir=/data/profiles/a"]);
  proc(procDir, 101, 100, 100, 3, [CHROME, "--type=zygote", "--no-zygote-sandbox"]);
  proc(procDir, 102, 101, 100, 28, [CHROME, "--type=gpu-process"]);
  proc(procDir, 103, 101, 100, 9, [CHROME, "--type=utility", "--utility-sub-type=network.mojom.NetworkService"]);
  proc(procDir, 110, 1, 100, 31, [CHROME, "--type=renderer", "--renderer-client-id=5"]);
  proc(procDir, 111, 1, 100, 45, [CHROME, "--type=renderer", "--extension-process"]);
  // An orphan whose zygote had moved to a process group of its own: only the session is left.
  proc(procDir, 112, 1, 105, 6, [CHROME, "--type=renderer"], "chrome", 100);
  proc(procDir, 120, 50, 120, 2, ["Xvfb", ":1234", "-screen", "0"], "Xvfb");
  proc(procDir, 130, 50, 50, 12, ["node", "/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", "--browser-url=http://127.0.0.1:9222"], "node");
  // A second, healthy browser: must not be counted in the first one.
  proc(procDir, 200, 50, 200, 38, [CHROME, "--remote-debugging-port=9333"]);
  proc(procDir, 201, 200, 200, 3, [CHROME, "--type=zygote", "--no-zygote-sandbox"]);
  proc(procDir, 202, 200, 200, 3, [CHROME, "--type=zygote"]);
  proc(procDir, 203, 202, 200, 24, [CHROME, "--type=renderer"]);
  proc(procDir, 230, 50, 50, 12, ["node", "chrome-devtools-mcp.js", "--browser-url=http://127.0.0.1:9333"], "node");

  it("reads parent, process group and threads off stat, even with spaces in the command name", () => {
    proc(procDir, 300, 1, 300, 7, ["x"], "Web Content (x)");
    const procs = scanProcesses(procDir)!;
    const odd = procs.find((p) => p.pid === 300)!;
    assert.deepEqual({ ppid: odd.ppid, pgid: odd.pgid, sid: odd.sid, threads: odd.threads }, { ppid: 1, pgid: 300, sid: 300, threads: 7 });
    rmSync(path.join(procDir, "300"), { recursive: true });
    assert.equal(scanProcesses(path.join(procDir, "nope")), null);
  });

  it("names each Chrome process by the flags it was started with", () => {
    assert.equal(classify([CHROME]), "browser");
    assert.equal(classify([CHROME, "--type=zygote"]), "renderer-zygote");
    assert.equal(classify([CHROME, "--type=zygote", "--no-zygote-sandbox"]), "zygote");
    assert.equal(classify([CHROME, "--type=renderer"]), "renderer");
    assert.equal(classify([CHROME, "--type=renderer", "--extension-process"]), "extension");
    assert.equal(classify([CHROME, "--type=gpu-process"]), "gpu");
    assert.equal(classify(["/opt/google/chrome/chrome_crashpad_handler"]), "crashpad");
    assert.equal(classify(["Xvfb", ":1"]), "xvfb");
    assert.equal(classify(["node", "x.js", "--browser-url=http://127.0.0.1:1"]), "bridge");
  });

  it("counts a browser's orphaned renderers, its Xvfb and its bridges, and nothing of another browser's", () => {
    const procs = scanProcesses(procDir) as ProcInfo[];
    const a = browserUsage(procs, { chromePid: 100, xvfbPid: 120, cdpPort: 9222 });
    // 40 + 3 + 28 + 9 + 31 + 45 (orphans kept by process group) + 6 (by session) + 2 (Xvfb)
    // + 12 (bridge)
    assert.equal(a.threads, 176);
    assert.equal(a.processes, 9);
    assert.equal(a.byKind.renderer?.threads, 37);
    assert.equal(a.byKind.extension?.threads, 45);
    assert.equal(a.byKind.bridge?.processes, 1);
    assert.equal(a.rendererZygotes, 0, "the renderer zygote is the one that died");

    const b = browserUsage(procs, { chromePid: 200, cdpPort: 9333 });
    assert.equal(b.threads, 38 + 3 + 3 + 24 + 12);
    assert.equal(b.rendererZygotes, 1);
  });

  it("admits on the measured launch peak plus a margin, not a flat figure", () => {
    // The Kraken reader runs at about 187. The flat 450 this replaced refused it with 356 free.
    assert.ok(launchEstimate(187) <= 356 - 50, `estimate ${launchEstimate(187)}`);
    assert.equal(launchEstimate(null, 300), 300);
    assert.equal(launchEstimate(0, 300), 300);
    assert.ok(growthTarget(190, 150) > 190);
  });

  it("parses the kernel's CPU lists", () => {
    assert.deepEqual(parseCpuList("0-3,8,10-11\n"), [0, 1, 2, 3, 8, 10, 11]);
    assert.deepEqual(parseCpuList(""), []);
  });
});
