import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
function fn(name: string) {
  const marker = source.indexOf(`function ${name}(`);
  const start = source.slice(marker - 6, marker) === "async " ? marker - 6 : marker;
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const names = ["status", "browsers", "agents", "seeds", "requests", "workers"];
function state() {
  return { me: { type: "admin" }, browsers: [], agents: [], requests: [], status: null,
    data: Object.fromEntries(names.map(name => [name, { loading: false, error: "", loadedAt: null }])) } as any;
}
function node(tag: string, attrs = {}, ...children: any[]) {
  return { tag, attrs, children, append(...kids: any[]) { this.children.push(...kids); } };
}
function text(node: any): string { return typeof node === "string" ? node : node?.children?.map(text).join("") || ""; }
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(yes => { resolve = yes; });
  return { promise, resolve };
}
function loaders(current: any, api: any, extra = {}) {
  const code = source.slice(source.indexOf("const DATA_PATHS ="), source.indexOf("let busyTimer ="));
  return runInNewContext(`${code}; ({loadDataset,refresh,dataNotice})`, { state: current, api, h: node,
    flash: () => {}, ...extra });
}

test("failed datasets preserve known rows and report their age; cold failures never become empty data", async () => {
  const current = state();
  current.workers = [{ id: "known" }];
  current.data.workers.loadedAt = "2026-10-07T10:00:00Z";
  const loaded = loaders(current, async () => { throw new Error("upstream unavailable"); });
  await loaded.loadDataset("workers");
  assert.equal(current.workers[0].id, "known");
  assert.match(text(loaded.dataNotice("workers", "workers")), /last successful update/);
  await loaded.loadDataset("requests");
  assert.equal(current.data.requests.loadedAt, null);
  assert.match(text(loaded.dataNotice("requests", "access requests")), /Could not refresh access requests/);
});

test("authentication and useful datasets render while an unrelated request remains pending", async () => {
  const current = state(), workers = deferred(), seen: string[] = [];
  const loaded = loaders(current, (path: string) => path.endsWith("/me") ? Promise.resolve({ principal: { type: "admin" } })
    : path.endsWith("/workers") ? workers.promise : Promise.resolve({ [path.split("/").at(-1)!]: [] }));
  const refresh = loaded.refresh({ onAuthenticated: () => seen.push("authenticated"), onData: (name: string) => seen.push(name) });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(seen.includes("authenticated"));
  assert.ok(seen.includes("browsers"));
  assert.equal(seen.includes("workers"), false);
  workers.resolve({ workers: [] });
  assert.equal(await refresh, true);
});

test("concurrent dataset loads share a request and a successful retry clears its error", async () => {
  const current = state(), request = deferred();
  current.data.workers.error = "previous error";
  let calls = 0;
  const loaded = loaders(current, () => { calls++; return request.promise; });
  const first = loaded.loadDataset("workers"), second = loaded.loadDataset("workers");
  assert.equal(calls, 1);
  request.resolve({ workers: [] });
  await Promise.all([first, second]);
  assert.equal(current.data.workers.error, "");
  assert.ok(current.data.workers.loadedAt);
});

test("a failed authentication read only signs out after an authentication rejection", async () => {
  const current = state();
  assert.equal(await loaders(current, async () => { throw new Error("connection lost"); }).refresh(), null);
  assert.equal(current.me.type, "admin");
  assert.equal(await loaders(current, async () => { throw Object.assign(new Error("expired"), { status: 401 }); }).refresh(), false);
  assert.equal(current.me, null);
});

test("capacity never reports zero while its fleet is unknown and uses server occupancy", () => {
  const current = state();
  current.status = { maxBrowsers: 8, occupiedSlots: 3 };
  current.data.status.loadedAt = "known";
  const code = source.slice(source.indexOf("const LOCAL_SLOT_STATES ="), source.indexOf("/**\n * The kernel refused"));
  const meter = runInNewContext(`${code}; fleetMeter`, { state: current, h: node });
  assert.match(text(meter()), /Loading local capacity/);
  current.data.browsers.loadedAt = "known";
  assert.match(text(meter()), /3 of 8 local slots/);
  current.data.browsers.error = "unavailable";
  assert.match(text(meter()), /Local capacity unavailable/);
});

test("GET requests time out and mutations receive no automatic timeout or retry", async () => {
  let callback: () => void = () => {}, timerCalls = 0, cleared = 0, calls = 0;
  const api = runInNewContext(`${fn("api")}; api`, { AbortController,
    setTimeout: (cb: () => void, ms: number) => { assert.equal(ms, 10000); callback = cb; timerCalls++; return 1; },
    clearTimeout: () => { cleared++; }, fetch: (_: string, opts: any) => {
      calls++;
      if (opts.signal) return new Promise((_, no) => opts.signal.addEventListener("abort", () => no(new Error("aborted"))));
      return Promise.resolve({ status: 204 });
    } });
  const read = api("/api/v1/workers");
  callback();
  await assert.rejects(read, /took too long/);
  assert.equal(cleared, 1);
  assert.equal(await api("/api/v1/browsers", { method: "POST", body: {} }), null);
  assert.equal(timerCalls, 1);
  assert.equal(calls, 2);
});

test("success feedback keeps its semantic type until a new navigation clears it", () => {
  const current = state();
  let renders = 0;
  const actions = runInNewContext(`${fn("flash")}\n${fn("go")}; ({flash,go})`, { state: current,
    document: { querySelector: () => null }, history: { pushState() {} }, render: () => { renders++; } });
  actions.flash("Saved", true);
  assert.equal(current.flash, "Saved");
  assert.equal(current.flashSuccess, true);
  actions.go("/agents", { preserveFlash: true });
  assert.equal(current.flash, "Saved");
  actions.go("/");
  assert.equal(current.flash, "");
  assert.equal(renders, 2);
});
