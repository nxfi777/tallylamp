import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPidLimit } from "../src/host-limits.js";

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
