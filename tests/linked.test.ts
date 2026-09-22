import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { CdpClient, browserWsUrl, listPages } from "../src/cdp.js";
import { resetRateLimits } from "../src/rate-limit.js";
import { getDb, resetDbForTests } from "../src/db.js";
import { dbPath } from "../src/config.js";
import { linkedAccess } from "../src/linked.js";
import { hub } from "../src/events.js";
import { candidates, requestBrowser } from "../src/lending.js";

let ctx: TestCtx;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  json(`${ctx.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

type Call = { method: string; params: Record<string, unknown> };

/**
 * A scripted stand-in for the extension. It answers the way chrome.debugger would for the
 * handful of methods Puppeteer needs to believe a page exists, and records every call, so a
 * test can assert on what the server actually asked the person's browser to do.
 */
class FakeExtension {
  readonly calls: Call[] = [];
  readonly tabs = new Map<number, { targetId: string; url: string; title: string }>();
  closed: Promise<number>;
  private nextTab = 100;

  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((r) => ws.once("close", (code) => r(code)));
    ws.on("message", (raw) => this.onMessage(JSON.parse(String(raw))));
  }

  static async connect(token: string, tabs: Array<[number, string, string]> = []): Promise<FakeExtension> {
    const ws = new WebSocket(`${ctx.url.replace("http", "ws")}/api/v1/links/connect`);
    await new Promise<void>((resolve, reject) => ws.once("open", () => resolve()).once("error", reject));
    const ext = new FakeExtension(ws);
    for (const [tabId, url, title] of tabs) ext.tabs.set(tabId, { targetId: `TARGET${tabId}`, url, title });
    const welcomed = new Promise<boolean>((resolve) => {
      ws.on("message", (raw) => JSON.parse(String(raw)).event === "welcome" && resolve(true));
      ws.once("close", () => resolve(false));
    });
    ws.send(JSON.stringify({ event: "hello", token, product: "Chrome/140.0.0.0", userAgent: "Mozilla/5.0 Test", tabs: [...ext.tabs].map(([tabId, t]) => ext.wire(tabId, t)) }));
    if (!(await welcomed)) throw new Error("rejected");
    return ext;
  }

  private wire(tabId: number, t: { targetId: string; url: string; title: string }) {
    return { tabId, info: { targetId: t.targetId, type: "page", url: t.url, title: t.title, browserContextId: "CTX" } };
  }

  emit(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  share(tabId: number, url: string, title: string): void {
    const t = { targetId: `TARGET${tabId}`, url, title };
    this.tabs.set(tabId, t);
    this.emit({ event: "tab.shared", tab: this.wire(tabId, t) });
  }

  unshare(tabId: number, reason = "stopped by the person"): void {
    this.tabs.delete(tabId);
    this.emit({ event: "tab.unshared", tabId, reason });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(msg: { id?: number; method?: string; params?: Record<string, unknown> }): void {
    if (typeof msg.id !== "number" || !msg.method) return;
    const params = msg.params ?? {};
    this.calls.push({ method: msg.method === "cdp" ? `cdp:${String(params.method)}` : msg.method, params });
    const reply = (result: unknown) => this.emit({ id: msg.id, result });
    if (msg.method === "tabs.create") {
      const tabId = this.nextTab++;
      // Shared BEFORE the reply: the server resolves the new target from its tab map.
      this.share(tabId, String(params.url), "New tab");
      return reply({ tabId });
    }
    if (msg.method === "tabs.close") {
      this.unshare(Number(params.tabId), "closed");
      return reply({});
    }
    if (msg.method === "unshare.all") {
      for (const tabId of [...this.tabs.keys()]) this.unshare(tabId, String(params.reason));
      return reply({});
    }
    if (msg.method === "window.get") return reply({ windowId: 7, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" } });
    if (msg.method !== "cdp") return this.emit({ id: msg.id, error: `unknown method ${msg.method}` });
    const tab = this.tabs.get(Number(params.tabId));
    if (!tab) return this.emit({ id: msg.id, error: "tab is not shared" });
    const frame = { id: tab.targetId, loaderId: "L1", url: tab.url, domainAndRegistry: "", securityOrigin: new URL(tab.url).origin, mimeType: "text/html", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] };
    switch (params.method) {
      case "Page.getFrameTree":
        return reply({ frameTree: { frame } });
      case "Page.addScriptToEvaluateOnNewDocument":
        return reply({ identifier: "1" });
      case "Page.createIsolatedWorld":
        return reply({ executionContextId: 2 });
      case "Page.getNavigationHistory":
        return reply({ currentIndex: 0, entries: [{ id: 1, url: tab.url, userTypedURL: tab.url, title: tab.title, transitionType: "typed" }] });
      case "Page.captureScreenshot":
        return reply({ data: Buffer.from("jpeg-bytes").toString("base64") });
      case "Target.getTargetInfo":
        return reply({ targetInfo: { targetId: tab.targetId, type: "page", url: tab.url, title: tab.title, attached: true } });
      default:
        return reply({});
    }
  }
}

async function pair(access: { agentIds?: string[]; anyAgent?: boolean } = {}, name = "Work laptop"): Promise<{ token: string; browserId: string; userCode: string }> {
  // Starting a pairing is limited to a burst of five per address, and this file is one address.
  resetRateLimits();
  const started = await post("/api/v1/links/pair", { deviceName: name });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { deviceCode, userCode } = started.body as { deviceCode: string; userCode: string };
  const approved = await post(`/api/v1/links/pair/${userCode}/approve`, access, { Cookie: ctx.cookie, Origin: ctx.url });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  const polled = await post("/api/v1/links/pair/poll", { deviceCode });
  const body = polled.body as { state: string; token: string; browserId: string };
  assert.equal(body.state, "approved");
  return { token: body.token, browserId: body.browserId, userCode };
}

const view = async (id: string) =>
  ((await json(`${ctx.url}/api/v1/browsers/${id}`, { headers: { Cookie: ctx.cookie } })).body as { browser: Record<string, any> }).browser;

describe("linked browsers", () => {
  before(async () => { ctx = await startTestServer(); });
  after(async () => ctx.close());

  it("pairs by device flow: the code opens nothing, approval is admin-only, the token is collected once", async () => {
    const started = await post("/api/v1/links/pair", { deviceName: "Rafael's Brave" });
    assert.equal(started.headers.get("access-control-allow-origin"), "*");
    const { deviceCode, userCode } = started.body as { deviceCode: string; userCode: string };
    assert.match(userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    assert.deepEqual((await post("/api/v1/links/pair/poll", { deviceCode })).body, { state: "pending" });
    // The user code is what gets read aloud and typed. It must not work as the device secret.
    assert.deepEqual((await post("/api/v1/links/pair/poll", { deviceCode: userCode })).body, { state: "expired" });

    assert.equal((await post(`/api/v1/links/pair/${userCode}/approve`, {})).status, 401);
    const asAgent = await post(`/api/v1/links/pair/${userCode}/approve`, {}, { Authorization: `Bearer ${ctx.agentToken}` });
    assert.equal(asAgent.status, 403);

    // Typed sloppily, as people do.
    const sloppy = userCode.toLowerCase().replace("-", " ");
    const seen = await json(`${ctx.url}/api/v1/links/pair/${encodeURIComponent(sloppy)}`, { headers: { Cookie: ctx.cookie } });
    assert.equal((seen.body as { pairing: { deviceName: string } }).pairing.deviceName, "Rafael's Brave");

    const approved = await post(`/api/v1/links/pair/${userCode}/approve`, {}, { Cookie: ctx.cookie, Origin: ctx.url });
    assert.equal(approved.status, 201);
    assert.equal((await post(`/api/v1/links/pair/${userCode}/approve`, {}, { Cookie: ctx.cookie, Origin: ctx.url })).status, 409);

    const first = (await post("/api/v1/links/pair/poll", { deviceCode })).body as { state: string; token: string };
    assert.equal(first.state, "approved");
    assert.match(first.token, /^tl_ln_/);
    assert.deepEqual((await post("/api/v1/links/pair/poll", { deviceCode })).body, { state: "expired" });
    // A link token is for the link socket and nothing else.
    assert.equal((await json(`${ctx.url}/api/v1/browsers`, { headers: { Authorization: `Bearer ${first.token}` } })).status, 401);
  });

  it("a denied pairing tells the extension so", async () => {
    const { deviceCode, userCode } = (await post("/api/v1/links/pair", {})).body as { deviceCode: string; userCode: string };
    await post(`/api/v1/links/pair/${userCode}/deny`, {}, { Cookie: ctx.cookie, Origin: ctx.url });
    assert.deepEqual((await post("/api/v1/links/pair/poll", { deviceCode })).body, { state: "denied" });
  });

  it("is offline, not crashed, until its extension dials in; then shows what is shared", async () => {
    const { token, browserId } = await pair();
    let b = await view(browserId);
    assert.equal(b.kind, "linked");
    assert.equal(b.link.online, false);
    await assert.rejects(ctx.browsers.ensureRunning(browserId), /linked browser and it is offline.*Tallylamp extension/);
    assert.equal((await view(browserId)).status, "stopped");

    await assert.rejects(FakeExtension.connect("tl_ln_not-a-real-token"), /rejected/);

    const ext = await FakeExtension.connect(token, [[1, "https://example.test/inbox", "Inbox"]]);
    b = await view(browserId);
    assert.equal(b.link.online, true);
    assert.deepEqual(b.link.sharedTabs, [{ url: "https://example.test/inbox", title: "Inbox" }]);
    assert.equal(JSON.stringify(b).includes("token"), false, "the link view must never carry token material");

    const rt = await ctx.browsers.ensureRunning(browserId);
    const pages = await listPages(rt.cdpUrl);
    assert.deepEqual(pages.map((p) => [p.url, p.webSocketDebuggerUrl]), [["https://example.test/inbox", undefined]]);

    ext.close();
    await ext.closed;
    await sleep(50);
    b = await view(browserId);
    assert.equal(b.status, "stopped");
    assert.equal(b.link.online, false);
  });

  it("refuses what needs a Chrome it launched, and does not count against the fleet cap", async () => {
    const { token, browserId } = await pair();
    const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
    for (const attempt of [
      () => ctx.browsers.setLendable(browserId, true, admin),
      () => ctx.browsers.updateProxy(browserId, { server: "http://proxy.test:8080" }, admin),
      () => ctx.browsers.updateExtensions(browserId, true, admin),
    ]) assert.throws(attempt, /not available on a linked browser/);
    await assert.rejects(ctx.browsers.saveProfile(browserId, admin), /not available on a linked browser/);
    const tunnel = await post(`/api/v1/browsers/${browserId}/tunnels`, { port: 3000 }, { Cookie: ctx.cookie, Origin: ctx.url });
    assert.match(JSON.stringify(tunnel.body), /not available on a linked browser/);

    const ext = await FakeExtension.connect(token, [[1, "https://example.test/", "Example"]]);
    await ctx.browsers.ensureRunning(browserId);
    const managed = [];
    // TALLYLAMP_MAX_BROWSERS is 4 in the harness. All four still start beside the linked one.
    for (let i = 0; i < 4; i++) {
      const row = ctx.browsers.create({ principal: admin, via: "dashboard", name: `managed-${i}` });
      await ctx.browsers.ensureRunning(row.id);
      managed.push(row.id);
    }
    for (const id of managed) await ctx.browsers.destroy(id, admin);
    ext.close();
    await ext.closed;
  });

  it("gives each CDP client its own session on one shared attachment, and tears down on unshare", async () => {
    const { token, browserId } = await pair();
    const ext = await FakeExtension.connect(token, [[1, "https://example.test/a", "A"]]);
    const rt = await ctx.browsers.ensureRunning(browserId);
    const wsUrl = await browserWsUrl(rt.cdpUrl);

    const open = async () => {
      const events: Array<{ method: string; sessionId?: string; params: Record<string, unknown> }> = [];
      const cdp = new CdpClient(wsUrl);
      cdp.onEvent = (method, params, sessionId) => events.push({ method, params, sessionId });
      await cdp.connect();
      return { cdp, events };
    };
    const a = await open();
    const b = await open();

    // The viewer's path: no `tab` targets unless a filter asks for them.
    const { targetInfos } = (await a.cdp.send("Target.getTargets")) as { targetInfos: Array<{ type: string; targetId: string }> };
    assert.deepEqual(targetInfos.map((t) => [t.type, t.targetId]), [["page", "TARGET1"]]);
    const sa = ((await a.cdp.send("Target.attachToTarget", { targetId: "TARGET1", flatten: true })) as { sessionId: string }).sessionId;
    const sb = ((await b.cdp.send("Target.attachToTarget", { targetId: "TARGET1", flatten: true })) as { sessionId: string }).sessionId;
    assert.notEqual(sa, sb);

    await a.cdp.send("Page.enable", {}, sa);
    assert.deepEqual(ext.calls.at(-1), { method: "cdp:Page.enable", params: { tabId: 1, method: "Page.enable", params: {} } });

    ext.emit({ event: "cdp", tabId: 1, method: "Page.loadEventFired", params: { timestamp: 1 } });
    // A frame that arrived for a tab nobody shared is dropped, not routed.
    ext.emit({ event: "cdp", tabId: 999, method: "Page.loadEventFired", params: { timestamp: 2 } });
    await sleep(50);
    assert.deepEqual(a.events.filter((e) => e.method === "Page.loadEventFired").map((e) => e.sessionId), [sa]);
    assert.deepEqual(b.events.filter((e) => e.method === "Page.loadEventFired").map((e) => e.sessionId), [sb]);

    // A person's own window: never closed, never resized, on the agent's say-so.
    await assert.rejects(a.cdp.send("Browser.close"), /not available on a linked browser/);
    await assert.rejects(a.cdp.send("Browser.setWindowBounds", { windowId: 7, bounds: { width: 400 } }, sa), /Use emulate/);
    assert.equal(((await a.cdp.send("Browser.getWindowForTarget", {}, sa)) as { windowId: number }).windowId, 7);
    assert.equal(ext.calls.some((c) => c.method.startsWith("cdp:Browser.")), false);

    ext.unshare(1);
    await sleep(50);
    assert.deepEqual(a.events.filter((e) => e.method === "Target.detachedFromTarget").map((e) => e.params.sessionId), [sa]);
    await assert.rejects(a.cdp.send("Page.reload", {}, sa), /no session with that id/);
    await assert.rejects(a.cdp.send("Target.attachToTarget", { targetId: "TARGET1" }), /not shared with Tallylamp/);

    await a.cdp.close();
    await b.cdp.close();
    ext.close();
    await ext.closed;
  });

  it("announces the page a shared tab is showing once per change, not once per poll", async () => {
    const { token, browserId } = await pair();
    const ext = await FakeExtension.connect(token, [[1, "https://example.test/a", "A"]]);
    const seen: string[] = [];
    const onEvent = (ev: { type: string; browserId?: string; payload: { url?: string } }) => {
      if (ev.type === "browser.url_changed" && ev.browserId === browserId) seen.push(String(ev.payload.url));
    };
    hub.on("event", onEvent);
    try {
      await ctx.browsers.ensureRunning(browserId);
      for (let i = 0; i < 3; i++) await ctx.browsers.refreshPageInfo(browserId);
      await sleep(50);
      // Starting reports the page once. Polling it again while nothing moved reports nothing.
      assert.deepEqual(seen, ["https://example.test/a"]);
      ext.emit({ event: "tab.updated", tabId: 1, url: "https://example.test/b", title: "B" });
      await sleep(50);
      for (let i = 0; i < 3; i++) await ctx.browsers.refreshPageInfo(browserId);
      assert.deepEqual(seen, ["https://example.test/a", "https://example.test/b"]);
      const row = getDb().prepare("SELECT current_url FROM browsers WHERE id = ?").get(browserId) as { current_url: string };
      assert.equal(row.current_url, "https://example.test/b");
    } finally {
      hub.off("event", onEvent);
    }
    ext.close();
    await ext.closed;
  });

  it("turns the domains a client enabled back off once the last client has gone", async () => {
    const { token, browserId } = await pair();
    const ext = await FakeExtension.connect(token, [[1, "https://example.test/a", "A"]]);
    const rt = await ctx.browsers.ensureRunning(browserId);
    const wsUrl = await browserWsUrl(rt.cdpUrl);

    const open = async () => {
      const cdp = new CdpClient(wsUrl);
      await cdp.connect();
      const sid = ((await cdp.send("Target.attachToTarget", { targetId: "TARGET1", flatten: true })) as { sessionId: string }).sessionId;
      return { cdp, sid };
    };
    const a = await open();
    const b = await open();

    await a.cdp.send("Network.enable", {}, a.sid);
    await a.cdp.send("Page.enable", {}, a.sid);
    await a.cdp.send("Runtime.enable", {}, a.sid);
    await a.cdp.send("Runtime.disable", {}, a.sid);
    const disables = () => ext.calls.filter((c) => c.method.endsWith(".disable")).map((c) => c.method);
    assert.deepEqual(disables(), ["cdp:Runtime.disable"]);

    // One client leaving proves nothing. The debugger attachment is shared, so turning a domain
    // off here would take the other client's events with it.
    await a.cdp.close();
    await sleep(50);
    assert.deepEqual(disables(), ["cdp:Runtime.disable"]);

    await b.cdp.close();
    await sleep(50);
    // Runtime is not turned off twice: the client that enabled it had already disabled it.
    assert.deepEqual(disables().slice(1).sort(), ["cdp:Network.disable", "cdp:Page.disable"]);

    ext.close();
    await ext.closed;
  });

  it("drives a shared tab through the real chrome-devtools-mcp bridge", async () => {
    const owner = createAgent({ name: "Linked driver", scopes: [...DEFAULT_AGENT_SCOPES], maxBrowsers: 1 });
    const { token, browserId } = await pair({ agentIds: [owner.agent.id] }, "Driver's Chrome");
    const ext = await FakeExtension.connect(token, [[1, "https://example.test/dashboard", "Dashboard"]]);

    const rpc = (method: string, params: unknown, extra: Record<string, string> = {}) =>
      json(`${ctx.url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25", ...extra },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "linked-test", version: "1" } });
    const session = { "MCP-Session-Id": init.headers.get("mcp-session-id")! };
    const call = async (name: string, args = {}) => {
      const res = await rpc("tools/call", { name, arguments: args }, session);
      const line = String(res.body).split("\n").find((l) => l.trim().startsWith("data:"));
      const result = (typeof res.body === "object" && res.body ? (res.body as any).result : JSON.parse(line!.trim().slice(5)).result) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: Boolean(result.isError), text: result.content.map((c) => c.text).join("\n") };
    };

    const listed = await call("tallylamp_list_browsers");
    assert.match(listed.text, /Driver's Chrome/);
    assert.match(listed.text, /"kind":\s*"linked"/);

    const used = await call("tallylamp_use_browser", { browserId });
    assert.equal(used.isError, false, used.text);

    // Puppeteer's connect() has to complete against the shim for this to return at all: it
    // blocks until every announced target is attached, which is the tab -> page handshake.
    const pages = await call("list_pages");
    assert.equal(pages.isError, false, pages.text);
    assert.match(pages.text, /example\.test\/dashboard/);
    assert.ok(ext.calls.some((c) => c.method === "cdp:Page.getFrameTree"), "Puppeteer never reached the page session");

    // Puppeteer opens about:blank and then navigates. The scripted peer fires no load events,
    // so the tool itself reports a navigation timeout; what matters here is what the person's
    // browser was asked to do, and that the new tab was shared and driven, not the old one.
    const opened = await call("new_page", { url: "https://example.test/new", timeout: 1500 });
    assert.ok(ext.calls.some((c) => c.method === "tabs.create"), opened.text);
    const navigated = ext.calls.find((c) => c.method === "cdp:Page.navigate");
    assert.equal(navigated?.params.tabId, 100, opened.text);
    assert.equal((navigated?.params.params as { url: string }).url, "https://example.test/new");

    // Stopping from Tallylamp hands every tab back, so Chrome's debugging bar comes down.
    await call("tallylamp_stop_browser", { browserId });
    assert.ok(ext.calls.some((c) => c.method === "unshare.all"));
    assert.equal(ext.tabs.size, 0);
    ext.close();
    await ext.closed;
  });

  it("lets only the ticked agents in, any agent when chosen, and never lets an agent lend it or change the list", async () => {
    const withBorrow = [...DEFAULT_AGENT_SCOPES, "browser:borrow", "browser:lend"];
    const a = createAgent({ name: "Ticked", scopes: withBorrow });
    const b = createAgent({ name: "Also ticked" });
    const c = createAgent({ name: "Not ticked", scopes: withBorrow });
    const { browserId } = await pair({ agentIds: [a.agent.id, b.agent.id] });
    const row = () => ctx.browsers.row(browserId);
    // Owned by the administrator: the agents are on a list beside it, not its owners.
    assert.equal(row().owner_type, "admin");
    ctx.browsers.assertAccess(a.agent, row(), "control");
    ctx.browsers.assertAccess(b.agent, row(), "read");
    assert.throws(() => ctx.browsers.assertAccess(c.agent, row(), "control"), /has not been shared with this agent/);
    assert.throws(() => ctx.browsers.assertAccess(a.agent, row(), "delete"), /only the administrator can delete/);
    assert.ok(ctx.browsers.listVisible(a.agent).some((r) => r.id === browserId));
    assert.ok(!ctx.browsers.listVisible(c.agent).some((r) => r.id === browserId));

    // Nobody lends a person's own browser: not by asking, not as a candidate, not by answering.
    const asked = requestBrowser(ctx.browsers, c.agent, { browserId });
    assert.equal(asked.state, "unavailable");
    assert.match((asked as { reason: string }).reason, /person's own browser/);
    assert.ok(!candidates(ctx.browsers, c.agent).some((r) => r.id === browserId));

    const put = (body: unknown, headers: Record<string, string>) =>
      json(`${ctx.url}/api/v1/browsers/${browserId}/access`, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const admin = { Cookie: ctx.cookie, Origin: ctx.url };
    assert.equal((await put({ anyAgent: true }, { Authorization: `Bearer ${a.token}` })).status, 403, "an agent cannot widen its own access");

    const any = await put({ anyAgent: true }, admin);
    assert.deepEqual((any.body as { access: unknown }).access, { anyAgent: true, agentIds: [] });
    ctx.browsers.assertAccess(c.agent, row(), "control");
    // Any agent includes agents that did not exist when it was chosen.
    const later = createAgent({ name: "Connected later" });
    assert.ok(ctx.browsers.listVisible(later.agent).some((r) => r.id === browserId));

    await put({ agentIds: [b.agent.id] }, admin);
    assert.throws(() => ctx.browsers.assertAccess(a.agent, row(), "control"), /has not been shared/);
    ctx.browsers.assertAccess(b.agent, row(), "control");
    assert.equal((await put({ agentIds: ["agt_does_not_exist"] }, admin)).status, 404);
    assert.deepEqual(linkedAccess(browserId), { anyAgent: false, agentIds: [b.agent.id] }, "a refused change leaves the list as it was");
  });

  it("moves a 0.6.0 linked browser from its agent owner to the administrator, keeping that agent's access", async () => {
    const legacy = createAgent({ name: "Picked in 0.6.0" });
    const { browserId } = await pair();
    getDb().prepare(`UPDATE browsers SET owner_type = 'agent', owner_id = ? WHERE id = ?`).run(legacy.agent.id, browserId);
    getDb().prepare(`DELETE FROM linked_access WHERE browser_id = ?`).run(browserId);
    resetDbForTests(dbPath());
    assert.equal(ctx.browsers.row(browserId).owner_type, "admin");
    assert.deepEqual(linkedAccess(browserId), { anyAgent: false, agentIds: [legacy.agent.id] });
    ctx.browsers.assertAccess(legacy.agent, ctx.browsers.row(browserId), "control");
  });

  it("cuts a live MCP session when its agent is taken off the list", async () => {
    const agent = createAgent({ name: "About to lose it", scopes: [...DEFAULT_AGENT_SCOPES] });
    const { token, browserId } = await pair({ agentIds: [agent.agent.id] }, "Revocable");
    const ext = await FakeExtension.connect(token, [[1, "https://example.test/", "Example"]]);
    const rpc = (method: string, params: unknown, extra: Record<string, string> = {}) =>
      json(`${ctx.url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${agent.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25", ...extra },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "linked-revoke", version: "1" } });
    const session = { "MCP-Session-Id": init.headers.get("mcp-session-id")! };
    const call = async (name: string, args = {}) => {
      const res = await rpc("tools/call", { name, arguments: args }, session);
      const line = String(res.body).split("\n").find((l) => l.trim().startsWith("data:"));
      const result = (typeof res.body === "object" && res.body ? (res.body as any).result : JSON.parse(line!.trim().slice(5)).result) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: Boolean(result.isError), text: result.content.map((c) => c.text).join("\n") };
    };
    assert.equal((await call("tallylamp_use_browser", { browserId })).isError, false);
    assert.equal((await call("list_pages")).isError, false);

    const cut = await json(`${ctx.url}/api/v1/browsers/${browserId}/access`, {
      method: "PUT", headers: { "Content-Type": "application/json", Cookie: ctx.cookie, Origin: ctx.url }, body: JSON.stringify({ agentIds: [] }),
    });
    assert.equal(cut.status, 200);
    const after = await call("list_pages");
    assert.equal(after.isError, true, after.text);
    assert.match(after.text, /No browser is bound/);
    ext.close();
    await ext.closed;
  });

  it("revoking the link, or deleting the browser, cuts the socket and kills the token", async () => {
    const { token, browserId } = await pair();
    const ext = await FakeExtension.connect(token);
    const revoked = await json(`${ctx.url}/api/v1/browsers/${browserId}/link`, { method: "DELETE", headers: { Cookie: ctx.cookie, Origin: ctx.url } });
    assert.equal(revoked.status, 200);
    await ext.closed;
    await assert.rejects(FakeExtension.connect(token), /rejected/);
    assert.equal((await view(browserId)).link, null);

    const second = await pair();
    const ext2 = await FakeExtension.connect(second.token);
    await json(`${ctx.url}/api/v1/browsers/${second.browserId}`, { method: "DELETE", headers: { Cookie: ctx.cookie, Origin: ctx.url } });
    await ext2.closed;
    await assert.rejects(FakeExtension.connect(second.token), /rejected/);
  });
});
