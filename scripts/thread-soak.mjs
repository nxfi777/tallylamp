#!/usr/bin/env node
// Measure one Chrome launch configuration's thread count and stability over time.
//
//   node scripts/thread-soak.mjs --variant baseline --minutes 10 --url https://chatgpt.com/
//   node scripts/thread-soak.mjs --variant cpus=4 --minutes 10 --url https://chatgpt.com/
//
// Each variant sets the variable the service itself reads, so what is measured is what would
// ship: cpus=N (TALLYLAMP_CHROME_CPUS), renderer-limit=N (TALLYLAMP_RENDERER_PROCESS_LIMIT).
// Combine them with commas.
//
// Run it inside a Tallylamp container on a service that holds no production browser. It
// launches a real Chrome against the same process ceiling as every browser beside it, which
// is the thing being protected. It drives dist/, which the image has; from a checkout, run
// `npm run build` first. Run it as the service's user, not root (see docs/railway.md).
//
// Writes one JSON line per sample to --out as it goes, so a run that dies keeps what it
// measured, and prints a summary at the end:
//   - threads for the whole tree (min, median, max, last) and the largest seen per process kind;
//   - navigator.hardwareConcurrency, which is base::SysInfo::NumberOfProcessors(): if it reads
//     N under cpus=N, Chrome sizes its pools from the affinity mask and taskset can work;
//   - crashed tabs, failed reloads (every --reload-sec), and whether the renderer zygote was lost.
//
// Compare variants against a baseline run of the same URLs and length, taken back to back.

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const urls = argv.flatMap((a, i) => (a === "--url" ? [argv[i + 1]] : []));
if (!urls.length) urls.push("https://chatgpt.com/", "https://www.bbc.com/news");
const variant = opt("variant", "baseline");
const minutes = Number(opt("minutes", "10"));
const intervalMs = Number(opt("interval-sec", "10")) * 1000;
const reloadMs = Number(opt("reload-sec", "60")) * 1000;
const out = opt("out", path.resolve(`thread-soak-${variant.replace(/[^a-z0-9=-]+/gi, "_")}-${Date.now()}.jsonl`));

for (const part of variant.split(",")) {
  const [k, v] = part.split("=");
  if (k === "baseline") continue;
  else if (k === "cpus") process.env.TALLYLAMP_CHROME_CPUS = v;
  else if (k === "renderer-limit") process.env.TALLYLAMP_RENDERER_PROCESS_LIMIT = v;
  else throw new Error(`unknown variant part ${part}`);
}

const { launchChrome, stopRuntime } = await import("../dist/chrome.js");
const { browserUsage, readPidLimit, scanProcesses } = await import("../dist/host-limits.js");
const { CdpClient, browserWsUrl } = await import("../dist/cdp.js");

const profile = mkdtempSync(path.join(os.tmpdir(), "tallylamp-soak-"));
const write = (row) => appendFileSync(out, JSON.stringify(row) + "\n");
let rt;
let cdp;
const samples = [];
const events = { crashed: 0, reloads: 0, failedReloads: [], zygoteLost: false };

try {
  rt = await launchChrome({ profileDir: profile, downloadDir: path.join(profile, "dl") });
  cdp = new CdpClient(await browserWsUrl(rt.cdpUrl), 30_000);
  await cdp.connect();
  cdp.onEvent = (method) => {
    if (method === "Target.targetCrashed") events.crashed++;
  };
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const pages = [];
  for (const url of urls) {
    const { targetId } = await cdp.send("Target.createTarget", { url });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    pages.push({ url, sessionId });
  }
  await sleep(5_000);
  const hc = await cdp.send("Runtime.evaluate", { expression: "navigator.hardwareConcurrency", returnByValue: true }, pages[0].sessionId);
  // The CPUs Chrome actually got, read back from the kernel rather than from what was asked.
  const affinity = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync(`/proc/${rt.chrome.pid}/status`, "utf8"))?.[1] ?? null;
  const header = {
    kind: "header", variant, urls, minutes, chromeAffinity: affinity, hostCpus: os.availableParallelism(),
    hardwareConcurrency: hc?.result?.value ?? null, pids: readPidLimit(),
  };
  write(header);
  console.error(`soak ${variant}: ${minutes} min on ${urls.join(", ")}; writing ${out}`);

  const end = Date.now() + minutes * 60_000;
  let nextReload = Date.now() + reloadMs;
  let sawZygote = false;
  while (Date.now() < end) {
    const procs = scanProcesses();
    if (!procs) throw new Error("no /proc here; run this inside the Linux container");
    const u = browserUsage(procs, { chromePid: rt.chrome.pid, xvfbPid: rt.xvfb?.pid, cdpPort: rt.cdpPort });
    if (u.rendererZygotes > 0) sawZygote = true;
    else if (sawZygote) events.zygoteLost = true;
    const row = { kind: "sample", t: new Date().toISOString(), ...u, pids: readPidLimit(), crashed: events.crashed };
    samples.push(row);
    write(row);
    if (Date.now() >= nextReload) {
      nextReload += reloadMs;
      for (const p of pages) {
        events.reloads++;
        const r = await cdp.send("Page.navigate", { url: p.url }, p.sessionId).catch((e) => ({ errorText: e.message }));
        if (r?.errorText) events.failedReloads.push({ t: new Date().toISOString(), url: p.url, error: r.errorText });
      }
    }
    await sleep(intervalMs);
  }
} finally {
  await cdp?.close().catch(() => undefined);
  if (rt) await stopRuntime(rt).catch((e) => console.error("stop failed:", e.message));
  rmSync(profile, { recursive: true, force: true });
}

const threads = samples.map((s) => s.threads).sort((a, b) => a - b);
const kinds = {};
for (const s of samples) {
  for (const [k, v] of Object.entries(s.byKind)) kinds[k] = Math.max(kinds[k] ?? 0, v.threads);
}
const summary = {
  kind: "summary",
  variant,
  samples: samples.length,
  threads: threads.length
    ? { min: threads[0], median: threads[Math.floor(threads.length / 2)], max: threads[threads.length - 1], last: samples.at(-1).threads }
    : null,
  maxThreadsByKind: kinds,
  maxRenderers: Math.max(0, ...samples.map((s) => s.byKind.renderer?.processes ?? 0)),
  ...events,
  failedReloads: events.failedReloads.length,
  failedReloadSamples: events.failedReloads.slice(0, 5),
};
write(summary);
console.log(JSON.stringify(summary, null, 2));
