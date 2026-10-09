// Isolated UX audit fixture. Synthetic API data; no live service, profiles or credentials.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {WebSocketServer} from 'ws';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../dashboard',import.meta.url));
const now=new Date().toISOString(), old=new Date(Date.now()-3600000).toISOString();
const sites=[{id:'site-google',origin:'https://google.com',name:'Google',state:'confirmed',accountHint:'audit@example.test',lastConfirmedAt:now,reportedBy:{type:'system'}}];
const base={kind:'hosted',persistent:true,created_at:old,updated_at:now,lastActivityAt:now,owner:{type:'agent',id:'agent-1'},provenance:{createdByType:'agent',createdVia:'mcp'},metadata:{project:'Launch research',purpose:'Review competitor pricing',task:'Compare this month’s plans'},signedInSites:sites,control:{controllerType:'agent',controllerId:'agent-1'},mcpAttached:true,viewers:0,extensionsEnabled:false,agentDesktopEnabled:false,lendable:false,pinned:false,sandboxStatus:'sandboxed',gpuStatus:'software',chromeVersion:'Chrome/130.0',grants:[],readGrants:[],threads:120};
let browsers=[{...base,id:'browser-1',name:'Research · Main',status:'running',url:'https://example.test/pricing',title:'Pricing comparison'}, {...base,id:'browser-2',name:'Customer support',status:'unhealthy',health:{reason:'Chrome cannot create new tabs'},metadata:{project:'Support',purpose:'Handle customer tickets'},url:'https://example.test/inbox',title:'Support inbox'}, {...base,id:'browser-3',name:'Sign-in backup',status:'stopped',control:null}, {...base,id:'browser-4',name:'Personal laptop',kind:'linked',status:'stopped',control:null,link:{online:true,sharedTabs:[{targetId:'page1',title:'Documentation',url:'https://example.test/docs'}]},metadata:{project:'Engineering'}}, {...base,id:'browser-5',name:'Campaign browser',status:'queued',control:null}, {...base,id:'browser-6',name:'Archive investigation',status:'crashed',control:null}];
const agents=[{id:'agent-1',name:'OpenCode (connector)',enabled:true,lastSeenAt:now,labels:{kind:'connector',client_host:'127.0.0.1'},scopes:['browser:read'],maxBrowsers:0},{id:'agent-2',name:'Research assistant',enabled:true,lastSeenAt:old,labels:{},scopes:['browser:read'],maxBrowsers:2},{id:'agent-3',name:'Retired integration',enabled:false,lastSeenAt:null,labels:{},scopes:[],maxBrowsers:0}];
agents.forEach(a=>a.createdAt=old);
const seeds=[{id:'seed-1',name:'Main Google profile',metadata:{project:'Launch research',purpose:'Reusable signed-in research setup'},signedInSites:sites,created_at:old,updated_at:now}];
const workers=[{id:'worker-1',name:'Research worker',url:'http://research.railway.internal:8080',version:'0.11.2',online:true,browsers:2,running:1,pids:{current:620,max:1000}},{id:'worker-2',name:'Support worker',url:'http://support.railway.internal:8080',version:'0.11.1',online:false,problem:'Connection timed out',browsers:0,running:0}];
let requests=[{id:'request-1',browser_id:'browser-1',browserName:'Research · Main',requester_name:'Strategy assistant',requester_id:'agent-2',access:'control',reason:'Continue the pricing comparison',created_at:old}];
const pairing={state:'pending',userCode:'ABCD-1234',deviceName:'Personal Chrome',remoteAddr:'192.0.2.40',createdAt:now};
const perms=[{scope:'browser:read',label:'Read browsers',detail:'See browsers and their pages.'},{scope:'browser:write',label:'Control browsers',detail:'Click, type and navigate.'},{scope:'browser:create',label:'Create browsers',detail:'Start new browser profiles.'}];
const status={maxBrowsers:8,running:2,sandbox:'auto',gpu:'software',oauth:true,allowPrivateNetwork:false,xvfb:true,fullBrowser:true,humanLeaseTtlSec:90,host:{pids:{current:650,max:1000},headroom:100,held:0},tunnels:{enabled:true,maxPerBrowser:4},linked:{enabled:true},extensions:{enabled:true},workers};
const error=(res,message,code=503)=>res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message}}));
const api=(path,scenario)=>{
 const empty=scenario==='empty';
 if(path.startsWith('/api/v1/links/pair/'))return {pairing};
 if(path==='/api/v1/me')return {principal:{type:scenario==='agent'?'agent':'admin',id:'audit'}};
 if(path==='/api/v1/status')return {...status,...(scenario==='transitional'?{running:0}:{}),host:status.host};
 if(path==='/api/v1/browsers')return {browsers:empty?[]:scenario==='transitional'?browsers.map((b,i)=>({...b,status:['starting','queued','moving','stopping','stopped','crashed'][i]})):browsers};
 if(path==='/api/v1/agents')return {agents:empty?[]:agents,permissions:perms,defaultScopes:['browser:read']};
 if(path==='/api/v1/seeds')return {seeds:empty?[]:seeds};
 if(path==='/api/v1/workers')return {workers:empty?[]:workers};
 if(path==='/api/v1/requests')return {requests:empty?[]:requests};
 const id=path.split('/')[4],b=browsers.find(b=>b.id===id);
 if(path.endsWith('/guests'))return {guests:[]};
 if(path.endsWith('/access'))return {access:{anyAgent:false,agentIds:['agent-1']}};
 if(path.endsWith('/viewer-ticket'))return {ticket:'audit'};
 if(b)return {browser:b,tunnels:[],activity:[{at:now,kind:'navigate_page'},{at:old,kind:'take_snapshot'}]};
 return {};
};
const messages=[];
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://127.0.0.1').pathname,scenario=String(req.headers['x-audit-scenario']||'populated');
 if(path.endsWith('/thumbnail')){res.writeHead(200,{'Content-Type':'image/png'}).end(await readFile(new URL('./images/remote-frame.png',import.meta.url)));return;}
 if(path==='/__audit/messages')return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(messages));
 if(path==='/__audit/control-expire'){browsers[0].control={controllerType:'agent',controllerId:'agent-1'};for(const ws of wss.clients)ws.send(JSON.stringify({type:'error',message:'lease expired'}));return res.writeHead(200).end('expired');}
 if(path.startsWith('/api/')){
   if(scenario==='hang-workers'&&path==='/api/v1/workers')await new Promise(r=>setTimeout(r,15000));
   if(scenario==='guest-error'&&path.endsWith('/guests'))return error(res,'Guest store unavailable');
   if(scenario==='slow')await new Promise(r=>setTimeout(r,1800));
   if(scenario==='unavailable')return error(res,'Service unavailable');
   if(scenario==='loggedout' && path!='/api/v1/login')return error(res,'Sign in required',401);
   if((scenario==='partial' && (path==='/api/v1/requests'||path==='/api/v1/workers'))||(scenario==='status-error'&&path==='/api/v1/status'))return error(res,'Audit fixture: upstream unavailable');
   if(req.method!=='GET'){
     let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):{};
     if(scenario==='lag-mutation')await new Promise(r=>setTimeout(r,1800));
     if(scenario==='mutation-error')return error(res,'Audit fixture: Could not save. Please retry.');
     if(path.endsWith('/approve'))return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({browser:{name:body.name||'Personal Chrome',kind:'linked'}}));
     if(path.endsWith('/deny'))pairing.state='denied';
     if(path==='/api/v1/browsers'){const b={...base,owner:{type:'admin',id:'admin'},provenance:{createdByType:'admin',createdVia:'dashboard'},id:'created-browser',name:body.name||'Generated browser',status:'running',metadata:body.metadata,url:'about:blank',title:'New tab'};browsers.push(b);return res.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify({browser:b}));}
     if(path.endsWith('/answer'))requests=[];
     if(path.endsWith('/control')){const b=browsers.find(b=>b.id===path.split('/')[4]);if(b)b.control=req.method==='DELETE'?{controllerType:'agent',controllerId:'agent-1'}:{controllerType:'human',controllerId:'admin',leaseToken:'audit'};}
     if(path.endsWith('/start')||path.endsWith('/stop')){const b=browsers.find(b=>b.id===path.split('/')[4]);if(b)b.status=path.endsWith('/start')?'running':'stopped';}
     if(path==='/api/v1/agents')return res.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify({agent:{id:'new-agent'},token:'audit-token-for-fixture-only'}));
   }
   return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(api(path,scenario)));
 }
 if(path.endsWith('/thumbnail')){res.writeHead(200,{'Content-Type':'image/png'}).end(await readFile(new URL('./images/remote-frame.png',import.meta.url)));return;}
 if(['/app.js','/app.css','/tallylamp-icon.svg','/favicon-dark.svg','/favicon-light.svg'].includes(path))return res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'image/svg+xml'}).end(await readFile(root+path));
 let html=await readFile(root+'/index.html','utf8');
 html=html.replace('<head>',`<head><script>window.EventSource=undefined;const s=new URLSearchParams(location.search).get('audit');if(s)sessionStorage.setItem('audit-scenario',s);window.__auditScenario=sessionStorage.getItem('audit-scenario')||'populated';const f=window.fetch;window.fetch=(u,o={})=>f(u,{...o,headers:{...o.headers,'X-Audit-Scenario':window.__auditScenario}});</script>`);
 res.writeHead(200,{'Content-Type':'text/html'}).end(html);
}catch(e){console.error(e.message);error(res,'Fixture error');}});
const wss=new WebSocketServer({server});wss.on('connection',async(ws)=>{ws.send(JSON.stringify({type:'hello',content:{width:1280,height:800}}));ws.send(JSON.stringify({type:'tabs',activeTargetId:'page-1',tabs:[{targetId:'page-1',title:'Pricing comparison',url:'https://example.test/pricing'},{targetId:'page-2',title:'Support inbox',url:'https://example.test/inbox'}]}));ws.send(JSON.stringify({type:'frameMeta',width:1280,height:800}));ws.send(await readFile(new URL('./images/remote-frame.png',import.meta.url)));ws.on('message',data=>{try{const msg=JSON.parse(data.toString());messages.push(msg);if(msg.type==='selectTab')ws.send(JSON.stringify({type:'tabs',activeTargetId:msg.targetId,tabs:[{targetId:'page-1',title:'Pricing comparison',url:'https://example.test/pricing'},{targetId:'page-2',title:'Support inbox',url:'https://example.test/inbox'}]}));}catch{}});});
server.listen(4321,'127.0.0.1',()=>console.log('UX audit fixture at http://127.0.0.1:4321'));
