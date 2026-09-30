import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evictionTargets, PageCacheEvictor, chromeInstallDir, type InUse } from "../src/page-cache.js";

describe("page cache eviction", () => {
  it("evicts a stopped profile, but never one a Chrome has open again", () => {
    const inUse: InUse = { dirs: ["/data/profiles/b"], idle: false };
    assert.deepEqual(
      evictionTargets(["/data/profiles/a", "/data/profiles/b"], inUse, "/data", "/opt/google/chrome"),
      ["/data/profiles/a"],
    );
  });

  it("takes the whole volume and Chrome's binaries once nothing runs", () => {
    const inUse: InUse = { dirs: [], idle: true };
    assert.deepEqual(
      evictionTargets(["/data/profiles/a"], inUse, "/data", "/opt/google/chrome"),
      ["/data/profiles/a", "/data", "/opt/google/chrome"],
    );
    assert.deepEqual(evictionTargets([], inUse, "/data", null), ["/data"]);
  });

  it("does not treat a shared bin directory as Chrome's install", () => {
    assert.equal(chromeInstallDir("/bin/sh"), null);
    assert.equal(chromeInstallDir("/no/such/chrome"), null);
  });

  it("sweeps once, after stops have been quiet for the delay", async () => {
    const prev = process.env.TALLYLAMP_EVICT_PAGE_CACHE;
    process.env.TALLYLAMP_EVICT_PAGE_CACHE = "1";
    const runs: string[][] = [];
    let inUse: InUse = { dirs: [], idle: false };
    const evictor = new PageCacheEvictor(() => inUse, {
      delayMs: 40,
      run: (paths) => runs.push(paths),
      dataDir: () => "/data",
      chromeDir: () => "/opt/google/chrome",
    });
    try {
      evictor.stopped("/data/profiles/a");
      await new Promise((r) => setTimeout(r, 20));
      evictor.stopped("/data/profiles/b");
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(runs.length, 0, "a second stop must push the sweep back");
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(runs, [["/data/profiles/a", "/data/profiles/b"]]);

      inUse = { dirs: [], idle: true };
      evictor.stopped("/data/profiles/a");
      await new Promise((r) => setTimeout(r, 70));
      assert.deepEqual(runs[1], ["/data/profiles/a", "/data", "/opt/google/chrome"]);
    } finally {
      evictor.cancel();
      if (prev === undefined) delete process.env.TALLYLAMP_EVICT_PAGE_CACHE;
      else process.env.TALLYLAMP_EVICT_PAGE_CACHE = prev;
    }
  });

  it("does nothing when turned off", async () => {
    const prev = process.env.TALLYLAMP_EVICT_PAGE_CACHE;
    process.env.TALLYLAMP_EVICT_PAGE_CACHE = "0";
    const runs: string[][] = [];
    const evictor = new PageCacheEvictor(() => ({ dirs: [], idle: true }), { delayMs: 10, run: (p) => runs.push(p) });
    try {
      evictor.stopped("/data/profiles/a");
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(runs.length, 0);
    } finally {
      evictor.cancel();
      if (prev === undefined) delete process.env.TALLYLAMP_EVICT_PAGE_CACHE;
      else process.env.TALLYLAMP_EVICT_PAGE_CACHE = prev;
    }
  });
});
