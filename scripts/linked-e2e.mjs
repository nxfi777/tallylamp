// Linked browsers, end to end: the real extension loaded into a real Chrome, paired against a
// real local server, a real tab shared, and driven through the real chrome-devtools-mcp bridge.
//
// The unit suite stands a scripted peer in for chrome.debugger, which cannot tell you whether
// Chrome agrees. This can. It found that Chrome lets an extension debug its OWN pages, which
// the scripted peer had no way to know. Run it after touching extension/ or src/linked*.ts:
//
//   node scripts/linked-e2e.mjs            (CHROME_BIN overrides the browser path)
//
// Two headless Chromes, the second with the "Extensions on chrome-extension:// URLs" flag on,
// both killed in finally. Needs a branded Chrome or Chromium on this machine, which is why it
// is not part of `npm test`.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const chromes = []; let failed = 0;
const check = (name, ok, detail = "") => { log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 220).replace(/\s+/g, " ") : ""}`); if (!ok) failed++; };
/** One headless Chrome on a CDP pipe, killed in finally. Returns its `send`. */
const launch = (dir, flags = []) => {
  const profile = path.join(OUT, dir); rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome"), ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...flags, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  chromes.push(chrome);
  let id = 0, buf = ""; const waits = new Map();
  chrome.stdio[4].on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\0")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } } });
  return (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waits.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + "\0"); });
};
/** Script in the extension's panel page, which can message its service worker. */
const panelOf = async (send, extId) => {
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/panel.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1200);
  return async (expr) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
};
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/v1/openapi.json`); break; } catch { await sleep(250); } }
  const login = await fetch(`${base}/api/v1/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "e2e-secret-value-12345" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0]; const H = { "content-type": "application/json", cookie, origin: base };
  const agent = await (await fetch(`${base}/api/v1/agents`, { method: "POST", headers: H, body: JSON.stringify({ name: "E2E agent" }) })).json();
  const agentId = agent.agent?.id ?? agent.id; const agentToken = agent.token;

  const send = launch("e2e-profile");
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  check("extension loads unpacked in real Chrome", Boolean(extId), extId);
  await send("Target.createTarget", { url: `http://127.0.0.1:${PP}/` });
  const inExt = await panelOf(send, extId);
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
  await send("Target.createTarget", { url: `${base}/` }); await sleep(800);
  const dash = await inExt(`const t=(await chrome.tabs.query({})).find(t=>t.url.startsWith("${base}")); return (await chrome.runtime.sendMessage({type:"shareTab", tabId:t.id, site:null}))`);
  check("sharing the Tallylamp dashboard itself is refused", dash.ok === false && /Tallylamp dashboard/.test(dash.error), dash.error);
  const sharedRes = await inExt(`return await chrome.runtime.sendMessage({type:"shareTab", tabId:${tabId}, site:"127.0.0.1"})`);
  check("chrome.debugger attaches and the tab is shared", sharedRes.ok && sharedRes.state.shared.length === 1, sharedRes.error ?? JSON.stringify(sharedRes.state.shared));

  const rpc = (method, params, extra = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "MCP-Protocol-Version": "2025-11-25", ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(90_000) });
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const sess = { "MCP-Session-Id": init.headers.get("mcp-session-id") };
  const call = async (name, args = {}) => { const t = await (await rpc("tools/call", { name, arguments: args }, sess)).text(); const line = t.split("\n").find((l) => l.startsWith("data:")); const m = JSON.parse(line ? line.slice(5) : t); if (m.error) return { err: true, text: m.error.message }; const r = m.result; return { err: Boolean(r.isError), text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n") }; };
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
  // Same hostname as the shared site, so only the server rule stands between the agent and it.
  const toDash = await call("navigate_page", { pageId: 1, url: `${base}/` }); check("navigate_page to the linked server's dashboard is refused", /Tallylamp dashboard/.test(toDash.text), toDash.text);
  await call("evaluate_script", { pageId: 1, function: `() => { location.href = ${JSON.stringify(base + "/")}; }` }); await sleep(1500);
  st = await state(); check("a script that walks a shared tab onto the dashboard gets it handed back", !st.shared.some((t) => t.tabId === tabId) && /dashboard/.test(st.notice ?? ""), `${st.notice} ${JSON.stringify(st.shared.map((t) => t.url))}`);

  await inExt(`await chrome.runtime.sendMessage({type:"stopAll"}); return 1`); await sleep(500);
  const after = await call("list_pages"); check("after Stop, the agent has no pages left", after.err || !after.text.includes(`127.0.0.1:${PP}`), after.text);
  const detached = await inExt(`return (await chrome.debugger.getTargets()).filter(t=>t.attached && t.tabId && !t.url.startsWith("chrome-extension://")).length`);
  check("after Stop, the debugger is detached from every tab", detached === 0, detached);

  // Another extension that frames every page, the way password managers do. Chrome refuses such
  // a tab with "Cannot access a chrome-extension:// URL of different extension".
  const makeFramer = (dir, text) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "E2E framer", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }], web_accessible_resources: [{ resources: ["f.html"], matches: ["<all_urls>"] }] }));
    writeFileSync(path.join(dir, "cs.js"), `const add = () => { const f = document.createElement("iframe"); f.src = chrome.runtime.getURL("f.html"); document.body.append(f); }; location.search.includes("late") ? setTimeout(add, 3000) : add();`);
    // It logs its text too: console output is what an agent's tools collect from every frame.
    writeFileSync(path.join(dir, "f.html"), `<p>${text}</p><script src="f.js"></script>`);
    writeFileSync(path.join(dir, "f.js"), `console.log(${JSON.stringify(text)});`);
    return dir;
  };
  const { id: framerId } = await send("Extensions.loadUnpacked", { path: makeFramer(path.join(OUT, "framer"), "framed") });
  const openTab = async (q) => { await send("Target.createTarget", { url: `http://127.0.0.1:${PP}/?${q}` }); await sleep(1000); return inExt(`return (await chrome.tabs.query({})).find(t=>t.url.endsWith("?${q}")).id`); };
  const framed = await inExt(`return await chrome.runtime.sendMessage({type:"shareTab", tabId:${await openTab("framed")}, site:null})`);
  check("a tab holding another extension's frame is refused, naming that extension", framed.ok === false && /Another extension/.test(framed.error) && framed.state.extensions?.id === framerId, `${framed.error} ${JSON.stringify(framed.state.extensions)}`);
  const late = await inExt(`return await chrome.runtime.sendMessage({type:"shareTab", tabId:${await openTab("late")}, site:null})`);
  check("a tab whose frame arrives later still shares at first", late.ok === true, late.error);
  await sleep(4500); st = await state();
  check("when the frame arrives, sharing stops with a notice that says why", !st.shared.length && /Another extension/.test(st.notice ?? "") && st.extensions?.id === framerId, `${st.notice} ${JSON.stringify(st.extensions)}`);

  // chrome://flags "Extensions on chrome-extension:// URLs" lifts that rule, so Chrome shares the
  // tab and the agent's auto-attach reaches into the other extension's frame. That frame stands
  // in for a password manager's menu here: its text must never reach the agent.
  const send2 = launch("e2e-flagged", ["--extensions-on-extension-urls"]);
  const { id: ext2 } = await send2("Extensions.loadUnpacked", { path: EXT });
  const { id: vaultId } = await send2("Extensions.loadUnpacked", { path: makeFramer(path.join(OUT, "vault"), "Saved login: e2e-vault-secret") });
  const inExt2 = await panelOf(send2, ext2);
  const state2 = () => inExt2(`return (await chrome.runtime.sendMessage({type:"getState"})).state`);
  await inExt2(`await chrome.runtime.sendMessage({type:"startPairing", server:"127.0.0.1:${PORT}"}); return 1`);
  let st2 = await state2();
  await fetch(`${base}/api/v1/links/pair/${st2.pairing.userCode}/approve`, { method: "POST", headers: H, body: JSON.stringify({ agentIds: [agentId], name: "E2E flagged Chrome" }) });
  for (let i = 0; i < 20 && (st2 = await state2()).link !== "online"; i++) await sleep(500);
  const openTab2 = async (q) => { await send2("Target.createTarget", { url: `http://127.0.0.1:${PP}/?${q}` }); await sleep(1000); return inExt2(`return (await chrome.tabs.query({})).find(t=>t.url.endsWith("?${q}")).id`); };
  const vaulted = await inExt2(`return await chrome.runtime.sendMessage({type:"shareTab", tabId:${await openTab2("vault")}, site:null})`);
  check("with the flag on, Chrome lets a tab holding another extension's frame share", st2.link === "online" && vaulted.ok === true, `${st2.link} ${vaulted.error ?? ""}`);
  const listed2 = JSON.parse((await call("tallylamp_list_browsers")).text);
  const used2 = await call("tallylamp_use_browser", { browserId: (listed2.browsers ?? listed2).find((x) => x.kind === "linked" && x.name === "E2E flagged Chrome")?.id });
  const pageOf = async (q) => Number((await call("list_pages")).text.match(new RegExp(`^(\\d+):.*\\?${q}\\b`, "m"))?.[1]);
  const snap2 = await call("take_snapshot", { pageId: await pageOf("vault") });
  check("the agent still reads the page around the frame", !used2.err && !snap2.err && /Hello from a real tab/.test(snap2.text), used2.err ? used2.text : snap2.text);
  check("but not the text inside the other extension's frame", !/e2e-vault-secret/.test(snap2.text), snap2.text);
  // What the agent's tools print is up to them. Whether a debugger session is still inside the
  // other extension's frame is not: that session is the agent reading the frame.
  const inVault = async () => (await send2("Target.getTargets")).targetInfos.filter((t) => t.url.startsWith(`chrome-extension://${vaultId}/`) && t.attached).length;
  check("no debugger session is left inside the other extension's frame", (await inVault()) === 0, await inVault());
  st2 = await state2();
  check("the panel says a flag let the frame through, naming the extension", /flag/.test(st2.notice ?? "") && st2.extensions?.id === vaultId, `${st2.notice} ${JSON.stringify(st2.extensions)}`);
  // Chrome announces a frame that arrives after the agent attached before it has an address.
  const lateShare = await inExt2(`return await chrome.runtime.sendMessage({type:"shareTab", tabId:${await openTab2("late")}, site:null})`);
  await sleep(4500);
  // No snapshot of this page: in 0.8.3 any cross-site frame that arrives after the agent
  // attached hangs take_snapshot for its full timeout, extension or not.
  check("a frame that arrives while the tab is shared is kept out too", lateShare.ok && (await inVault()) === 0, lateShare.error ?? await inVault());
} catch (e) { check("script ran to completion", false, e.stack ?? e); }
finally { for (const c of chromes) c.kill("SIGKILL"); svc.kill("SIGTERM"); pages.close(); }
log(failed ? `\n${failed} FAILED` : "\nALL PASSED"); await sleep(300); process.exit(failed ? 1 : 0);
