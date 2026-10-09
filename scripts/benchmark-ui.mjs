// Dedicated dashboard/extension performance test. Requires preview-performance.ts.
// node scripts/benchmark-ui.mjs LOCAL_LAB_URL OUTPUT_DIR [BASELINE_APP_JS]
// One browser, one renderer, sequential samples, atomic checkpoints and guaranteed cleanup.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const base = process.argv[2] || JSON.parse(readFileSync('/tmp/tallylamp-performance-lab.json','utf8')).url;
const out = path.resolve(process.argv[3] || 'docs/audits/performance-2026-10-09/ui');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'tallylamp-perf-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=192', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', session;
const pending = new Map();
const listeners = new Map();
chrome.stdio[4].on('data', bytes => {
  buffer += bytes;
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id); clearTimeout(timer);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
    for (const listener of listeners.get(msg.method) || []) listener(msg.params);
  }
});
const send = (method, params = {}, sid = session) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
  pending.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }) + '\0');
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, result) => {
  const file = path.join(out, name + '.json');
  writeFileSync(file + '.tmp', JSON.stringify({ measuredAt: new Date().toISOString(), base, ...result }, null, 2));
  renameSync(file + '.tmp', file);
  console.log(name, JSON.stringify(result).slice(0, 450));
};
const observer = `window.__perf={lcp:0,cls:0,tasks:[],events:[]};
for(const type of ['largest-contentful-paint','layout-shift','longtask','event']){try{new PerformanceObserver(list=>{for(const e of list.getEntries()){if(type==='largest-contentful-paint')__perf.lcp=e.startTime;if(type==='layout-shift'&&!e.hadRecentInput)__perf.cls+=e.value;if(type==='longtask')__perf.tasks.push({start:e.startTime,duration:e.duration});if(type==='event'&&e.interactionId)__perf.events.push({name:e.name,duration:e.duration});}}).observe({type,buffered:true,durationThreshold:16})}catch{}}`;
const navigate = async url => {
  await send('Page.navigate', { url });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await evaluate('document.readyState === "complete"')) { await delay(350); return; }
    await delay(100);
  }
  throw new Error('Navigation did not complete: ' + url);
};
const metrics = () => evaluate(`(()=>{const n=performance.getEntriesByType('navigation')[0];const resources=performance.getEntriesByType('resource');return {...__perf,ttfb:n.responseStart,dcl:n.domContentLoadedEventEnd,load:n.loadEventEnd,fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime,transferBytes:resources.reduce((s,r)=>s+r.transferSize,0)+n.transferSize,jsDecodedBytes:resources.filter(r=>r.initiatorType==='script').reduce((s,r)=>s+r.decodedBodySize,0),resources:resources.length,domNodes:document.querySelectorAll('*').length,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth}})()`);

try {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error('Only a disposable local lab is accepted');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId: session } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Page.enable'); await send('Network.enable');
  // Compare old/new frontend against the SAME backend by replacing only the owned lab asset.
  {
    const source = readFileSync(process.argv[4] || new URL('../dashboard/app.js', import.meta.url), 'utf8');
    // Test-only access to the real module callbacks. Never written into the shipped app.
    const body = Buffer.from(source + '\nObject.assign(window,{render,state,editBrowser,addSite,setSiteState,removeSite,closeMenu});').toString('base64');
    listeners.set('Fetch.requestPaused', [p => void send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body })]);
    await send('Fetch.enable', { patterns: [{ urlPattern: base + '/app.js', requestStage: 'Request' }] });
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: observer + `
window.EventSource=undefined;const nativeFetch=fetch;window.__requests=[];window.__pending=0;window.__lastNetwork=0;
window.fetch=async(...args)=>{const start=performance.now();__lastNetwork=start;__pending++;try{const response=await nativeFetch(...args);__requests.push({url:String(args[0]),duration:performance.now()-start,status:response.status});return response}finally{__pending--;__lastNetwork=performance.now()}};
window.__action=async(name,run)=>{const start=performance.now();const first=__requests.length;let done=false,error,lastChange=start;const observer=new MutationObserver(()=>lastChange=performance.now());observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});Promise.resolve().then(run).catch(e=>error=String(e)).finally(()=>{done=true;lastChange=performance.now()});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const feedbackMs=performance.now()-start;const deadline=performance.now()+15000;while((!done||__pending||performance.now()-Math.max(lastChange,__lastNetwork)<80)&&performance.now()<deadline)await new Promise(r=>setTimeout(r,20));observer.disconnect();return {name,feedbackMs,completionMs:Math.max(feedbackMs,Math.max(lastChange,__lastNetwork)-start),requests:__requests.slice(first),error,pending:__pending}};` });
  await navigate(base + '/');
  await evaluate(`fetch('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:'test-admin-secret-value'})}).then(r=>{if(!r.ok)throw Error('Lab sign-in failed')})`);
  await navigate(base + '/');
  for (const cpu of [1, 4]) {
    await send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', latency: 40, downloadThroughput: 1250000, uploadThroughput: 625000 }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    save('network-calibration-'+cpu+'x', {roundTripMs:await evaluate(`(async()=>{const t=performance.now();await fetch('/healthz?perf='+Date.now(),{cache:'no-store'}).then(r=>r.text());return performance.now()-t})()`)});
    const actions = [];
    for (const route of ['/', '/agents', '/seeds', '/workers', '/security', '/pair', '/']) {
      actions.push(await evaluate(`__action(${JSON.stringify('navigate '+route)},()=>{history.pushState({},'',${JSON.stringify(route)});return render()})`));
    }
    actions.push(await evaluate(`__action('filter browsers',()=>{const input=document.querySelector('input[aria-label="Filter browsers"]');if(!input)throw Error('filter absent');input.value='Finance';input.dispatchEvent(new Event('input',{bubbles:true}))})`));
    actions.push(await evaluate(`__action('clear filter',()=>{const input=document.querySelector('input[aria-label="Filter browsers"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})`));
    // Real modal callbacks and real SQLite writes to this disposable fixture only.
    const modal = async (name, fn, fields = {}) => {
      const opened = await evaluate(`__action(${JSON.stringify(name+' open')},()=>{void ${fn}})`); actions.push(opened);
      actions.push(await evaluate(`__action(${JSON.stringify(name+' submit')},()=>{const form=document.querySelector('.modal form');if(!form)throw Error('modal form absent');for(const [name,value]of Object.entries(${JSON.stringify(fields)})){const input=form.querySelector('[name="'+name+'"]');if(!input)throw Error(name);input.value=value}form.requestSubmit()})`));
    };
    await modal('edit browser details', 'editBrowser(state.browsers[0])', { name: 'Performance edited '+cpu, project: 'Finance' });
    await modal('record signed-in site', 'addSite(state.browsers[0])', { origin: 'https://example.test', name: 'Example' });
    actions.push(await evaluate(`__action('mark needs login',()=>setSiteState(state.browsers[0],state.browsers[0].signedInSites[0],'needs_sign_in'))`));
    actions.push(await evaluate(`__action('remove site record',()=>removeSite(state.browsers[0],state.browsers[0].signedInSites[0]))`));
    actions.push(await evaluate(`__action('open browser actions',()=>{const button=document.querySelector('.card button[aria-label]');if(!button)throw Error('card menu absent');button.click()})`));
    await evaluate('closeMenu()');
    actions.push(await evaluate(`__action('view stopped browser',()=>{history.pushState({},'','/browsers/'+state.browsers[0].id);return render()})`));
    await evaluate(`history.pushState({},'','/');render()`);
    await delay(400);
    save('dashboard-actions-'+cpu+'x', { cpu, latencyMs: 40, note: 'Real DOM and HTTP/SQLite; fake Chrome lifecycle. Programmatic activation; feedbackMs is a paint opportunity, not verified visible acknowledgement. Inspect errors per action.', actions });
  }
  for (const width of [375, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate(base + '/');
    save('dashboard-'+width, await metrics());
    writeFileSync(path.join(out, 'dashboard-'+width+'.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  for (const state of ['unpaired','unpaired-error','pairing','connecting','ready','unshareable','dashboard','other-extension','shared-here','shared-connecting','shared-elsewhere','offline','notice']) {
    const name = 'extension-'+state;
    const states=[];
    for (const width of [375, 768, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await navigate(base+'/extension/panel.html?demo='+state);
      states.push(await metrics());
      writeFileSync(path.join(out, name+'-'+width+'.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    save(name, { state, note: 'Real panel renderer, documented demo data. Does not exercise extension APIs.', states });
  }
} finally {
  for (const { timer, reject } of pending.values()) { clearTimeout(timer); reject(new Error('Benchmark ended')); }
  pending.clear();
  const exited = once(chrome, 'exit'); chrome.kill('SIGTERM');
  const killTimer = setTimeout(() => chrome.kill('SIGKILL'), 3000);
  await exited; clearTimeout(killTimer); rmSync(profile, { recursive: true, force: true });
}
