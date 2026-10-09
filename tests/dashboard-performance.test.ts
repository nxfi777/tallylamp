import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
const fn = (name: string) => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
test('a lifecycle action does one refresh and keeps its pending state until rendering finishes', async () => {
  let requests = 0, renders = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const call = runInNewContext(`const PENDING={start:'Starting…'};${fn('call')};call`, {
    act: (cb: () => Promise<void>) => cb(), api: async () => { requests++; },
    refresh: () => { throw new Error('redundant refresh'); },
    render: async () => { renders++; await pending; },
  });
  const button = { textContent: 'Start', isConnected: true, disabled: false };
  const task = call('/api/v1/browsers/example/start', button);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); assert.equal(renders, 1);
  assert.equal(button.disabled, true); assert.equal(button.textContent, 'Starting…');
  finish(); await task;
  assert.equal(button.disabled, false); assert.equal(button.textContent, 'Start');
});
test('parallel data completions share a paint and a stale frame cannot overwrite another route', async () => {
  const frames: Array<() => void> = [];
  let paintCount = 0, current = 'home';
  const noop = () => {};
  const render = runInNewContext(`let renderSeq=0,detailMetadataRefresh=null;const TITLES={};${fn('render')};render`, {
    document: {}, route: () => ({ name: current }), layout: noop, h: noop, busy: noop,
    teardownViewer: noop, closeMenu: noop, syncRequestBadges: noop, startEvents: noop,
    homeView: noop, loginView: noop, paintBrowsers: () => paintCount++,
    requestAnimationFrame: (cb: () => void) => { frames.push(cb); return frames.length; },
    refresh: async ({ onAuthenticated, onData }: any) => {
      onAuthenticated(); for (const name of ['browsers', 'agents', 'status', 'workers', 'seeds', 'requests']) onData(name);
      return true;
    },
  });
  await render(); assert.equal(frames.length, 1); frames[0](); assert.equal(paintCount, 1);
  await render(); current = 'login'; await render(); frames[1](); assert.equal(paintCount, 1);
});

test('live changes refresh immediately after idle, rate-limit bursts, and wait while hidden or a menu is open', async () => {
  let now = 0, nextId = 0, refreshes = 0, source: any;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners: Record<string, () => void> = {};
  const document = { hidden: false, addEventListener: (type: string, cb: () => void) => { listeners[type] = cb; },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  class EventSource { static CLOSED = 2; constructor() { source = this; } }
  const env = runInNewContext(`let eventsStarted=false,openMenu=null;${fn('startEvents')};({startEvents,setMenu:value=>{openMenu=value;}})`, {
    window: { EventSource }, EventSource, document, performance: { now: () => now },
    setInterval: () => {}, setTimeout: (callback: () => void, delay: number) => { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    refresh: async () => { refreshes++; }, route: () => ({ name: 'home' }), paintBrowsers: () => {},
  });
  const runDue = async () => {
    for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.callback(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  env.startEvents();
  const event = () => source.onmessage({ data: JSON.stringify({ type: 'browser.updated' }) });
  event(); await runDue(); assert.equal(refreshes, 1);
  for (let i = 0; i < 25; i++) event();
  assert.equal(timers.size, 1); now = 1499; await runDue(); assert.equal(refreshes, 1);
  now = 1500; await runDue(); assert.equal(refreshes, 2);
  document.hidden = true; now = 5000;
  for (let i = 0; i < 25; i++) event();
  assert.equal(timers.size, 0); assert.equal(refreshes, 2);
  document.hidden = false; listeners.visibilitychange(); await runDue(); assert.equal(refreshes, 3);
  now = 7000; env.setMenu({}); event(); await runDue(); assert.equal(refreshes, 3);
  env.setMenu(null); now = 8500; await runDue(); assert.equal(refreshes, 4);
});
