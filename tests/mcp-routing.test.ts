import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserRow } from "../src/browsers.js";
import { adminPrincipal, createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { answerRequest, requestBrowser, revokeGrant } from "../src/lending.js";
import { createTunnel } from "../src/tunnels.js";
import { startTestServer, json, type TestCtx } from "./helpers.js";

type Result = { isError?: boolean; content: Array<{ text?: string }>; tools?: Tool[] };
type Binding = { browserId: string; closed: boolean; child?: { client: Client } };
type Session = { browserId?: string; bindings: Map<string, Binding> };
type Gateway = { sessions: Map<string, Session>; startBinding(session: Session, binding: Binding, row: BrowserRow): Promise<void> };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const text = (result: Result) => result.content.map((item) => item.text ?? "").join("\n");
const ok = (result: Result) => { assert.ok(!result.isError, text(result)); return result; };

describe("MCP browser routing", { timeout: 10_000 }, () => {
  let ctx: TestCtx;
  let gateway: Gateway;
  let agent: ReturnType<typeof createAgent>;
  let session: string;
  let a: string;
  let b: string;
  let requestId: number;
  let calls: Array<{ browserId: string; name: string; args: Record<string, unknown> }>;
  let closes: string[];
  let onCall: (browserId: string, name: string) => Promise<void>;

  async function rpc(method: string, params: unknown, sid?: string) {
    const response = await json(`${ctx.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent.token}`, Accept: "application/json, text/event-stream",
        "Content-Type": "application/json", ...(sid ? { "MCP-Session-Id": sid } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const envelope = typeof response.body === "string"
      ? JSON.parse(response.body.split("\n").find((line) => line.startsWith("data:"))!.slice(5))
      : response.body;
    assert.ok(!envelope.error, JSON.stringify(envelope));
    return { result: envelope.result as Result, session: response.headers.get("mcp-session-id")! };
  }
  const open = async () => (await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "routing-test", version: "1" },
  })).session;
  const call = async (name: string, args: Record<string, unknown> = {}, sid = session) =>
    (await rpc("tools/call", { name, arguments: args }, sid)).result;
  const attached = (id: string) => ctx.browsers.publicView(ctx.browsers.row(id)).mcpAttached;

  beforeEach(async () => {
    ctx = await startTestServer();
    gateway = ctx.mcp as unknown as Gateway;
    agent = createAgent({ name: "Shared connection", maxBrowsers: 3, scopes: [...DEFAULT_AGENT_SCOPES, "browser:tunnel"] });
    a = ctx.browsers.create({ principal: agent.agent, via: "mcp", name: "A" }).id;
    b = ctx.browsers.create({ principal: agent.agent, via: "mcp", name: "B" }).id;
    requestId = 0; calls = []; closes = []; onCall = async () => {};
    // Keep real routing, permission checks, startup coalescing and fake Chrome lifecycle.
    // Only replace the absent fake-Chrome bridge, so assertions observe actual dispatch.
    const start = gateway.startBinding.bind(ctx.mcp);
    gateway.startBinding = async (s, binding, row) => {
      await start(s, binding, row);
      binding.child = { client: {
        close: async () => { closes.push(row.id); },
        callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
          calls.push({ browserId: row.id, name, args });
          await onCall(row.id, name);
          return { content: [{ type: "text", text: row.id }] };
        },
      } as unknown as Client };
    };
    session = await open();
  });
  afterEach(async () => { await ctx.close(); });

  it("advertises browserId without dropping the upstream tool schema", async () => {
    const { result } = await rpc("tools/list", {}, session);
    for (const name of ["navigate_page", "take_snapshot", "tallylamp_select_page", "tallylamp_screencast_start", "tallylamp_screencast_stop"]) {
      const tool = result.tools!.find((tool) => tool.name === name)!;
      assert.ok(tool, name);
      assert.equal((tool.inputSchema.properties!.browserId as { type: string }).type, "string");
      assert.ok(!tool.inputSchema.required?.includes("browserId"));
    }
    assert.ok(result.tools!.find((tool) => tool.name === "navigate_page")!.inputSchema.properties!.url);
    assert.ok(result.tools!.find((tool) => tool.name === "tallylamp_select_page")!.inputSchema.required!.includes("pageId"));
  });

  it("runs B while A is awaiting a result and keeps each call's original target", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    const entered = deferred(); const finish = deferred();
    onCall = async (id) => { if (id === a) { entered.resolve(); await finish.promise; } };
    const pending = call("take_snapshot");
    try {
      await entered.promise;
      assert.equal(text(ok(await call("take_snapshot", { browserId: b }))), b);
      assert.equal(gateway.sessions.get(session)!.browserId, a, "explicit B leaves default A intact");
      ok(await call("tallylamp_use_browser", { browserId: b }));
      assert.deepEqual(closes, [], "switching the default must not close A's in-flight bridge");
    } finally { finish.resolve(); }
    assert.equal(text(ok(await pending)), a);
    assert.ok(calls.every((entry) => !("browserId" in entry.args)), "routing ID is not forwarded to DevTools");
    assert.equal(text(ok(await call("take_snapshot"))), b);
    assert.equal(text(ok(await call("take_snapshot", { browserId: a }))), a);
  });

  it("coalesces simultaneous first calls to one browser into one bridge attachment", async () => {
    let starts = 0;
    const ensure = ctx.browsers.ensureRunning.bind(ctx.browsers);
    ctx.browsers.ensureRunning = async (id) => { starts++; return ensure(id); };
    const results = await Promise.all([
      call("take_snapshot", { browserId: a }), call("take_snapshot", { browserId: a }),
    ]);
    results.forEach(ok);
    assert.equal(starts, 1);
    assert.equal(attached(a), 1);
    assert.equal(gateway.sessions.get(session)!.browserId, undefined, "explicit cold calls do not set a default");
    await ctx.mcp.close(session);
    assert.deepEqual(closes, [a]);
    assert.equal(attached(a), 0);
  });

  it("never falls back to the default for invalid, missing, or unauthorized explicit targets", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    const other = createAgent({ name: "Other identity" });
    const forbidden = ctx.browsers.create({ principal: other.agent, via: "mcp" }).id;
    for (const browserId of ["", " ", null, 12, "missing-browser", forbidden]) {
      assert.equal((await call("click", { browserId, uid: "1_1" })).isError, true, String(browserId));
    }
    assert.equal(calls.length, 0);
    assert.equal(attached(forbidden), 0);
    assert.equal(text(ok(await call("take_snapshot"))), a);
  });

  it("authorizes the selected target in both directions between a read grant and an owned browser", async () => {
    const borrowed = ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard" }).id;
    const request = requestBrowser(ctx.browsers, agent.agent, { browserId: borrowed, access: "read" });
    assert.equal(request.state, "pending");
    answerRequest(ctx.browsers, adminPrincipal(), { requestId: request.requestId, decision: "grant", access: "read", untilRevoked: true });
    ok(await call("tallylamp_use_browser", { browserId: borrowed }));
    assert.equal(text(ok(await call("click", { browserId: a, uid: "1_1" }))), a);
    assert.match(text(await call("click", { uid: "1_1" })), /grant_level_insufficient/);
    ok(await call("tallylamp_use_browser", { browserId: a }));
    assert.match(text(await call("click", { browserId: borrowed, uid: "1_1" })), /grant_level_insufficient/);
    assert.equal(text(ok(await call("tallylamp_select_page", { browserId: borrowed, pageId: 2 }))), borrowed);
    assert.deepEqual(calls.at(-1)!.args, { pageId: 2, bringToFront: false });
    revokeGrant(ctx.browsers, borrowed, agent.agent.id, adminPrincipal());
    assert.equal((await call("take_snapshot", { browserId: borrowed })).isError, true);
    assert.equal(text(ok(await call("click", { uid: "1_1" }))), a);
    assert.ok(calls.filter((entry) => entry.browserId === borrowed).every((entry) => entry.name === "select_page"));
  });

  it("applies human control to the explicit browser rather than the default", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    ctx.browsers.acquireControl(a, "human", "operator", { force: true });
    assert.equal(text(ok(await call("click", { browserId: b, uid: "1_1" }))), b);
    assert.match(text(await call("click", { uid: "1_1" })), /human_controlling_browser/);
    ctx.browsers.releaseControl(a);
    ctx.browsers.acquireControl(b, "human", "operator", { force: true });
    assert.match(text(await call("click", { browserId: b, uid: "1_1" })), /human_controlling_browser/);
    assert.equal(text(ok(await call("click", { uid: "1_1" }))), a);
  });

  it("rechecks human control after a cold bridge's asynchronous startup", async () => {
    const entered = deferred(); const finish = deferred();
    const ensure = ctx.browsers.ensureRunning.bind(ctx.browsers);
    ctx.browsers.ensureRunning = async (id) => { const runtime = await ensure(id); entered.resolve(); await finish.promise; return runtime; };
    const pending = call("click", { browserId: b, uid: "1_1" });
    try { await entered.promise; ctx.browsers.acquireControl(b, "human", "operator", { force: true }); }
    finally { finish.resolve(); }
    assert.match(text(await pending), /human_controlling_browser/);
    assert.equal(calls.length, 0);
  });

  it("rechecks a grant revoked during startup and cleans up the failed binding", async () => {
    const borrowed = ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard" }).id;
    const request = requestBrowser(ctx.browsers, agent.agent, { browserId: borrowed, access: "read" });
    assert.equal(request.state, "pending");
    answerRequest(ctx.browsers, adminPrincipal(), { requestId: request.requestId, decision: "grant", access: "read", untilRevoked: true });
    const entered = deferred(); const finish = deferred();
    const ensure = ctx.browsers.ensureRunning.bind(ctx.browsers);
    ctx.browsers.ensureRunning = async (id) => { const runtime = await ensure(id); entered.resolve(); await finish.promise; return runtime; };
    const pending = call("take_snapshot", { browserId: borrowed });
    try { await entered.promise; revokeGrant(ctx.browsers, borrowed, agent.agent.id, adminPrincipal()); }
    finally { finish.resolve(); }
    assert.equal((await pending).isError, true);
    assert.equal(calls.length, 0);
    assert.equal(attached(borrowed), 0);
    assert.equal(gateway.sessions.get(session)!.bindings.has(borrowed), false);
  });

  it("checks the tunnel's browser even when another default browser is under human control", async () => {
    const tunnel = createTunnel(ctx.browsers, agent.agent, { browserId: b, port: 3000 });
    ok(await call("tallylamp_use_browser", { browserId: a }));
    ctx.browsers.acquireControl(a, "human", "operator", { force: true });
    ok(await call("tallylamp_close_tunnel", { tunnelId: tunnel.row.id }));
    const next = createTunnel(ctx.browsers, agent.agent, { browserId: b, port: 3001 });
    ctx.browsers.acquireControl(b, "human", "operator", { force: true });
    assert.match(text(await call("tallylamp_close_tunnel", { tunnelId: next.row.id })), /human_controlling_browser/);
  });

  it("retries a failed explicit startup on that same target without changing the default", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    const ensure = ctx.browsers.ensureRunning.bind(ctx.browsers);
    ctx.browsers.ensureRunning = async () => { throw new Error("temporary startup failure"); };
    assert.equal((await call("take_snapshot", { browserId: b })).isError, true);
    assert.equal(gateway.sessions.get(session)!.bindings.has(b), false);
    assert.equal(attached(b), 0);
    ctx.browsers.ensureRunning = ensure;
    assert.equal(text(ok(await call("take_snapshot", { browserId: b }))), b);
    assert.equal(text(ok(await call("take_snapshot"))), a);
  });

  it("stopping B closes only B; closing the session cleans up the remaining bridges", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    ok(await call("take_snapshot", { browserId: b }));
    ok(await call("tallylamp_stop_browser", { browserId: b }));
    assert.deepEqual(closes, [b]);
    assert.equal(attached(a), 1); assert.equal(attached(b), 0);
    assert.equal(text(ok(await call("take_snapshot"))), a);
    await ctx.mcp.close(session);
    assert.deepEqual(closes, [b, a]);
    assert.equal(attached(a), 0);
  });

  it("release during startup cancels that binding without leaking an attachment or changing the default", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    const entered = deferred(); const finish = deferred();
    const ensure = ctx.browsers.ensureRunning.bind(ctx.browsers);
    ctx.browsers.ensureRunning = async (id) => { const runtime = await ensure(id); entered.resolve(); await finish.promise; return runtime; };
    const pending = call("take_snapshot", { browserId: b });
    try { await entered.promise; await ctx.mcp.releaseBrowser(b); }
    finally { finish.resolve(); }
    assert.equal((await pending).isError, true);
    assert.equal(attached(b), 0);
    assert.equal(gateway.sessions.get(session)!.bindings.has(b), false);
    assert.equal(text(ok(await call("take_snapshot"))), a);
  });

  it("keeps separate session defaults and refuses ambiguous reconnect recovery", async () => {
    const second = await open();
    ok(await call("tallylamp_use_browser", { browserId: a }));
    ok(await call("tallylamp_use_browser", { browserId: b }, second));
    const results = await Promise.all([call("take_snapshot"), call("take_snapshot", {}, second)]);
    assert.deepEqual(results.map((result) => text(ok(result))), [a, b]);
    await ctx.mcp.releaseBrowser(a);
    assert.equal(text(ok(await call("take_snapshot"))), a, "a live session recovers its own default");
    const fresh = await open();
    assert.match(text(await call("take_snapshot", {}, fresh)), /Multiple browsers.*browserId/);
    assert.equal(text(ok(await call("take_snapshot", { browserId: a }, fresh))), a);
    assert.equal(gateway.sessions.get(fresh)!.browserId, undefined);
  });

  it("routes recording start and stop to the same explicit browser without changing the default", async () => {
    ok(await call("tallylamp_use_browser", { browserId: a }));
    ok(await call("tallylamp_screencast_start", { browserId: b, maxSeconds: 1, armSeconds: 1 }));
    ok(await call("tallylamp_screencast_stop", { browserId: b }));
    assert.equal(gateway.sessions.get(session)!.browserId, a);
    assert.equal(text(ok(await call("take_snapshot"))), a);
  });
});
