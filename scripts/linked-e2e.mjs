// Linked browsers, end to end: the real extension loaded into a real Chrome, paired against a
// real local server, a real tab shared, and driven through the real chrome-devtools-mcp bridge.
//
// The unit suite stands a scripted peer in for chrome.debugger, which cannot tell you whether
// Chrome agrees. This can. It found that Chrome lets an extension debug its OWN pages, which
// the scripted peer had no way to know. Run it after touching extension/ or src/linked*.ts:
//
//   node scripts/linked-e2e.mjs            (CHROME_BIN overrides the browser path)
//
// One headless Chrome, killed in finally. Needs a branded Chrome or Chromium on this machine,
// which is why it is not part of `npm test`.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const OUT = process.argv[2] ?? path.join(os.tmpdir(), "tallylamp-linked-e2e"); mkdirSync(OUT, { recursive: true }); const EXT = path.resolve("extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const pages = http.createServer((req, res) => { res.setHeader("content-type", "text/html");
  res.end(req.url.startsWith("/two") ? "<title>Second page</title><h1>Second</h1>" : "<title>Linked e2e page</title><h1 id=h>Hello from a real tab</h1><button onclick=\"document.getElementById('h').textContent='clicked'\">Press me</button><input type=file id=f>"); });
await new Promise((r) => pages.listen(0, "127.0.0.1", r)); const PP = pages.address().port;
const data = path.join(OUT, "e2e-data"); rmSync(data, { recursive: true, force: true }); mkdirSync(data, { recursive: true });
const PORT = 19000 + Math.floor(Math.random() * 900); const base = `http://127.0.0.1:${PORT}`;
const svc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", ADMIN_SECRET: "e2e-secret-value-12345", TALLYLAMP_DATA_DIR: data, TALLYLAMP_FAKE_CHROME: "1", TALLYLAMP_PUBLIC_URL: base }, stdio: "ignore" });
let chrome; let failed = 0;
const check = (name, ok, detail = "") => { log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 220).replace(/\s+/g, " ") : ""}`); if (!ok) failed++; };
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/v1/openapi.json`); break; } catch { await sleep(250); } }
  const login = await fetch(`${base}/api/v1/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "e2e-secret-value-12345" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0]; const H = { "content-type": "application/json", cookie, origin: base };
  const agent = await (await fetch(`${base}/api/v1/agents`, { method: "POST", headers: H, body: JSON.stringify({ name: "E2E agent" }) })).json();
  const agentId = agent.agent?.id ?? agent.id; const agentToken = agent.token;

  const profile = path.join(OUT, "e2e-profile"); rmSync(profile, { recursive: true, force: true });
  chrome = spawn(process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome"), ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let id = 0, buf = ""; const waits = new Map();
  chrome.stdio[4].on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\0")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waits.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + "\0"); });
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  check("extension loads unpacked in real Chrome", Boolean(extId), extId);
  await send("Target.createTarget", { url: `http://127.0.0.1:${PP}/` });
  const { targetId: popupTarget } = await send("Target.createTarget", { url: `chrome-extension://${extId}/panel.html` });
  const { sessionId: P } = await send("Target.attachToTarget", { targetId: popupTarget, flatten: true });
  await sleep(1200);
  const inExt = async (expr) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, P); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const state = () => inExt(`return (await chrome.runtime.sendMessage({type:"getState"})).state`);

  await inExt(`await chrome.runtime.sendMessage({type:"startPairing", server:"127.0.0.1:${PORT}"}); return 1`);
  let st = await state();
  check("popup -> worker: pairing started, code shown", st.link === "pairing" && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(st.pairing?.userCode ?? ""), JSON.stringify(st.pairing?.userCode ?? st.error));
  const approve = await fetch(`${base}/api/v1/links/pair/${st.pairing.userCode}/approve`, { method: "POST", headers: H, body: JSON.stringify({ agentIds: [agentId], name: "E2E Chrome" }) });
  check("dashboard approves the code", approve.status === 201, approve.status);
  for (let i = 0; i < 20 && (st = await state()).link !== "online"; i++) await sleep(500);
  check("extension collects its token and connects", st.link === "online", `${st.link} ${st.error ?? ""}`);

  const tabId = await inExt(`const t=(await chrome.tabs.query({})).find(t=>t.url.startsWith("http://127.0.0.1:${PP}")); return t?.id`);
  const denied = await inExt(`const t=(await chrome.tabs.query({})).find(t=>t.url.startsWith("chrome-extension://")); return (await chrome.runtime.sendMessage({type:"shareTab", tabId:t.id, site:null}))`);
  check("sharing an extension page is refused with a human sentence", denied.ok === false, denied.error);
  const sharedRes = await inExt(`return await chrome.runtime.sendMessage({type:"shareTab", tabId:${tabId}, site:"127.0.0.1"})`);
  check("chrome.debugger attaches and the tab is shared", sharedRes.ok && sharedRes.state.shared.length === 1, sharedRes.error ?? JSON.stringify(sharedRes.state.shared));

  const rpc = (method, params, extra = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "MCP-Protocol-Version": "2025-11-25", ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const sess = { "MCP-Session-Id": init.headers.get("mcp-session-id") };
  const call = async (name, args = {}) => { const t = await (await rpc("tools/call", { name, arguments: args }, sess)).text(); const line = t.split("\n").find((l) => l.startsWith("data:")); const r = JSON.parse(line ? line.slice(5) : t).result; return { err: Boolean(r.isError), text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n") }; };
  const listed = JSON.parse((await call("tallylamp_list_browsers")).text); const b = (listed.browsers ?? listed).find((x) => x.kind === "linked");
  check("agent sees the linked browser, online, with its shared tab", b?.link?.online === true && b.link.sharedTabs.length === 1, JSON.stringify(b?.link));
  const used = await call("tallylamp_use_browser", { browserId: b.id }); check("tallylamp_use_browser binds (real Puppeteer connect through the shim)", !used.err, used.text);
  const lp = await call("list_pages"); check("list_pages shows the real tab", !lp.err && lp.text.includes(`127.0.0.1:${PP}`), lp.text);
  const snap = await call("take_snapshot", { pageId: 1 }); check("take_snapshot reads the real accessibility tree", !snap.err && /Hello from a real tab/.test(snap.text), snap.text);
  const uid = snap.text.match(/uid=(\S+)\s+button/)?.[1];
  const clicked = await call("click", { pageId: 1, uid }); check("click lands on the real button", !clicked.err, clicked.text);
  const ev = await call("evaluate_script", { pageId: 1, function: "() => document.getElementById('h').textContent" }); check("evaluate_script sees the click's effect", /clicked/.test(ev.text), ev.text);
  const shot = await call("take_screenshot", { pageId: 1 }); check("take_screenshot returns an image", !shot.err && /\[image\]/.test(shot.text), shot.text);
  const nav = await call("navigate_page", { pageId: 1, url: `http://127.0.0.1:${PP}/two` }); check("navigate_page within the shared site works", !nav.err && /two/.test(nav.text), nav.text);
  const away = await call("navigate_page", { pageId: 1, url: "https://example.com/" }); check("navigating off the shared site is refused by the extension", /shared for 127\.0\.0\.1 only/.test(away.text), away.text);
  const np = await call("new_page", { url: `http://127.0.0.1:${PP}/two` }); check("new_page opens an agent tab in the person's browser", !np.err, np.text);
  st = await state(); check("the agent's tab is tracked as opened by agent", st.shared.some((t) => t.byAgent), JSON.stringify(st.shared.map((t) => [t.url, t.byAgent])));

  await inExt(`await chrome.runtime.sendMessage({type:"stopAll"}); return 1`); await sleep(500);
  const after = await call("list_pages"); check("after Stop, the agent has no pages left", after.err || !after.text.includes(`127.0.0.1:${PP}`), after.text);
  const detached = await inExt(`return (await chrome.debugger.getTargets()).filter(t=>t.attached && t.tabId && !t.url.startsWith("chrome-extension://")).length`);
  check("after Stop, the debugger is detached from every tab", detached === 0, detached);
} catch (e) { check("script ran to completion", false, e.stack ?? e); }
finally { chrome?.kill("SIGKILL"); svc.kill("SIGTERM"); pages.close(); }
log(failed ? `\n${failed} FAILED` : "\nALL PASSED"); await sleep(300); process.exit(failed ? 1 : 0);
