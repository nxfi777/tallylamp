/** Remaining HTTP surfaces: real local worker transport/filesystem, explicitly fake Chrome. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import WebSocket from "ws";
import type { TestCtx } from "../tests/helpers.js";
import type { BrowserRow } from "../src/browsers.js";
import { adminPrincipal } from "../src/auth.js";
import { allocatePort } from "../src/chrome.js";
import { startWorker } from "../src/worker.js";
import { hub } from "../src/events.js";
import { bridgeFilesDir } from "../src/bridge-files.js";

type Bench = (name: string, action: () => Promise<unknown> | unknown, meta?: Record<string, unknown>) => Promise<void>;
type Request = (route: string, method?: string, body?: unknown, cookie?: string, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers; bytes: number }>;

export async function runtime(ctx: TestCtx, bench: Bench, request: Request, fixture: BrowserRow) {
  const paths = (...coveredRoutes: string[]) => ({ coveredRoutes, comparison: "after only; no before-change measurement" });
  const blockedRoutes = [{ source: "worker.ts", method: "POST", route: "/worker/v1/browsers/:id/x11",
    reason: "Successful execution requires a service-owned Linux Xvfb display and ffmpeg/xdotool. This macOS worker's fake Chrome has no Xvfb; a 409 refusal is not counted as native runtime performance." }];
  await bench("guest HTML HTTP download", async () => {
    const response = await request("/guest", "GET", undefined, "");
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(response.body, /<title>/);
  }, paths("GET /guest"));

  let sequence = 0;
  await bench("SSE connect + matching event receipt + close", async () => {
    const abort = new AbortController();
    const response = await fetch(`${ctx.url}/api/v1/events`, { headers: { Cookie: ctx.cookie }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const token = `runtime-benchmark-${++sequence}`;
    try {
      hub.emitEvent("benchmark.fixture", { token }, fixture.id);
      let received = "";
      while (!received.includes(token)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "SSE closed before the matching event arrived");
        received += Buffer.from(chunk.value!).toString();
      }
    } finally { await reader.cancel(); abort.abort(); }
  }, { ...paths("GET /api/v1/events"), endpoint: "connect-through-event-receipt; not browser repaint latency" });

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "tallylamp-runtime-benchmark-"));
  const port = await allocatePort();
  const url = `http://127.0.0.1:${port}`;
  const worker = await startWorker({ dataDir, host: "127.0.0.1", port, selfUrl: url, name: "Isolated benchmark worker", join: ctx.browsers.workers.createJoinToken(adminPrincipal()).token });
  const auth = { Authorization: `Bearer ${worker.identity.secret}` };
  const workerId = worker.identity.workerId;
  let bridge: WebSocket | undefined;
  let browserId: string | undefined;
  const routeSamples = new Map<string, number[]>();
  async function workerRequest(route: string, method = "GET", body?: Buffer | object) {
    const started = performance.now();
    const response = await fetch(`${url}${route}`, { method, headers: { ...auth, ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}) },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const data = Buffer.from(await response.arrayBuffer());
    const elapsed = performance.now() - started;
    const key = `${method} ${route.split("?")[0].replace(/[a-f0-9]{32}/g, ":id").replace(/[a-f0-9]{16}/g, ":id").replace(/\/uploads\/[a-f0-9]{12}\/[^/]+$/, "/uploads/:dir/:name")}`;
    const samples = routeSamples.get(key) ?? []; samples.push(elapsed); routeSamples.set(key, samples);
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${data.toString().slice(0, 250)}`);
    return { response, data, json: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(data.toString()) : undefined };
  }
  try {
    await ctx.browsers.workers.poll();
    await bench("worker health HTTP", async () => assert.equal((await workerRequest("/healthz")).json.role, "worker"), { ...paths("GET /healthz"), routeSource: "worker.ts" });
    await bench("worker state HTTP", async () => assert.ok(Array.isArray((await workerRequest("/worker/v1/state")).json.browsers)), paths("GET /worker/v1/state"));
    const row = await ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard", name: "Worker runtime fixture", workerId });
    browserId = row.id;
    const base = `/worker/v1/browsers/${row.id}`;
    const payload = Buffer.alloc(1024 * 1024);
    let seed = 0x7a11babe;
    for (let i = 0; i < payload.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; payload[i] = seed & 255; }
    const profile = path.join(dataDir, "profiles", row.id);
    mkdirSync(profile, { recursive: true });
    for (let i = 0; i < 64; i++) writeFileSync(path.join(profile, `fixture-${i}`), payload.subarray(i * 16384, (i + 1) * 16384));

    await bench("worker start + stop HTTP (fake Chrome)", async () => {
      assert.ok((await workerRequest(`${base}/start`, "POST", {})).json.screen.width > 0);
      assert.equal((await workerRequest(`${base}/stop`, "POST", {})).json.stopped, true);
    }, paths("POST /worker/v1/browsers/:id/start", "POST /worker/v1/browsers/:id/stop"));

    await workerRequest(`${base}/start`, "POST", {});
    await bench("worker CDP HTTP proxy (fake Chrome version)", async () => {
      assert.ok((await workerRequest(`${base}/cdp/json/version`)).json.webSocketDebuggerUrl);
    }, paths("ALL /worker/v1/browsers/:id/cdp/*"));
    await bench("worker upload 64 KiB HTTP + byte verification", async () => {
      const uploaded = await workerRequest(`${base}/uploads/0123456789ab/fixture.bin`, "PUT", payload.subarray(0, 65536));
      assert.deepEqual(readFileSync(uploaded.json.path), payload.subarray(0, 65536));
    }, { ...paths("PUT /worker/v1/browsers/:id/uploads/:dir/:name"), bytes: 65536 });
    await workerRequest(`${base}/stop`, "POST", {});

    let archive = Buffer.alloc(0);
    await bench("worker profile tar download 1 MiB / 64 files", async () => {
      const result = await workerRequest(`${base}/profile`);
      assert.equal(result.response.headers.get("content-type"), "application/x-tar");
      assert.ok(result.data.length > payload.length);
      archive = result.data;
    }, { ...paths("GET /worker/v1/browsers/:id/profile"), payloadBytes: payload.length, files: 64 });
    await bench("worker profile tar restore 1 MiB / 64 files", async () => {
      assert.equal((await workerRequest(`${base}/profile`, "PUT", archive)).json.received, true);
      assert.deepEqual(readFileSync(path.join(profile, "fixture-63")), payload.subarray(63 * 16384));
    }, { ...paths("PUT /worker/v1/browsers/:id/profile"), payloadBytes: payload.length, files: 64 });
    await bench("worker export gzip 1 MiB / 64 files", async () => {
      const result = await workerRequest(`${base}/export`);
      assert.equal(result.response.headers.get("content-type"), "application/gzip");
      assert.equal(result.response.headers.get("x-tallylamp-profile-present"), "true");
      assert.deepEqual(result.data.subarray(0, 2), Buffer.from([0x1f, 0x8b]));
      assert.ok(result.data.length > 1024 * 1024, "deterministic pseudorandom payload should not collapse into a tiny archive");
      // The sender releases its export reservation after the response drains.
      await setImmediate();
    }, { ...paths("GET /worker/v1/browsers/:id/export"), payloadBytes: payload.length, files: 64 });

    // Start where the fixture currently lives, then move the same authenticated bytes
    // in both directions using the real control-plane/worker tar transport.
    await ctx.browsers.ensureRunning(row.id);
    await bench("browser move worker to main + back, running fake Chrome, 1 MiB", async () => {
      const moved = await request(`/api/v1/browsers/${row.id}/move`, "POST", { workerId: null });
      assert.equal(moved.body.restarted, true);
      assert.deepEqual(readFileSync(path.join(ctx.browsers.row(row.id).profile_path, "fixture-63")), payload.subarray(63 * 16384));
      const returned = await request(`/api/v1/browsers/${row.id}/move`, "POST", { workerId });
      assert.equal(returned.body.restarted, true);
      assert.deepEqual(readFileSync(path.join(profile, "fixture-63")), payload.subarray(63 * 16384));
    }, { ...paths("POST /api/v1/browsers/:id/move"), payloadBytes: payload.length, files: 64 });
    await ctx.browsers.stop(row.id);
    await bench("worker profile restore + delete, 1 MiB / 64 files", async () => {
      await workerRequest(`${base}/profile`, "PUT", archive);
      assert.equal((await workerRequest(base, "DELETE")).json.deleted, true);
    }, { ...paths("DELETE /worker/v1/browsers/:id"), payloadBytes: payload.length, files: 64 });
    await ctx.browsers.destroy(row.id, adminPrincipal());
    browserId = undefined;

    // This endpoint requires a live bridge membership, so use the installed bounded
    // MCP child solely to own its artifact directory. It never connects to Chrome.
    if (process.platform === "darwin") {
      process.stderr.write(`Before single bridge child: ${execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" }).trim()}\n`);
      process.stderr.write(execFileSync("vm_stat", { encoding: "utf8" }).split("\n").slice(0, 5).join("\n") + "\n");
    }
    const bridgeId = randomBytes(16).toString("hex");
    const ready = new Promise<void>((resolve, reject) => {
      bridge = new WebSocket(`${url.replace("http", "ws")}/worker/v1/linked-bridges/${bridgeId}/mcp`, { headers: auth, handshakeTimeout: 10_000 });
      const timer = setTimeout(() => reject(new Error("bridge ready timeout")), 15_000);
      bridge.once("error", error => { clearTimeout(timer); reject(error); });
      bridge.on("message", (raw, binary) => {
        if (binary) return;
        const message = JSON.parse(String(raw));
        if (message.type === "linked-bridge-ready") { clearTimeout(timer); resolve(); }
        if (message.type === "linked-bridge-error") { clearTimeout(timer); reject(new Error(message.message)); }
      });
    });
    await ready;
    const artifact = path.join(bridgeFilesDir(bridgeId), "fixture.bin");
    writeFileSync(artifact, payload);
    await bench("worker linked bridge artifact GET 1 MiB", async () => {
      const result = await workerRequest(`/worker/v1/linked-bridges/${bridgeId}/files?path=fixture.bin`);
      assert.deepEqual(result.data, payload);
      assert.equal(result.response.headers.get("x-tallylamp-extension"), ".bin");
    }, { ...paths("GET /worker/v1/linked-bridges/:id/files"), bytes: payload.length, bridge: "installed MCP child for active membership only; no browser connection" });
  } finally {
    bridge?.terminate();
    if (browserId) await ctx.browsers.destroy(browserId, adminPrincipal());
    await worker.close();
    ctx.browsers.workers.remove(workerId, adminPrincipal());
    rmSync(dataDir, { recursive: true, force: true });
  }
  const workerRouteTimings = [...routeSamples].map(([route, rawMs]) => {
    const sorted = [...rawMs].sort((a,b) => a-b);
    return { route, n: rawMs.length, p50Ms: sorted[Math.ceil(sorted.length*.5)-1], p95Ms: sorted[Math.ceil(sorted.length*.95)-1], rawMs,
      note: "All explicit successful worker requests, including first observations and setup; move's internal worker requests are excluded." };
  });
  return { blockedRoutes, workerRouteTimings };
}
