/** Real disk/SQLite profile cloning, fake Chrome never started. */
import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { startTestServer } from "../tests/helpers.js";
import { adminPrincipal } from "../src/auth.js";

const label = process.argv[2] ?? "after";
const directory = path.resolve("docs/audits/performance-2026-10-09");
mkdirSync(directory, { recursive: true });
const target = path.join(directory, `profile-clone-${label}.json`);
const report = { label, timestamp: new Date().toISOString(), node: process.version, realFilesystem: true, fakeChrome: true,
  gaps: ["Warm local filesystem; not disk cold-start, network storage, or real Chrome resume.", "Five samples per size; timer measures event-loop responsiveness during clone, not client round trip."], results: [] as unknown[] };
function checkpoint() { writeFileSync(`${target}.tmp`, JSON.stringify(report, null, 2) + "\n"); renameSync(`${target}.tmp`, target); }
function distribution(values: number[]) { const sorted = [...values].sort((a, b) => a-b); return { p50Ms: sorted[Math.ceil(sorted.length*.5)-1], p95Ms: sorted[Math.ceil(sorted.length*.95)-1], rawMs: values }; }
const ctx = await startTestServer();
ctx.browsers.workers.stopPolling();
const principal = adminPrincipal();
try {
  for (const files of [64, 1024]) {
    const source = await ctx.browsers.create({ principal, via: "dashboard", name: `Clone ${files}` });
    const bytes = Buffer.alloc(16*1024, 42);
    for (let i=0;i<files;i++) writeFileSync(path.join(source.profile_path, `fixture-${i}`), bytes);
    const seed = await ctx.browsers.snapshotSeed(source.id, `Seed ${files}`, principal);
    const elapsed: number[] = [], maxTimerGap: number[] = [], deleteElapsed: number[] = [], deleteTimerGap: number[] = [];
    for (let sample=0;sample<5;sample++) {
      let last = performance.now(), maxGap = 0;
      const tick = setInterval(() => { const at=performance.now(); maxGap=Math.max(maxGap, at-last); last=at; }, 1);
      const start = performance.now();
      const clone = await ctx.browsers.create({ principal, via: "dashboard", seedId: seed.id, name: `Copy ${sample}` });
      elapsed.push(performance.now()-start);
      await new Promise(resolve => setTimeout(resolve, 2)); clearInterval(tick); maxTimerGap.push(maxGap);
      assert.notEqual(clone.profile_path, source.profile_path);
      last = performance.now(); maxGap = 0;
      const deletionTick = setInterval(() => { const at=performance.now(); maxGap=Math.max(maxGap, at-last); last=at; }, 1);
      const deletionStart = performance.now();
      await ctx.browsers.destroy(clone.id, principal);
      deleteElapsed.push(performance.now()-deletionStart);
      await new Promise(resolve => setTimeout(resolve, 2)); clearInterval(deletionTick); deleteTimerGap.push(maxGap);
    }
    report.results.push({ bytes: files*bytes.length, files, samples: 5, clone: distribution(elapsed), maxTimerGap: distribution(maxTimerGap), deletion: distribution(deleteElapsed), deleteTimerGap: distribution(deleteTimerGap) });
    checkpoint();
    await ctx.browsers.destroy(source.id, principal);
    await ctx.browsers.deleteSeed(seed.id, `Seed ${files}`, principal);
  }
} finally { await ctx.close(); checkpoint(); }
