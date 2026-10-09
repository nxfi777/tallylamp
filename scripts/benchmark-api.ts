/** Real HTTP + on-disk SQLite; Chrome is explicitly a stand-in, never a browser benchmark. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { startTestServer } from "../tests/helpers.js";
import { adminPrincipal, createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { getDb } from "../src/db.js";
import { resetRateLimits } from "../src/rate-limit.js";
import { fakeCdpCalls, resetFakeCdp } from "../src/fake-chrome.js";
import { LIFECYCLE_TOOLS } from "../src/mcp.js";

const label = process.argv[2] ?? "local";
const samples = Number(process.env.BENCH_SAMPLES ?? 20);
assert.ok(Number.isInteger(samples) && samples >= 20, "at least 20 samples are required");
const outDir = path.resolve("docs/audits/performance-2026-10-09");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `api-${label}.json`);
const results: Array<Record<string, unknown>> = [];
const gaps = [
  "Fake Chrome supplies CDP responses: browser launch/render/encoding/input-to-paint, native desktop and real MCP child startup are NOT measured.",
  "Worker network/placement/move, real extension pairing/transport, export of production-sized profiles, tunnels and OAuth provider interaction require external fixtures.",
  "Sequential localhost samples measure service overhead, not internet latency or throughput. Rate-limit buckets reset before each sample; authorization, CSRF and data validation still execute.",
];
const routes = ["api.ts", "server.ts", "guest-api.ts", "oauth.ts", "worker.ts"].flatMap(file => {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/\b(?:app|api|r)\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g)]
    .map(m => ({ source: file, method: m[1].toUpperCase(), route: m[2] }));
});
const report = {
  label, timestamp: new Date().toISOString(), node: process.version, platform: process.platform,
  arch: process.arch, cpu: os.cpus()[0]?.model, fakeChrome: true, samples,
  fixture: { seed: "deterministic fleet rows v1", profiles: "64 files × 16 KiB, 1 MiB total", sqlite: "temporary on-disk WAL; unchanged durability", warmup: 1 },
  routes, lifecycleTools: LIFECYCLE_TOOLS.map(t => t.name), results, gaps,
};
function checkpoint() {
  writeFileSync(`${out}.tmp`, JSON.stringify(report, null, 2) + "\n");
  renameSync(`${out}.tmp`, out);
}
const ctx = await startTestServer();
ctx.browsers.workers.stopPolling();
const p = adminPrincipal();
let sequence = 0;
type Reply = { status: number; body: any; headers: Headers; bytes: number };
async function request(route: string, method = "GET", body?: unknown, cookie = ctx.cookie, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${ctx.url}${route}`, {
    method, headers: { Cookie: cookie, Origin: ctx.url, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const data = Buffer.from(await response.arrayBuffer());
  const text = data.toString();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed)}`);
  return { status: response.status, body: parsed, headers: response.headers, bytes: data.byteLength };
}
async function bench(name: string, action: () => Promise<unknown> | unknown, meta: Record<string, unknown> = {}) {
  const rawMs: number[] = [];
  let peakRss = process.memoryUsage().rss;
  let coldMs = 0;
  for (let i = -1; i < samples; i++) {
    resetRateLimits();
    const start = performance.now();
    await action();
    const elapsed = performance.now() - start;
    if (i < 0) coldMs = elapsed;
    else rawMs.push(elapsed);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const sorted = [...rawMs].sort((a, b) => a - b);
  const result = { name, ...meta, n: samples, coldMs, p50Ms: sorted[Math.ceil(samples * .5) - 1], p95Ms: sorted[Math.ceil(samples * .95) - 1], maxMs: sorted.at(-1), peakRssMiB: peakRss / 1024 ** 2, rawMs };
  results.push(result); checkpoint();
  process.stderr.write(`${name}: p50=${result.p50Ms.toFixed(2)} p95=${result.p95Ms.toFixed(2)} ms\n`);
}
let fixture = (await ctx.browsers.create({ principal: p, via: "dashboard", name: "Performance fixture" }));
const base = `/api/v1/browsers/${fixture.id}`;
try {
  if (process.env.BENCH_PHASE === "runtime") {
    report.gaps.splice(1, 1, "Real local worker HTTP, archives, uploads and move are measured with fake Chrome; Linux X11 execution and wide-area network/production-sized profiles remain unmeasured.");
    const { runtime } = await import("./benchmark-api-runtime.js");
    Object.assign(report, await runtime(ctx, bench, request, fixture));
  } else if (process.env.BENCH_PHASE === "extra") {
    const { extra } = await import("./benchmark-api-extra.js");
    await extra(ctx, bench, request, fixture);
  } else {
  for (const route of ["/healthz", "/api/v1/me", "/api/v1/status", "/api/v1/browsers", base, "/api/v1/agents", "/api/v1/seeds", "/api/v1/workers", "/api/v1/requests", "/api/v1/audit", "/api/v1/openapi.json", "/.well-known/oauth-protected-resource"]) {
    await bench(`GET ${route.replace(fixture.id, ":id")}`, () => request(route), { fleet: 1 });
  }
  await bench("login + logout", async () => {
    const login = await request("/api/v1/login", "POST", { secret: ctx.adminSecret }, "");
    await request("/api/v1/logout", "POST", {}, login.headers.get("set-cookie")!.split(";")[0]);
  });
  await bench("browser.rename", () => request(base, "PATCH", { name: `Renamed ${++sequence}` }));
  await bench("browser.metadata", () => request(base, "PATCH", { metadata: { purpose: `Task ${++sequence}` } }));
  await bench("browser.pinned", () => request(`${base}/pinned`, "PUT", { pinned: ++sequence % 2 === 0 }));
  await bench("browser.lendable", () => request(`${base}/lendable`, "POST", { lendable: ++sequence % 2 === 0 }));
  await bench("browser.proxy", () => request(base, "PATCH", { proxy: null }));
  await bench("browser.site report + remove", async () => {
    const site = await request(`${base}/sites`, "POST", { origin: "https://example.com", name: "Fixture", state: "confirmed" });
    await request(`${base}/sites/${site.body.site.id}`, "DELETE");
  });
  await bench("browser.create stopped + delete", async () => {
    const created = await request("/api/v1/browsers", "POST", { name: `Transient ${++sequence}`, start: false });
    await request(`/api/v1/browsers/${created.body.browser.id}`, "DELETE");
  });
  await bench("browser.start + stop (fake Chrome)", async () => {
    await request(`${base}/start`, "POST", {});
    await request(`${base}/stop`, "POST", {});
  });
  await request(`${base}/start`, "POST", {});
  await bench("browser.restart (fake Chrome)", () => request(`${base}/restart`, "POST", {}));
  await bench("browser.take control + heartbeat + release", async () => {
    const acquired = await request(`${base}/control`, "POST", {});
    await request(`${base}/control/heartbeat`, "POST", { leaseToken: acquired.body.control.leaseToken });
    await request(`${base}/control`, "DELETE");
  });
  await bench("browser.viewer ticket", () => request(`${base}/viewer-ticket`, "POST", { mode: "watch" }));
  await bench("browser.thumbnail (fake JPEG)", () => request(`${base}/thumbnail`));
  resetFakeCdp();
  await bench("browser.thumbnail 8 simultaneous (fake JPEG)", () => Promise.all(Array.from({ length: 8 }, () => request(`${base}/thumbnail`))), { concurrency: 8 });
  results.at(-1)!.captureCalls = fakeCdpCalls.filter(c => c.method === "Page.captureScreenshot").length;
  await bench("browser.refreshPageInfo 8 simultaneous", () => Promise.all(Array.from({ length: 8 }, () => ctx.browsers.refreshPageInfo(fixture.id))), { concurrency: 8 });
  await bench("browser.guest create + revoke", async () => {
    const created = await request(`${base}/guests`, "POST", { label: "Fixture", modes: ["watch"], expiresInSec: 600 });
    await request(`${base}/guests/${created.body.guest.id}`, "DELETE");
  });
  await bench("browser.guests list", () => request(`${base}/guests`));
  const agent = await request("/api/v1/agents", "POST", { name: "Benchmark agent" });
  await bench("agent.update", () => request(`/api/v1/agents/${agent.body.agent.id}`, "PATCH", { name: `Agent ${++sequence}` }));
  await bench("agent.rotate", () => request(`/api/v1/agents/${agent.body.agent.id}/rotate`, "POST", {}));
  await request(`${base}/stop`, "POST", {});

  // Known profile payload: never read or export the operator's real browser profiles.
  for (let i = 0; i < 64; i++) writeFileSync(path.join(fixture.profile_path, `fixture-${i}`), Buffer.alloc(16 * 1024, i));
  const saved = await request("/api/v1/seeds", "POST", { browserId: fixture.id, name: "Fixture profile" });
  const seed = saved.body.seed.id;
  await bench("profile.update 1 MiB", () => request(`/api/v1/seeds/${seed}`, "PUT", { browserId: fixture.id, name: "Fixture profile" }));
  await bench("profile.clone 1 MiB + delete", async () => {
    const created = await request("/api/v1/browsers", "POST", { name: `Clone ${++sequence}`, seedId: seed, start: false });
    await request(`/api/v1/browsers/${created.body.browser.id}`, "DELETE");
  });
  await bench("profile.site report + remove", async () => {
    await request(`/api/v1/seeds/${seed}/sites`, "POST", { origin: "https://example.com", name: "Fixture" });
    await request(`/api/v1/seeds/${seed}/sites`, "DELETE", { origin: "https://example.com" });
  });

  // MCP lifecycle calls exercise the real protocol, auth, routing and persistence; no child process.
  let rpcId = 0;
  const mcpAgent = createAgent({ name: "Benchmark MCP", scopes: [...DEFAULT_AGENT_SCOPES, "seed:use"] });
  const rpcHeaders: Record<string, string> = { Authorization: `Bearer ${mcpAgent.token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
  const init = await request("/mcp", "POST", { jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "benchmark", version: "1" } } }, "", rpcHeaders);
  rpcHeaders["MCP-Session-Id"] = init.headers.get("mcp-session-id")!;
  for (const name of ["tallylamp_list_browsers", "tallylamp_list_requests", "tallylamp_list_profile_templates"]) {
    await bench(`MCP ${name}`, async () => {
      const r = await request("/mcp", "POST", { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: {} } }, "", rpcHeaders);
      const rpc = typeof r.body === "string" ? JSON.parse(r.body.split("\n").find((line: string) => line.startsWith("data:"))!.slice(5)) : r.body;
      assert.ok(!rpc.error && !rpc.result?.isError, JSON.stringify(rpc));
    });
  }

  // Expand only metadata rows, not Chrome processes or disk profiles. Half belong to each agent.
  const db = getDb();
  const row = ctx.browsers.row(fixture.id);
  const columns = Object.keys(row);
  const insert = db.prepare(`INSERT INTO browsers(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  for (const size of [1, 50, 200]) {
    const count = ctx.browsers.list().length;
    db.exec("BEGIN");
    for (let i = count; i < size; i++) {
      const next = { ...row, id: `bench-${i}`, name: `Fixture ${i}`, slug: `bench-${i}`, seed_id: i % 2 ? seed : null, owner_type: "agent", owner_id: agent.body.agent.id, profile_path: path.join(ctx.dataDir, "profiles", `bench-${i}`) };
      insert.run(...columns.map(column => next[column as keyof typeof next]));
    }
    db.exec("COMMIT");
    await bench(`fleet.${size}.publicView`, () => ctx.browsers.list().map(r => ctx.browsers.publicView(r)), { fleet: size, transport: "direct JS" });
    await bench(`fleet.${size}.GET browsers`, () => request("/api/v1/browsers"), { fleet: size });
    await bench(`fleet.${size}.GET agents`, () => request("/api/v1/agents"), { fleet: size });
  }
  }
} catch (error) {
  gaps.push(`Run stopped: ${(error as Error).message}`); checkpoint(); throw error;
} finally {
  await ctx.close();
  checkpoint();
}
