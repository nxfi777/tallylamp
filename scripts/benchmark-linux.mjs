// Run inside the Linux service container. Uses only a new /tmp directory and loopback ports.
// Existing deployment/data are never modified. AUDIT_PATCH_DIR may contain separately
// uploaded compiled modules; these are applied only to a disposable copy of dist.
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('/app/package.json');
const WebSocket = require('ws');
const directory = process.env.AUDIT_DIRECTORY || fs.mkdtempSync('/tmp/tallylamp-linux-audit-');
const report = { measuredAt: new Date().toISOString(), platform: process.platform, node: process.version,
  release: JSON.parse(fs.readFileSync('/app/package.json')).version,
  initialContainerMemoryBytes: Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8')),
  initialContainerPids: Number(fs.readFileSync('/sys/fs/cgroup/pids.current','utf8')), label: process.env.AUDIT_LABEL || 'baseline',
  boundary: 'Isolated temporary main/worker services in the hosting container, one real Chrome/Xvfb. Loopback transport. Frame receipt excludes final client presentation.', results: [], failures: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const record = (name, samples, extra = {}) => {
  const sorted = [...samples].sort((a,b) => a-b);
  report.results.push({ name, samplesMs: samples, n: samples.length,
    p50Ms: sorted[Math.ceil(sorted.length*.5)-1], p95Ms: sorted[Math.ceil(sorted.length*.95)-1], ...extra });
  fs.writeFileSync(path.join(directory, 'checkpoint.json.tmp'), JSON.stringify(report));
  fs.renameSync(path.join(directory, 'checkpoint.json.tmp'), path.join(directory, 'checkpoint.json'));
};
Object.assign(process.env, { TALLYLAMP_DATA_DIR: path.join(directory, 'main'), ADMIN_SECRET: randomBytes(24).toString('hex'),
  TALLYLAMP_FAKE_CHROME: '0', TALLYLAMP_XVFB: '1', TALLYLAMP_XVFB_SCREEN: '1280,800', TALLYLAMP_WINDOW_SIZE: '1280,800',
  TALLYLAMP_PUBLIC_URL: 'http://127.0.0.1', TALLYLAMP_ALLOW_PRIVATE_NETWORK: '1', TALLYLAMP_MAX_BROWSERS: '1',
  TALLYLAMP_IDLE_TTL_SEC: '0', TALLYLAMP_EXTENSIONS_DEFAULT: '1', TALLYLAMP_AGENT_DESKTOP_DEFAULT: '1' });
let modules = '/app/dist';
if (process.env.AUDIT_PATCH_DIR) {
  modules = path.join(directory, 'dist'); fs.cpSync('/app/dist', modules, {recursive:true});
  fs.copyFileSync('/app/package.json', path.join(directory, 'package.json'));
  fs.symlinkSync('/app/node_modules', path.join(directory, 'node_modules'));
  for (const name of ['desktop-viewer.js','x11-remote.js']) {
    const file=path.join(process.env.AUDIT_PATCH_DIR,name);
    if(fs.existsSync(file))fs.copyFileSync(file,path.join(modules,name));
  }
}
const { BrowserManager } = await import(pathToFileURL(path.join(modules, 'browsers.js')).href);
const { McpGateway } = await import(pathToFileURL(path.join(modules, 'mcp.js')).href);
const { createApp } = await import(pathToFileURL(path.join(modules, 'server.js')).href);
const { attachViewerUpgrade } = await import(pathToFileURL(path.join(modules, 'viewer.js')).href);
const { adminPrincipal } = await import(pathToFileURL(path.join(modules, 'auth.js')).href);
const { startWorker } = await import(pathToFileURL(path.join(modules, 'worker.js')).href);
const { CdpClient, browserWsUrl } = await import(pathToFileURL(path.join(modules, 'cdp.js')).href);
const browsers = new BrowserManager(); browsers.workers.stopPolling();
const mcp = new McpGateway(browsers); const app = createApp(browsers,mcp); const server = http.createServer(app);
attachViewerUpgrade(server,browsers);
let worker, cdp, viewer, id, heartbeat, session;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return; cleaned = true;
  clearInterval(heartbeat); viewer?.terminate(); await cdp?.close();
  await mcp.closeAll(); await browsers.shutdown(); await worker?.close();
  server.closeAllConnections?.(); await new Promise(r => server.close(r));
  await rm(directory,{recursive:true,force:true});
};
const watchdog = setTimeout(() => { report.failures.push('120-second watchdog'); void cleanup().finally(() => { console.log('AUDIT_REPORT '+JSON.stringify(report)); process.exit(2); }); },120000);
const html = `<!doctype html><html><body style="margin:0;height:2200px;background:#eee">
<canvas id="marker" width="256" height="48" style="position:fixed;top:0;left:0;z-index:10"></canvas>
<button id="advance" style="margin:80px 20px 20px;width:180px;height:50px">Advance</button>
<input id="entry" style="width:200px;height:40px"><p>Isolated Linux performance fixture</p>
<script>window.counter=0;window.bump=()=>{counter++;paint()};window.paint=()=>{let c=marker.getContext('2d');for(let i=0;i<8;i++){c.fillStyle=counter&(1<<i)?'#000':'#fff';c.fillRect(i*32,0,32,48)}};paint();advance.onclick=bump;entry.oninput=bump;
window.decode=async(data,native)=>{let bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));let bitmap=await createImageBitmap(new Blob([bytes]));let c=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d');c.drawImage(bitmap,0,0);let scale=native?bitmap.width/1280:bitmap.width/innerWidth;let dx=native?screenX+(outerWidth-innerWidth)/2:0;let dy=native?screenY+outerHeight-innerHeight-(outerWidth-innerWidth)/2:0;let code=0;for(let i=0;i<8;i++){let p=c.getImageData(Math.round((dx+i*32+16)*scale),Math.round((dy+24)*scale),1,1).data;if(p[0]<128)code|=1<<i}bitmap.close();return code};</script></body></html>`;
const evaluate = async expression => {
  const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);
  if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result.value;
};
const until = async (check, message, timeout=8000) => {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(10)}
  throw new Error(message);
};
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;process.env.TALLYLAMP_PUBLIC_URL=base;
  app.get('/performance-fixture',(_req,res)=>res.type('html').send(html));
  const login=await fetch(base+'/api/v1/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:process.env.ADMIN_SECRET}),signal:AbortSignal.timeout(5000)});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=async(route,body)=>{
    const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:base,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw new Error(`${route}: ${r.status} ${await r.text()}`);return r;
  };
  const portServer=http.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const workerPort=portServer.address().port;await new Promise(r=>portServer.close(r));
  worker=await startWorker({dataDir:path.join(directory,'worker'),host:'127.0.0.1',port:workerPort,selfUrl:`http://127.0.0.1:${workerPort}`,name:'Disposable Linux performance worker',join:browsers.workers.createJoinToken(adminPrincipal()).token});
  await browsers.workers.poll();
  const row=await browsers.create({principal:adminPrincipal(),via:'dashboard',name:'Disposable Linux fixture',workerId:worker.identity.workerId});id=row.id;
  let t=performance.now();const rt=await browsers.ensureRunning(id);record('real worker Chrome start to API runtime',[performance.now()-t]);
  cdp=new CdpClient(await browserWsUrl(rt.cdpUrl));await cdp.connect();
  const targets=await cdp.send('Target.getTargets');const target=targets.targetInfos.find(x=>x.type==='page');
  ({sessionId:session}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}));await cdp.send('Page.enable',{},session);
  t=performance.now();await cdp.send('Page.navigate',{url:base+'/performance-fixture'},session);
  await until(()=>evaluate("typeof decode==='function'"),'Linux fixture navigation did not finish');
  record('real worker navigation to fixture ready',[performance.now()-t]);
  const thumb=[];for(let i=0;i<20;i++){t=performance.now();await(await request(`/api/v1/browsers/${id}/thumbnail`)).arrayBuffer();thumb.push(performance.now()-t)}record('real worker thumbnail HTTP',thumb);
  const control=browsers.acquireControl(id,'human','admin');
  const ticket=await(await request(`/api/v1/browsers/${id}/viewer-ticket`,{mode:'control'})).json();
  let frames=0, frameBytes=0, lastFrames=[], notices=[];
  t=performance.now();viewer=new WebSocket(base.replace('http','ws')+`/api/v1/browsers/${id}/view?surface=desktop&ticket=${ticket.ticket}`);
  viewer.on('message',(raw,binary)=>{if(binary){frames++;frameBytes+=raw.length;lastFrames.push({at:performance.now(),data:Buffer.from(raw)});if(lastFrames.length>6)lastFrames.shift()}else{const m=JSON.parse(String(raw));if(['error','notice'].includes(m.type))notices.push(m.message)}});
  await new Promise((resolve,reject)=>{viewer.once('open',resolve);viewer.once('error',reject)});
  const send=m=>viewer.send(JSON.stringify(m));send({type:'heartbeat',leaseToken:control.leaseToken});
  heartbeat=setInterval(()=>send({type:'heartbeat',leaseToken:control.leaseToken}),3000);
  await until(()=>frames,'Desktop first frame missing');report.firstDesktopFrameBase64=lastFrames[0].data.toString('base64');record('native desktop connection to first frame receipt',[lastFrames[0].at-t]);
  await sleep(300);
  const point=await evaluate("(()=>{let r=advance.getBoundingClientRect();return{x:screenX+(outerWidth-innerWidth)/2+r.x+r.width/2,y:screenY+outerHeight-innerHeight-(outerWidth-innerWidth)/2+r.y+r.height/2}})()");
  const matching=async(code,start)=>until(async()=>{for(const f of lastFrames){if(f.at<start)continue;const found=await evaluate(`decode(${JSON.stringify(f.data.toString('base64'))},true)`);if(found===code)return f.at-start}return false},`No desktop frame for marker ${code}`);
  const clicks=[];
  for(let i=0;i<20;i++){if(process.env.AUDIT_JITTER==='1')await sleep([0,13,47,83,29][i%5]);const code=await evaluate('counter+1');lastFrames=[];t=performance.now();send({type:'mouse',event:'mousePressed',button:'left',...point,modifiers:0});send({type:'mouse',event:'mouseReleased',button:'left',...point,modifiers:0});clicks.push(await matching(code,t))}
  record('native desktop click to matching frame receipt',clicks,{correlation:'8-bit action marker decoded from actual full-desktop JPEG, including Chrome UI offset',schedule:process.env.AUDIT_JITTER==='1'?'fixed 0/13/47/83/29 ms inter-action delay':'sequential immediately after matching decode'});
  await evaluate('entry.focus()');const paste=[];
  for(let i=0;i<5;i++){const code=await evaluate('counter+1');lastFrames=[];t=performance.now();send({type:'paste',text:'a'});paste.push(await matching(code,t))}record('native desktop paste to matching frame receipt',paste);
  const keys=[];for(let i=0;i<5;i++){const code=await evaluate('counter+1');lastFrames=[];t=performance.now();send({type:'key',event:'keyDown',key:'x',code:'KeyX',modifiers:0});send({type:'key',event:'keyUp',key:'x',code:'KeyX',modifiers:0});keys.push(await matching(code,t))}record('native desktop key to matching frame receipt',keys);
  const cpu=()=>{const children=fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/);return children.reduce((sum,pid)=>{try{if(fs.readFileSync(`/proc/${pid}/comm`,'utf8').trim()!=='ffmpeg')return sum;const parts=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(')').at(-1).trim().split(/\s+/);return sum+Number(parts[11])+Number(parts[12])}catch{return sum}},0)};
  await evaluate('window.animation=setInterval(bump,80)');await sleep(250);let f0=frames,b0=frameBytes,c0=cpu();await sleep(1200);const visible={frames:frames-f0,bytes:frameBytes-b0,cpuTicks:cpu()-c0};
  send({type:'visibility',visible:false});await sleep(250);f0=frames;b0=frameBytes;c0=cpu();await sleep(1200);const hidden={frames:frames-f0,bytes:frameBytes-b0,cpuTicks:Math.max(0,cpu()-c0)};
  const resume=performance.now();f0=frames;send({type:'visibility',visible:true});await until(()=>frames>f0,'desktop did not resume');
  record('desktop visibility capture work',[],{windowMs:1200,visible,hidden,resumeFirstFrameMs:lastFrames.at(-1).at-resume,notices});
  await evaluate('clearInterval(animation)');
  viewer.close(1000);await sleep(200);viewer=undefined;clearInterval(heartbeat);
  const watchTicket=await(await request(`/api/v1/browsers/${id}/viewer-ticket`,{mode:'watch'})).json();
  let watchFrames=0,watchAt=0,watchNotices=[];t=performance.now();
  viewer=new WebSocket(base.replace('http','ws')+`/api/v1/browsers/${id}/view?surface=desktop&ticket=${watchTicket.ticket}`);
  viewer.on('message',(raw,binary)=>{if(binary){watchFrames++;watchAt=performance.now()}else{const m=JSON.parse(String(raw));if(['error','notice'].includes(m.type))watchNotices.push(m.message)}});
  await new Promise((resolve,reject)=>{viewer.once('open',resolve);viewer.once('error',reject)});
  await until(()=>watchFrames,'watch first frame missing');record('native watch connection to first frame receipt',[watchAt-t]);
  const watchResume=[],watchHidden=[];
  // Animate during each hidden interval so an old still frame cannot satisfy resume.
  await evaluate('window.animation=setInterval(bump,80)');
  for(let i=0;i<3;i++){viewer.send(JSON.stringify({type:'visibility',visible:false}));await sleep(250);const count=watchFrames;await sleep(300);watchHidden.push(watchFrames-count);const before=watchFrames;t=performance.now();viewer.send(JSON.stringify({type:'visibility',visible:true}));await until(()=>watchFrames>before,'watch resume missing');watchResume.push(watchAt-t)}
  record('native watch resume to fresh frame receipt',watchResume,{hiddenFrames:watchHidden,notices:watchNotices});
  await evaluate('clearInterval(animation)');viewer.close(1000);await sleep(200);viewer=undefined;await cdp.close();cdp=undefined;
  // One native worker HTTP command distribution, through the exact remaining registration.
  const x11=[];for(let i=0;i<20;i++){t=performance.now();const r=await fetch(`http://127.0.0.1:${workerPort}/worker/v1/browsers/${id}/x11`,{method:'POST',headers:{authorization:`Bearer ${worker.identity.secret}`,'content-type':'application/json'},body:JSON.stringify({tool:'xdotool',args:['mousemove','100','100'],stdout:false}),signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('x11 route failed '+r.status);const data=Buffer.from(await r.arrayBuffer());if(!data.includes(Buffer.from('"code":0')))throw new Error('x11 did not report success '+data.toString());x11.push(performance.now()-t)}record('POST worker x11 mousemove through process exit',x11);
  for(const zero of [false,true]){const times=[];const args=['Alt_L','Control_L','Super_L','Shift_L'].flatMap(k=>zero?['keyup','--delay','0',k]:['keyup',k]);
    for(let i=0;i<20;i++){t=performance.now();const r=await fetch(`http://127.0.0.1:${workerPort}/worker/v1/browsers/${id}/x11`,{method:'POST',headers:{authorization:`Bearer ${worker.identity.secret}`,'content-type':'application/json'},body:JSON.stringify({tool:'xdotool',args,stdout:false}),signal:AbortSignal.timeout(8000)});const data=Buffer.from(await r.arrayBuffer());if(!r.ok||!data.includes(Buffer.from('"code":0')))throw new Error('modifier timing failed');times.push(performance.now()-t)}
    record('four native modifier releases, '+(zero?'explicit zero delay':'default delay'),times)}

  t=performance.now();await browsers.stop(id);record('real worker Chrome graceful stop',[performance.now()-t]);
} catch(error){report.failures.push(error.stack||String(error));process.exitCode=1}
finally {clearTimeout(watchdog);try{await cleanup()}catch(error){report.failures.push('cleanup: '+error.message);process.exitCode=1}console.log('AUDIT_REPORT '+JSON.stringify(report));}
