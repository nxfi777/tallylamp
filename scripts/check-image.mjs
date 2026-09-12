// Run only against a disposable deployment. This creates and revokes a test agent.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const base = process.env.TALLYLAMP_TEST_URL?.replace(/\/$/, "");
const secret = process.env.TALLYLAMP_TEST_SECRET;
assert.ok(base && secret, "Set TALLYLAMP_TEST_URL and TALLYLAMP_TEST_SECRET for a disposable deployment");
let cookie = "";
let token = "";
let session = "";
let browserId;
let agentId;
const cloneIds = [];
let sequence = 0;

async function request(path, { method = "GET", body, agent = false, anonymous = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (!anonymous) {
    if (agent) headers.Authorization = `Bearer ${token}`;
    else if (cookie) headers.Cookie = cookie;
  }
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data };
}

async function rpc(method, params) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream",
      "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25",
      ...(session ? { "MCP-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200, `MCP ${method} HTTP status`);
  session = response.headers.get("mcp-session-id") || session;
  const text = await response.text();
  const message = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(m => m.id === sequence)
    : JSON.parse(text);
  assert.ok(message && !message.error, `MCP ${method}: ${JSON.stringify(message?.error)}`);
  return message.result;
}

async function tool(name, args = {}, allowError = false) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (!allowError) assert.ok(!result.isError, `Tool ${name}: ${JSON.stringify(result.content)}`);
  return result;
}

function examplePageId(result) {
  const listing = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const pageId = Number(listing.match(/(?:^|\n)(\d+):[^\n]*https:\/\/example\.com(?:\/|\))/m)?.[1]);
  assert.ok(Number.isFinite(pageId), `Expected example.com in page listing: ${listing}`);
  return pageId;
}

for (let attempt = 0; ; attempt++) {
  try {
    assert.equal((await request("/healthz", { anonymous: true })).response.status, 200);
    break;
  } catch (error) {
    if (attempt >= 59) throw error;
    await delay(1000);
  }
}
assert.equal((await request("/api/v1/browsers", { anonymous: true })).response.status, 401);
assert.equal((await request("/mcp", { anonymous: true })).response.status, 401);
const login = await request("/api/v1/login", { method: "POST", body: { secret } });
assert.equal(login.response.status, 200);
cookie = login.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
const discovery = await request("/.well-known/oauth-protected-resource", { anonymous: true });
assert.equal(discovery.data.resource, base + "/mcp");

try {
  const created = await request("/api/v1/agents", { method: "POST", body: { name: "Release validation", maxBrowsers: 4,
    scopes: ["browser:create", "browser:list:own", "browser:read:own", "browser:start:own", "browser:stop:own", "browser:delete:own", "browser:control:own", "seed:use"] } });
  assert.equal(created.response.status, 201);
  token = created.data.token;
  agentId = created.data.agent.id;
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tallylamp-release-check", version: "0.1.0" } });
  const browser = await tool("tallylamp_create_browser", { name: "Release validation", persistent: true });
  browserId = JSON.parse(browser.content.find(c => c.type === "text").text).browserId;
  assert.ok(browserId);
  const page = await tool("new_page", { url: "https://example.com" });
  const pageId = examplePageId(page);
  const ua = await tool("evaluate_script", { pageId, function: "() => ({ua: navigator.userAgent, webdriver: navigator.webdriver})" });
  const surface = JSON.stringify(ua.content);
  assert.ok(!surface.includes("HeadlessChrome"), "Chrome must be headed");
  console.log("PASS: login, authentication, OAuth metadata, MCP, real Chrome navigation");

  const ticket = await request(`/api/v1/browsers/${browserId}/viewer-ticket`, { method: "POST", body: { mode: "watch" } });
  assert.equal(ticket.response.status, 200);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + `/api/v1/browsers/${browserId}/view?ticket=${ticket.data.ticket}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("No viewer frame within 30 seconds")); }, 30_000);
    ws.on("error", error => { clearTimeout(timer); reject(error); });
    ws.on("message", (data, binary) => {
      if (binary && data.length > 100) { clearTimeout(timer); ws.close(); resolve(); }
    });
  });
  assert.equal((await request(`/api/v1/browsers/${browserId}/control`, { method: "POST", body: { force: true } })).response.status, 200);
  const blocked = await tool("navigate_page", { pageId, url: "https://example.com" }, true);
  assert.equal(blocked.isError, true, "Human control must block agent mutations");
  assert.equal((await request(`/api/v1/browsers/${browserId}/control`, { method: "DELETE" })).response.status, 200);
  await tool("navigate_page", { pageId, url: "https://example.com" });
  console.log("PASS: live viewer frames, takeover blocks mutations, agent resumes");

  await tool("evaluate_script", { pageId, function: "() => { localStorage.setItem('release-check', 'saved'); document.cookie = 'release_check=saved; Max-Age=86400; Secure; SameSite=Lax'; return true; }" });
  await tool("tallylamp_stop_browser", { browserId });
  await tool("tallylamp_use_browser", { browserId });
  const restartedPageId = examplePageId(await tool("new_page", { url: "https://example.com" }));
  const saved = await tool("evaluate_script", { pageId: restartedPageId, function: "() => ({stored: localStorage.getItem('release-check'), cookie: document.cookie})" });
  const stored = saved.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.ok(/"stored":\s*"saved"/.test(stored) && stored.includes('release_check=saved'), `Profile data was lost on stop: ${stored}`);
  console.log("PASS: cookies and local storage survive an immediate browser stop/start");

  await tool("evaluate_script", { pageId: restartedPageId, function: "() => { document.cookie = 'release_session=saved; Path=/; Secure; SameSite=Lax'; return true; }" });
  const snapshot = await request("/api/v1/seeds", { method: "POST", body: { browserId, name: "Reusable release profile", metadata: { project: "release-check", purpose: "Independent copies" } } });
  assert.equal(snapshot.response.status, 201, JSON.stringify(snapshot.data));
  assert.equal(snapshot.data.seed.resumed, true, "Save profile must resume its running source");
  const seedId = snapshot.data.seed.id;
  await tool("tallylamp_stop_browser", { browserId });
  const checkState = async (expected) => {
    const pageId = examplePageId(await tool("list_pages"));
    const result = await tool("evaluate_script", { pageId, function: "() => ({stored: localStorage.getItem('release-check'), session: document.cookie.includes('release_session=saved'), persistent: document.cookie.includes('release_check=saved')})" });
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.ok(new RegExp(`\"stored\":\\s*\"${expected}\"`).test(text) && /"session":\s*true/.test(text) && /"persistent":\s*true/.test(text), text);
    return pageId;
  };
  for (const name of ["First independent copy", "Second independent copy"]) {
    const copy = await tool("tallylamp_create_browser", { name, seedId, persistent: true });
    const id = JSON.parse(copy.content.find(c => c.type === "text").text).browserId;
    cloneIds.push(id);
    const detail = await request(`/api/v1/browsers/${id}`);
    assert.equal(detail.data.browser.metadata.project, "release-check");
    await checkState("saved");
  }
  await tool("tallylamp_use_browser", { browserId: cloneIds[0] });
  const firstPage = await checkState("saved");
  await tool("evaluate_script", { pageId: firstPage, function: "() => { localStorage.setItem('release-check', 'updated'); return true; }" });
  const updated = await request(`/api/v1/seeds/${seedId}`, { method: "PUT", body: { browserId: cloneIds[0], name: "Updated release profile", metadata: { project: "release-check" } } });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.seed.resumed, true);
  await tool("tallylamp_stop_browser", { browserId: cloneIds[0] });
  await tool("tallylamp_use_browser", { browserId: cloneIds[1] });
  await checkState("saved");
  const newest = await tool("tallylamp_create_browser", { name: "Copy after update", seedId, persistent: true });
  cloneIds.push(JSON.parse(newest.content.find(c => c.type === "text").text).browserId);
  await checkState("updated");
  console.log("PASS: Save profile pauses/resumes real Chrome, clones cookies and metadata into independent browsers, and updates future copies only");
} finally {
  for (const id of cloneIds) await request(`/api/v1/browsers/${id}`, { method: "DELETE" });
  if (browserId) await request(`/api/v1/browsers/${browserId}`, { method: "DELETE" });
  if (agentId) {
    await request(`/api/v1/agents/${agentId}`, { method: "PATCH", body: { enabled: false } });
    assert.equal((await request("/api/v1/browsers", { agent: true })).response.status, 401);
    console.log("PASS: revoked agent is denied access");
  }
}
