// Exercise the shipped dashboard orchestration under deterministic network latency.
// Rendering primitives are stubs: this measures avoidable request waterfalls, not DOM/paint.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const source = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
const fn = name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const out = path.resolve(process.argv[2] || 'docs/audits/performance-2026-10-09/dashboard.json');
mkdirSync(path.dirname(out), { recursive: true });
const rows = [];
for (const workerDelay of [40, 400]) {
  for (const action of ['render', 'call', 'setSiteState', 'removeSite']) {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const requests = [];
      let active = 0, renders = 0;
      const state = { me: { type: 'admin' }, data: Object.fromEntries(['status', 'browsers', 'agents', 'seeds', 'requests', 'workers'].map(n => [n, { loading: false, loadedAt: null, error: '' }])) };
      const noop = () => {};
      const api = async (url, options = {}) => {
        active++; requests.push({ url, method: options.method || 'GET' });
        await new Promise(r => setTimeout(r, url.endsWith('/workers') ? workerDelay : 40));
        active--;
        return { principal: { type: 'admin' }, [url.split('/').at(-1)]: [] };
      };
      const data = source.slice(source.indexOf('const DATA_PATHS ='), source.indexOf('let busyTimer ='));
      const code = `let renderSeq=0, detailMetadataRefresh=null;const TITLES={home:'Browsers'};const PENDING={start:'Starting…'};${data}\n${['render','call','setSiteState','removeSite','act'].map(fn).join('\n')}\n({render,call,setSiteState,removeSite})`;
      const env = runInNewContext(code, { state, api, console, document: { querySelector: () => null },
        h: () => ({}), layout: noop, route: () => ({ name: 'home' }), busy: noop,
        teardownViewer: noop, closeMenu: noop, flash: noop, startEvents: noop, syncRequestBadges: noop,
        homeView: () => renders++, paintBrowsers: () => renders++, loginView: noop,
        requestAnimationFrame: cb => setTimeout(cb, 0),
      });
      const start = performance.now();
      if (action === 'render') await env.render();
      else if (action === 'call') await env.call('/api/v1/browsers/fixture/start', { textContent: 'Start', isConnected: true });
      else await env[action]({ id: 'fixture' }, { id: 'site', origin: 'https://example.test', name: 'Example' }, 'confirmed');
      // Existing callbacks may fire-and-forget render; wait for all its real requests.
      do { await new Promise(r => setTimeout(r, 5)); } while (active);
      samples.push({ durationMs: performance.now() - start, requestCount: requests.length, renders, requests });
    }
    const ordered = samples.map(s => s.durationMs).sort((a,b) => a-b);
    rows.push({ action, network: { requestDelayMs: 40, workerDelayMs: workerDelay }, p50: ordered[5], p95: ordered[9], samples });
    writeFileSync(out + '.tmp', JSON.stringify({ measuredAt: new Date().toISOString(), note: 'Real dashboard async orchestration, simulated 40ms RTT and optional slow worker, rendering stubbed. Not a browser paint benchmark.', rows }, null, 2));
    renameSync(out + '.tmp', out);
    console.log(action, workerDelay, Math.round(ordered[5]), 'ms;', samples[0].requestCount, 'requests;', samples[0].renders, 'renders');
  }
}
