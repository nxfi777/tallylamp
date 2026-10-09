/** Real, isolated headed Chrome through the service. Run only when no other audit Chrome is active. */
import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { startTestServer } from "../tests/helpers.js";
import { adminPrincipal } from "../src/auth.js";
import { browserWsUrl, CdpClient } from "../src/cdp.js";
import { config } from "../src/config.js";

const label = process.argv[2] ?? "after";
const startupCount = Math.max(1, Number(process.env.BENCH_STARTS ?? 3));
const fixtureMode = process.env.BENCH_FIXTURE_MODE ?? "navigate";
const directory = path.resolve("docs/audits/performance-2026-10-09");
mkdirSync(directory, { recursive: true });
const target = path.join(directory, `managed-${label}.json`);
const results: Array<Record<string, unknown>> = [];
const gaps = [
  "Local macOS managed Chrome and localhost transport; not hosted worker/internet latency.",
  "Input timing ends at receipt of a frame verified to contain that click's visual marker. Client image decode/presentation is not measured.",
  `Only ${startupCount} fresh-profile startup observation(s); not a production cold-start percentile or a cleared OS disk cache.`,
  "Native desktop requires a dedicated Linux Xvfb display, ffmpeg capture and xdotool; not available in this macOS run.",
];
const report = { label, timestamp: new Date().toISOString(), node: process.version, platform: process.platform, realChrome: true, chrome: config.chromeBin, settings: { qualityControl: config.viewerControlQuality, qualityWatch: config.viewerWatchQuality, maxEncodedWidth: config.viewerMaxEncodedWidth }, startupProgressMs: [] as number[], inputProgressMs: [] as number[], results, gaps };
function checkpoint() { writeFileSync(`${target}.tmp`, JSON.stringify(report, null, 2) + "\n"); renameSync(`${target}.tmp`, target); }
function record(name: string, rawMs: number[], metadata: Record<string, unknown> = {}) {
  const sorted = [...rawMs].sort((a, b) => a - b);
  const row = { name, n: rawMs.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], rawMs, ...metadata };
  results.push(row); checkpoint(); process.stderr.write(`${name}: ${row.p50Ms.toFixed(2)} / ${row.p95Ms.toFixed(2)} ms (n=${row.n})\n`);
}
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Tallylamp performance fixture</title><style>body{margin:0;background:#eee;font:18px system-ui}canvas{position:fixed;left:0;top:0;width:256px;height:48px}button{position:absolute;left:20px;top:80px;width:180px;height:50px}p{margin:160px 20px 20px}#number{font-size:50px}</style></head><body><canvas id="marker" width="256" height="48"></canvas><button id="advance">Advance frame</button><p>Isolated audit fixture. <span id="number">0</span></p><script>
window.counter=0;
window.paintMarker=()=>{const c=document.getElementById('marker').getContext('2d');for(let i=0;i<8;i++){c.fillStyle=(window.counter&(1<<i))?'#000':'#fff';c.fillRect(i*32,0,32,48)}document.getElementById('number').textContent=window.counter};
document.getElementById('advance').onclick=()=>{window.counter++;window.paintMarker()};window.paintMarker();
window.decodeMarker=async encoded=>{const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes]));const c=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d');c.drawImage(bitmap,0,0);const scale=bitmap.width/innerWidth;let value=0;for(let i=0;i<8;i++){const pixel=c.getImageData(Math.round((i*32+16)*scale),Math.round(24*scale),1,1).data;if(pixel[0]<128)value|=1<<i}bitmap.close();return value};
</script></body></html>`;

const ctx = await startTestServer();
process.env.TALLYLAMP_FAKE_CHROME = "0";
// This one fixture is intentionally reachable through the browser's real egress proxy.
process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = "1";
ctx.browsers.workers.stopPolling();
ctx.app.get("/performance-fixture", (_req, res) => res.type("html").send(html));
let cdp: CdpClient | undefined;
let viewer: WebSocket | undefined;
let pageSession = "";
let id = "";
const request = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${ctx.url}${route}`, { method, headers: { Cookie: ctx.cookie, Origin: ctx.url, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `${route}: ${response.status} ${!response.ok ? await response.text() : ""}`);
  return response;
};
const evaluate = async (expression: string) => {
  const response = await cdp!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, pageSession) as { result: { value?: any }; exceptionDetails?: unknown };
  assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
try {
  const startup = report.startupProgressMs;
  const stops: number[] = [];
  for (let i = 0; i < startupCount; i++) {
    const row = (await ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard", name: `Managed benchmark ${i}` }));
    id = row.id;
    const start = performance.now();
    const response = await request(`/api/v1/browsers/${id}/start`, {});
    const body = await response.json() as { browser: { status: string; chromeVersion: string } };
    assert.equal(body.browser.status, "running");
    startup.push(performance.now() - start);
    if (i < startupCount - 1) {
      const stop = performance.now();
      await (await request(`/api/v1/browsers/${id}/stop`, {})).arrayBuffer();
      stops.push(performance.now() - stop);
    }
    checkpoint();
  }
  record("fresh-profile start to API running", startup);
  if (stops.length) record("real Chrome stop HTTP round trip", stops);
  const runtime = ctx.browsers.runtime(id)!;
  cdp = new CdpClient(await browserWsUrl(runtime.cdpUrl), Number(process.env.BENCH_CDP_TIMEOUT_MS ?? 8_000));
  await cdp.connect();
  const targets = await cdp.send("Target.getTargets") as { targetInfos: Array<{ targetId: string; type: string }> };
  const page = targets.targetInfos.find(t => t.type === "page")!;
  ({ sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }) as { sessionId: string });
  await cdp.send("Page.enable", {}, pageSession);
  const navigationStart = performance.now();
  if (fixtureMode === "inject") {
    gaps.push("Fixture injected with Page.setDocumentContent: bypasses the egress proxy/navigation path, whose separate measured attempts timed out.");
    const tree = await cdp.send("Page.getFrameTree", {}, pageSession) as { frameTree: { frame: { id: string } } };
    await cdp.send("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html }, pageSession);
  } else {
    await cdp.send("Page.navigate", { url: `${ctx.url}/performance-fixture` }, pageSession);
  }
  const deadline = Date.now() + 15_000;
  while (await evaluate("typeof window.decodeMarker !== 'function'")) { assert.ok(Date.now() < deadline, "fixture did not load"); await sleep(25); }
  record(`fixture ${fixtureMode === "inject" ? "injection" : "navigation"} to ready`, [performance.now() - navigationStart]);
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }, pageSession) as { data: string };
  writeFileSync(path.join(directory, `managed-${label}-fixture.png`), Buffer.from(screenshot.data, "base64"));

  const thumbnails: number[] = []; const bytes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const data = await (await request(`/api/v1/browsers/${id}/thumbnail`)).arrayBuffer();
    thumbnails.push(performance.now() - start); bytes.push(data.byteLength);
  }
  record("real Chrome thumbnail HTTP round trip", thumbnails, { bytes });

  const acquired = await (await request(`/api/v1/browsers/${id}/control`, {})).json() as { control: { leaseToken: string } };
  const ticket = await (await request(`/api/v1/browsers/${id}/viewer-ticket`, { mode: "control" })).json() as { ticket: string };
  const connectStart = performance.now();
  viewer = new WebSocket(`${ctx.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket.ticket}`);
  let firstFrameAt = 0;
  let resolveFirst!: () => void;
  const firstFrame = new Promise<void>(resolve => { resolveFirst = resolve; });
  let waiting: { code: number; start: number; resolve: (sample: { elapsed: number; bytes: number }) => void; reject: (error: Error) => void } | undefined;
  let decoding = false;
  const frames: Array<{ data: Buffer; at: number }> = [];
  const decode = async () => {
    if (decoding) return;
    decoding = true;
    try {
      while (frames.length && waiting) {
        const frame = frames.shift()!;
        const code = await evaluate(`window.decodeMarker(${JSON.stringify(frame.data.toString("base64"))})`);
        if (waiting && code === waiting.code) {
          const current = waiting; waiting = undefined;
          current.resolve({ elapsed: frame.at - current.start, bytes: frame.data.byteLength });
        }
      }
      frames.length = 0;
    } catch (error) { const current = waiting; waiting = undefined; current?.reject(error as Error); }
    finally { decoding = false; }
  };
  viewer.on("message", (raw, binary) => {
    if (!binary) return;
    if (!firstFrameAt) { firstFrameAt = performance.now(); resolveFirst(); }
    if (waiting) {
      frames.push({ data: Buffer.from(raw as Buffer), at: performance.now() });
      if (frames.length > 3) frames.shift();
      void decode();
    }
  });
  await new Promise<void>((resolve, reject) => { viewer!.once("open", resolve); viewer!.once("error", reject); });
  viewer.send(JSON.stringify({ type: "heartbeat", leaseToken: acquired.control.leaseToken }));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("viewer produced no first frame")), 15_000);
    firstFrame.then(() => { clearTimeout(timeout); resolve(); }, reject);
  });
  record("viewer connect to first frame receipt", [firstFrameAt - connectStart]);
  const point = await evaluate("(() => {const r=document.getElementById('advance').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const clicks = report.inputProgressMs; const frameBytes: number[] = [];
  for (let i = 1; i <= 20; i++) {
    const sample = await new Promise<{ elapsed: number; bytes: number }>((resolve, reject) => {
      const timeout = setTimeout(() => { waiting = undefined; reject(new Error(`no frame showing input ${i}`)); }, 8000);
      waiting = { code: i, start: performance.now(), resolve: r => { clearTimeout(timeout); resolve(r); }, reject: e => { clearTimeout(timeout); reject(e); } };
      viewer!.send(JSON.stringify({ type: "mouse", event: "mousePressed", ...point, button: "left" }));
      viewer!.send(JSON.stringify({ type: "mouse", event: "mouseReleased", ...point, button: "left" }));
    });
    clicks.push(sample.elapsed); frameBytes.push(sample.bytes);
    assert.equal(await evaluate("window.counter"), i, "one user click must produce one action");
    checkpoint();
  }
  record("viewer click to matching frame receipt", clicks, { frameBytes, correlation: "8-bit black/white marker decoded from the actual streamed image, not an arbitrary next frame" });
} catch (error) {
  gaps.push(`Run stopped: ${(error as Error).message}`); checkpoint(); throw error;
} finally {
  viewer?.terminate();
  await cdp?.close();
  await ctx.close();
  checkpoint();
}
