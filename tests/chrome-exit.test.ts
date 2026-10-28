import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { exited, releaseEnded, type ChromeRuntime } from "../src/chrome.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};

describe("a Chrome that ends by itself", () => {
  it("counts a signal as an exit, and a stand-in without signalCode as running", () => {
    assert.equal(exited({ exitCode: null, signalCode: "SIGKILL" }), true, "a SIGKILLed Chrome has no exit code and is gone");
    assert.equal(exited({ exitCode: 0, signalCode: null }), true);
    assert.equal(exited({ exitCode: null, signalCode: null }), false);
    // Fakes, worker shims and linked browsers do not set signalCode at all.
    assert.equal(exited({ exitCode: null } as Pick<ChildProcess, "exitCode" | "signalCode">), false);
    assert.equal(exited({ exitCode: 1 } as Pick<ChildProcess, "exitCode" | "signalCode">), true);
  });

  it("takes its surviving process group and its Xvfb with it", async () => {
    // A group leader that has already died, leaving a child behind, the way a crashed Chrome
    // leaves renderers; and a separate long-lived process standing in for Xvfb.
    const leader = spawn("sh", ["-c", "sleep 30 & echo $!; exit 0"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const orphan = Number(await new Promise<string>((resolve) => leader.stdout!.once("data", (d) => resolve(String(d).trim()))));
    await waitFor(() => leader.exitCode !== null);
    const xvfb = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      assert.ok(alive(orphan) && alive(xvfb.pid!), "fixture processes must be running");
      releaseEnded({ chrome: leader, pgid: leader.pid, xvfb } as unknown as ChromeRuntime);
      assert.ok(await waitFor(() => !alive(orphan)), "the dead Chrome's remaining group must go");
      assert.ok(await waitFor(() => exited(xvfb)), "its display must go");
    } finally {
      for (const pid of [orphan, xvfb.pid]) try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("never signals its own process group, which is what a fake Chrome's pid is", () => {
    // Would SIGKILL this test runner's group if the guard were missing.
    releaseEnded({ chrome: { pid: process.pid }, pgid: process.pid } as unknown as ChromeRuntime);
    assert.ok(true);
  });
});
