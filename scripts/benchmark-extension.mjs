import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { extensionFrameIn, extensionUrl, guard, onServer, siteOf, withinSite } from '../extension/guard.js';
import { normalizeServer } from '../extension/address.js';

// Deliberately no browser or real extension API: isolate worker orchestration, with explicit
// 5ms simulated Chrome API completion. Do not present these as observed Chrome action latencies.
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const label = process.argv[2] ?? 'local';
const samples = 20;
const results = [];
const dir = new URL('../docs/audits/performance-2026-10-09/', import.meta.url);
mkdirSync(dir, { recursive: true });
const output = new URL(`extension-${label}.json`, dir);
const save = () => {
  const tmp = new URL(`extension-${label}.json.tmp`, dir);
  writeFileSync(tmp, JSON.stringify({ label, timestamp: new Date().toISOString(), node: process.version, samples, mode: 'shipped worker in VM; simulated 5ms Chrome API round trip; not end-to-end browser latency', results }, null, 2) + '\n');
  renameSync(tmp, output);
};
async function worker(tabCount = 16) {
  const listeners = {};
  const counters = { sessionWrites: 0, badgeCalls: 0, broadcasts: 0, detachCalls: 0, detachPeak: 0, getTargets: 0 };
  let detaching = 0;
  const event = name => ({ addListener: cb => { listeners[name] = cb; } });
  let timerId = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    static latest;
    readyState = 0;
    constructor() { Socket.latest = this; }
    send() {}
    close() { this.readyState = 3; }
    welcome() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ event: 'welcome' }) }); }
  }
  const tab = id => ({ id, windowId: 1, url: `https://example.test/${id}`, title: `Tab ${id}` });
  const chrome = {
    action: { setBadgeText() { counters.badgeCalls++; }, setBadgeBackgroundColor() { counters.badgeCalls++; }, setTitle() { counters.badgeCalls++; }, async setPopup() {} },
    storage: {
      local: { async get() { return { conn: { server: 'https://tallylamp.example', token: 'fixture', browserId: 'fixture', browserName: 'Fixture' } }; }, async set() {}, async remove() {} },
      session: { async get() { return { shared: Array.from({ length: tabCount }, (_, i) => ({ tabId: i + 1, sites: null, byAgent: false })) }; }, async set() { counters.sessionWrites++; } },
    },
    runtime: { id: 'fixture-extension', async sendMessage() { counters.broadcasts++; }, onMessage: event('message'), onStartup: event('startup') },
    debugger: {
      async sendCommand({ tabId }, method) { await delay(5); if (method === 'Target.getTargetInfo') { counters.getTargets++; return { targetInfo: { targetId: `target-${tabId}`, ...tab(tabId) } }; } return {}; },
      async attach() { await delay(5); },
      async detach() { counters.detachCalls++; counters.detachPeak = Math.max(counters.detachPeak, ++detaching); await delay(5); detaching--; },
      onEvent: event('debugger'), onDetach: event('detach'),
    },
    tabs: { async get(id) { await delay(5); return tab(id); }, async ungroup() {}, onRemoved: event('removed'), onUpdated: event('updated') },
    alarms: { create() {}, onAlarm: event('alarm') }, sidePanel: { async setPanelBehavior() {} },
  };
  const context = vm.createContext({ chrome, navigator: { userAgent: 'Chrome/140' }, WebSocket: Socket, URL, Date, Promise,
    setTimeout: () => ++timerId, setInterval: () => ++timerId, clearTimeout() {}, clearInterval() {},
    extensionFrameIn, extensionUrl, guard, onServer, siteOf, withinSite, normalizeServer,
  });
  vm.runInContext(`${source}\n;globalThis.fixture = {ready, actions, shared, snapshot};`, context);
  const fixture = context.fixture;
  await fixture.ready;
  Socket.latest.welcome();
  const action = (type, extra = {}) => new Promise((resolve, reject) => {
    listeners.message({ type, ...extra }, {}, r => r.ok ? resolve(r.state) : reject(new Error(r.error)));
  });
  return { counters, fixture, action, listeners, tab, reset: () => Object.keys(counters).forEach(k => counters[k] = 0) };
}
async function measure(name, setup, action) {
  const rawMs = []; const operations = [];
  for (let i = 0; i < samples; i++) {
    const fixture = await setup();
    fixture?.reset();
    const start = performance.now();
    const result = await action(fixture);
    rawMs.push(performance.now() - start);
    operations.push({ ...(fixture?.counters ?? result?.counters ?? {}) });
  }
  const sorted = [...rawMs].sort((a, b) => a - b);
  const result = { name, n: samples, p50Ms: sorted[9], p95Ms: sorted[18], rawMs, operations };
  results.push(result); save();
  process.stdout.write(`${name}: ${result.p50Ms.toFixed(2)} / ${result.p95Ms.toFixed(2)} ms; ${JSON.stringify(operations.at(-1))}\n`);
}
await measure('restore16 shared tabs', async () => null, () => worker());
await measure('getState', () => worker(1), ext => ext.action('getState'));
await measure('share tab + unshare', () => worker(1), async ext => {
  const s = await ext.action('shareTab', { tabId: 99, site: 'example.test' });
  assert.ok(s.shared.some(t => t.tabId === 99));
  await ext.action('unshareTab', { tabId: 99 });
});
await measure('stopAll16 shared tabs', () => worker(), async ext => { const s = await ext.action('stopAll'); assert.equal(s.shared.length, 0); });
await measure('100 title updates,16 shared tabs', () => worker(), async ext => {
  for (let i = 0; i < 100; i++) ext.listeners.updated(1, { title: `Title ${i}` }, { ...ext.tab(1), title: `Title ${i}` });
  await Promise.resolve();
  assert.equal(ext.fixture.snapshot().shared.find(t => t.tabId === 1).title, 'Title 99');
});
