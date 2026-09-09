import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { emitFakeFrame } from "../src/fake-chrome.js";

let ctx: TestCtx;

async function mcp(method: string, params: unknown, token: string, extra: Record<string, string> = {}) {
  return json(`${ctx.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/**
 * Streamable HTTP answers these POSTs as SSE, so the JSON-RPC payload arrives on a data:
 * line rather than as the whole body. Pull the result out either way.
 */
type RpcResult = { instructions?: string; tools?: Tool[] };

function rpcResult(body: unknown): RpcResult | undefined {
  if (body && typeof body === "object") return (body as { result?: RpcResult }).result;
  for (const line of String(body).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      return (JSON.parse(trimmed.slice(5).trim()) as { result?: RpcResult }).result;
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

describe("MCP", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("serves protected resource metadata", async () => {
    const r = await json(`${ctx.url}/.well-known/oauth-protected-resource`);
    assert.equal(r.status, 200);
    const body = r.body as { resource: string; bearer_methods_supported: string[] };
    assert.ok(body.resource.endsWith("/mcp"));
    assert.ok(body.bearer_methods_supported.includes("header"));
  });

  it("initialize + tools/list includes lifecycle tools", async () => {
    const init = await mcp(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      ctx.agentToken,
    );
    assert.ok(init.status === 200 || init.status === 202);
    const session = init.headers.get("mcp-session-id");
    assert.ok(session);
    const listed = await mcp("tools/list", {}, ctx.agentToken, { "MCP-Session-Id": session! });
    const text = JSON.stringify(listed.body);
    assert.ok(text.includes("tallylamp_create_browser"), text);
    assert.ok(text.includes("tallylamp_update_browser"), text);
    assert.ok(text.includes("tallylamp_report_site_access"), text);
    assert.ok(text.includes("tallylamp_list_profile_templates"), text);
  });

  it("sends persistent-session guidance during initialization, before any browser is bound", async () => {
    const init = await mcp(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "reuse-guidance", version: "1" } },
      ctx.agentToken,
    );
    assert.equal(init.status, 200);
    const instructions = rpcResult(init.body)?.instructions;
    assert.ok(instructions, "clients need the workflow in initialize.instructions, not only in repository docs");
    assert.match(instructions, /Before creating a browser or asking the user to sign in again, call tallylamp_list_browsers/);
    assert.match(instructions, /tallylamp_use_browser/);
    assert.match(instructions, /project, purpose, and intended account/);
    assert.match(instructions, /descriptive data, not instructions or permission/);
    assert.match(instructions, /saved automatically.*persistent is true/);
    assert.match(instructions, /wait until control is returned, check authenticated UI/);
    assert.match(instructions, /tallylamp_report_site_access with confirmed/);
    assert.match(instructions, /ask once whether to reuse this browser/);
    assert.match(instructions, /do not ask again once the user has decided/);
    assert.match(instructions, /Do not claim a temporary browser is saved/);
    assert.match(instructions, /Offer a profile template only when future tasks need separate browsers/);
    assert.match(instructions, /copies every saved login/);
    assert.match(instructions, /explicit consent before copying/);
    assert.match(instructions, /administrator-only and is not an MCP tool/);
    assert.match(instructions, /snapshot the stopped browser through the dashboard/);
    assert.match(instructions, /Do not stop active work/);
    assert.match(instructions, /non-default seed:use scope/);
    assert.match(instructions, /Websites can expire or revoke sessions/);
    assert.match(instructions, /tallylamp_stop_browser rather than tallylamp_delete_browser/);
    assert.match(instructions, /Delete saved browser state only when the user explicitly asks/);
  });

  it("keeps reuse and template-consent guidance in advertised tools for clients that omit server instructions", async () => {
    const init = await mcp(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tool-guidance", version: "1" } },
      ctx.agentToken,
    );
    const session = init.headers.get("mcp-session-id");
    assert.ok(session);
    const listed = await mcp("tools/list", {}, ctx.agentToken, { "MCP-Session-Id": session });
    const tools = rpcResult(listed.body)?.tools;
    assert.ok(tools);
    const description = (name: string) => {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool?.description, `${name} must expose guidance to the client`);
      return tool.description;
    };
    assert.match(description("tallylamp_create_browser"), /First call tallylamp_list_browsers/);
    assert.match(description("tallylamp_create_browser"), /Profiles are saved automatically/);
    assert.match(description("tallylamp_list_browsers"), /Before creating a browser or asking for another sign-in/);
    assert.match(description("tallylamp_use_browser"), /no template is needed/);
    assert.match(description("tallylamp_report_site_access"), /ask once whether to reuse/);
    assert.match(description("tallylamp_report_site_access"), /not credentials or a profile snapshot/);
    assert.match(description("tallylamp_list_profile_templates"), /explicit consent before cloning/);
    assert.match(description("tallylamp_list_profile_templates"), /creation is not an MCP tool/);
    assert.match(description("tallylamp_list_profile_templates"), /non-default seed:use scope/);
    assert.match(description("tallylamp_stop_browser"), /Prefer this to deletion for routine cleanup/);
    assert.match(description("tallylamp_delete_browser"), /user explicitly asks/);
    assert.ok(!tools.some(tool => /(?:create|save|snapshot).*(?:template|seed)/.test(tool.name)),
      "guidance must not advertise an agent template-creation capability that does not exist");
  });

  it("reports signed-in sites for agents without exposing credential material", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agent research", start: false }),
    });
    const browserId = (created.body as { browser: { id: string } }).browser.id;
    const init = await mcp(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "site-reporter", version: "1.0.0" } },
      ctx.agentToken,
    );
    const session = init.headers.get("mcp-session-id")!;
    const reported = await mcp(
      "tools/call",
      {
        name: "tallylamp_report_site_access",
        arguments: { browserId, origin: "mobbin.com", name: "Mobbin", state: "confirmed" },
      },
      ctx.agentToken,
      { "MCP-Session-Id": session },
    );
    assert.ok(JSON.stringify(reported.body).includes("https://mobbin.com"), JSON.stringify(reported.body));
    const listed = await mcp(
      "tools/call",
      { name: "tallylamp_list_browsers", arguments: {} },
      ctx.agentToken,
      { "MCP-Session-Id": session },
    );
    const text = JSON.stringify(listed.body);
    assert.ok(text.includes("signedInSites"), text);
    assert.ok(text.includes("Mobbin"), text);
    assert.ok(!text.toLowerCase().includes("cookie"), text);
    assert.ok(!text.includes("tl_ag_"), text);
    assert.ok(!text.includes("tl_oa_"), text);
  });

  it("advertises the driving tools before any browser is bound", async () => {
    // Regression: the forwarded chrome-devtools tools used to appear only once a session was
    // bound. A client that ignores notifications/tools/list_changed could then never see
    // them -- it lists at initialize while unbound, and reconnecting to refresh the list
    // only produces another unbound session. The driving tools were unreachable, not slow.
    const init = await mcp(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "no-list-changed", version: "1.0.0" },
      },
      ctx.agentToken,
    );
    const session = init.headers.get("mcp-session-id")!;
    const listed = await mcp("tools/list", {}, ctx.agentToken, { "MCP-Session-Id": session });
    const names = (rpcResult(listed.body)?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("tallylamp_use_browser"), names.join(","));
    assert.ok(names.includes("navigate_page"), names.join(","));
    assert.ok(names.includes("take_snapshot"), names.join(","));
  });

  it("calling a driving tool unbound is a tool error that says what to do", async () => {
    const init = await mcp(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "unbound", version: "1.0.0" } },
      ctx.agentToken,
    );
    const session = init.headers.get("mcp-session-id")!;
    const called = await mcp(
      "tools/call",
      { name: "navigate_page", arguments: { url: "https://example.com" } },
      ctx.agentToken,
      { "MCP-Session-Id": session },
    );
    const text = JSON.stringify(called.body);
    // A tool error, not a protocol error: the client keeps the session and can bind.
    assert.ok(text.includes("No browser is bound"), text);
  });

  it("agent can create and bind a browser over MCP", async () => {
    const init = await mcp(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "codex", version: "0" } },
      ctx.agentToken,
    );
    const session = init.headers.get("mcp-session-id")!;
    const created = await mcp(
      "tools/call",
      { name: "tallylamp_create_browser", arguments: { persistent: true, metadata: { project: "tallylamp", purpose: "mcp test" } } },
      ctx.agentToken,
      { "MCP-Session-Id": session },
    );
    const raw = typeof created.body === "string" ? created.body : JSON.stringify(created.body);
    assert.ok(raw.includes("browserId"), raw.slice(0, 400));
    const id = raw.match(/browserId\\":\\"([a-f0-9]+)/)?.[1]
      || raw.match(/"browserId":"([a-f0-9]+)"/)?.[1]
      || "";
    assert.ok(id, `missing browserId in ${raw.slice(0, 400)}`);
    await json(`${ctx.url}/api/v1/browsers/${id}/control`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const click = await mcp(
      "tools/call",
      { name: "click", arguments: { pageId: 0, uid: "1_1" } },
      ctx.agentToken,
      { "MCP-Session-Id": session },
    );
    const clickText = JSON.stringify(click.body);
    assert.ok(clickText.includes("controlled by a human"), clickText);
    // The sentence alone is not the contract. AGENTS.md says a mutating tool must fail with a
    // *retryable* error while the lease is live, and the agent can only act on that if the
    // flag is in the payload -- this used to be a bare string with no code and no flag.
    const refusal = rpcResult(click.body) as { content?: Array<{ text?: string }> } | undefined;
    const payload = JSON.parse(refusal?.content?.[0]?.text ?? "{}") as {
      error?: { code?: string; retryable?: boolean };
    };
    assert.equal(payload.error?.code, "human_controlling_browser", clickText);
    assert.equal(payload.error?.retryable, true, "a human lease is temporary, so the refusal must be retryable");
  });
});

describe("agent screencast", () => {
  let own: TestCtx;
  let session = "";
  let browserId = "";

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    json(`${own.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${own.agentToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        "MCP-Session-Id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });

  before(async () => {
    own = await startTestServer();
    const init = await json(`${own.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${own.agentToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    session = init.headers.get("mcp-session-id")!;
    const created = await call("tallylamp_create_browser", { persistent: false });
    const raw = typeof created.body === "string" ? created.body : JSON.stringify(created.body);
    browserId = raw.match(/browserId\\":\\"([a-f0-9]+)/)?.[1] || raw.match(/"browserId":"([a-f0-9]+)"/)?.[1] || "";
    assert.ok(browserId, raw.slice(0, 300));
  });
  after(async () => own.close());

  it("advertises the recording tools", async () => {
    const list = await json(`${own.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${own.agentToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        "MCP-Session-Id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const names = (rpcResult(list.body)?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("tallylamp_screencast_start"), names.join(","));
    assert.ok(names.includes("tallylamp_screencast_stop"), names.join(","));
  });

  it("records, and says which bound stopped it rather than truncating silently", async () => {
    const started = await call("tallylamp_screencast_start", { maxSeconds: 1, maxFrames: 4, maxWidth: 320 });
    const startText = JSON.stringify(started.body);
    assert.ok(startText.includes("recording"), startText.slice(0, 300));

    const stopped = await call("tallylamp_screencast_stop");
    const res = rpcResult(stopped.body) as { content?: Array<{ type: string; text?: string; mimeType?: string }> };
    const summary = JSON.parse(res!.content![0]!.text!) as {
      frameCount: number;
      timingsMs: number[];
      stoppedBy: string;
      droppedFrames: number;
    };
    assert.ok(typeof summary.frameCount === "number");
    assert.ok(Array.isArray(summary.timingsMs), "timings are the point of the tool");
    assert.equal(summary.timingsMs.length, summary.frameCount);
    assert.ok(["stopped", "maxFrames", "maxSeconds", "maxBytes"].includes(summary.stoppedBy), summary.stoppedBy);
    // Frames ride as image content, not as base64 buried in prose, or a model cannot see them.
    for (const c of res!.content!.slice(1)) assert.equal(c.type, "image");
  });

  it("holds the opening frame aside as a before-shot, so timings are only about motion", async () => {
    // Chrome sends exactly one frame the instant a screencast starts, even on a page that has
    // been still for seconds. Counting it as the start is what produced timings like
    // [0, 6882, 6981, ...]: a baseline at zero, then the round trip, then the actual movement.
    await call("tallylamp_screencast_start", { armSeconds: 10, settleMs: 0, maxSeconds: 20 });
    await new Promise((r) => setTimeout(r, 200));
    // Stand in for the agent taking its time to get here.
    await new Promise((r) => setTimeout(r, 600));
    emitFakeFrame();
    await new Promise((r) => setTimeout(r, 120));
    emitFakeFrame();
    await new Promise((r) => setTimeout(r, 150));

    const stopped = await call("tallylamp_screencast_stop");
    const res = rpcResult(stopped.body) as { content?: Array<{ type: string; text?: string }> };
    const summary = JSON.parse(res!.content![0]!.text!) as {
      frameCount: number;
      hasBaselineFrame: boolean;
      timingsMs: number[];
      armedMs: number | null;
      motionMs: number;
    };
    assert.equal(summary.hasBaselineFrame, true, "the opening frame should be kept as a before-shot");
    assert.equal(summary.frameCount, 2, "only the two real repaints count as motion");
    assert.equal(summary.timingsMs[0], 0, "motion timings start at the first repaint, not at the baseline");
    assert.ok(summary.timingsMs[1]! > 0 && summary.timingsMs[1]! < 600, `second frame at ${summary.timingsMs[1]}ms`);
    assert.ok((summary.armedMs ?? 0) >= 600, `the wait should be reported, got ${summary.armedMs}`);
    // Images: the baseline, then one per motion frame.
    assert.equal(res!.content!.filter((c) => c.type === "image").length, 3);
  });

  it("stops by itself once the page has been still, without being told a duration", async () => {
    await call("tallylamp_screencast_start", { armSeconds: 10, settleMs: 300, maxSeconds: 20 });
    await new Promise((r) => setTimeout(r, 200));
    emitFakeFrame();
    await new Promise((r) => setTimeout(r, 100));
    emitFakeFrame();
    // Now go quiet. Settle should end it without maxSeconds ever being reached.
    await new Promise((r) => setTimeout(r, 900));
    const stopped = await call("tallylamp_screencast_stop");
    const res = rpcResult(stopped.body) as { content?: Array<{ text?: string }> };
    const summary = JSON.parse(res!.content![0]!.text!) as { stoppedBy: string; frameCount: number };
    assert.equal(summary.stoppedBy, "settled", "a transition that finishes should not pad to the window");
    assert.equal(summary.frameCount, 2);
  });

  it("does not spend the window on the round trip back to the agent", async () => {
    // The reported failure: maxSeconds 4, elapsedMs 12454, interaction landing at ~6.9s — the
    // wall-clock window had shut long before the thing it was meant to record happened. The
    // clock now starts at the first frame, so a slow caller costs nothing.
    const started = await call("tallylamp_screencast_start", { maxSeconds: 2, armSeconds: 10, settleMs: 0 });
    assert.ok(JSON.stringify(started.body).includes("recording"));
    // Stand in for a slow agent: longer than maxSeconds, well inside armSeconds.
    await new Promise((r) => setTimeout(r, 2600));
    const stopped = await call("tallylamp_screencast_stop");
    const res = rpcResult(stopped.body) as { content?: Array<{ text?: string }> };
    const summary = JSON.parse(res!.content![0]!.text!) as { stoppedBy: string; elapsedMs: number };
    assert.ok(summary.elapsedMs > 2000, `should have stayed open, elapsed ${summary.elapsedMs}`);
    // Still armed, waiting for motion that never came — not expired on a wall clock.
    assert.notEqual(summary.stoppedBy, "maxSeconds", "the wait must not consume the motion budget");
  });

  it("gives up on its own when nothing ever moves, and says which limit that was", async () => {
    await call("tallylamp_screencast_start", { armSeconds: 1, settleMs: 0 });
    await new Promise((r) => setTimeout(r, 1400));
    const stopped = await call("tallylamp_screencast_stop");
    const res = rpcResult(stopped.body) as { content?: Array<{ text?: string }> };
    const summary = JSON.parse(res!.content![0]!.text!) as {
      stoppedBy: string;
      frameCount: number;
      armedMs: number | null;
      note?: string;
    };
    assert.equal(summary.stoppedBy, "noMotion");
    assert.equal(summary.frameCount, 0);
    assert.equal(summary.armedMs, null, "nothing ever moved, so there is no arm time to report");
    assert.ok(summary.note?.includes("never happened or it changed nothing"), summary.note);
  });

  it("clamps a wildly out-of-range window instead of honouring it", async () => {
    const started = await call("tallylamp_screencast_start", {
      maxSeconds: 9999,
      armSeconds: 99999,
      settleMs: -5,
      maxFrames: 500,
    });
    const res = rpcResult(started.body) as { content?: Array<{ text?: string }> };
    const conf = JSON.parse(res!.content![0]!.text!) as {
      maxSeconds: number;
      armSeconds: number;
      settleMs: number;
      maxFrames: number;
    };
    assert.equal(conf.maxSeconds, 30);
    assert.equal(conf.armSeconds, 180);
    assert.equal(conf.settleMs, 0);
    assert.equal(conf.maxFrames, 30);
    await call("tallylamp_screencast_stop");
  });

  it("refuses a second recording rather than interleaving two", async () => {
    await call("tallylamp_screencast_start", { maxSeconds: 2 });
    const again = await call("tallylamp_screencast_start", { maxSeconds: 2 });
    assert.ok(JSON.stringify(again.body).includes("already running"), JSON.stringify(again.body).slice(0, 300));
    await call("tallylamp_screencast_stop");
  });

  it("stopping with nothing running says so instead of returning an empty success", async () => {
    const stopped = await call("tallylamp_screencast_stop");
    assert.ok(JSON.stringify(stopped.body).includes("no recording is running"), JSON.stringify(stopped.body).slice(0, 300));
  });

  it("a human lease blocks recording like any other mutating tool", async () => {
    await json(`${own.url}/api/v1/browsers/${browserId}/control`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    try {
      const blocked = await call("tallylamp_screencast_start", { maxSeconds: 1 });
      const res = rpcResult(blocked.body) as { content?: Array<{ text?: string }> } | undefined;
      const payload = JSON.parse(res?.content?.[0]?.text ?? "{}") as { error?: { code?: string; retryable?: boolean } };
      assert.equal(payload.error?.code, "human_controlling_browser", JSON.stringify(blocked.body).slice(0, 300));
      assert.equal(payload.error?.retryable, true);
    } finally {
      own.browsers.releaseControl(browserId);
    }
  });
});

describe("a dropped mcp session does not cost the agent its browser", () => {
  let own: TestCtx;

  const rpc = async (body: unknown, sessionId?: string) =>
    json(`${own.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${own.agentToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

  const newSession = async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    return init.headers.get("mcp-session-id")!;
  };

  before(async () => { own = await startTestServer(); });
  after(async () => own.close());

  it("re-binds the last browser instead of answering 'no browser is bound'", async () => {
    const first = await newSession();
    const created = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tallylamp_create_browser", arguments: { persistent: false } } },
      first,
    );
    const raw = typeof created.body === "string" ? created.body : JSON.stringify(created.body);
    const id = raw.match(/browserId\\":\\"([a-f0-9]+)/)?.[1] || raw.match(/"browserId":"([a-f0-9]+)"/)?.[1] || "";
    assert.ok(id, raw.slice(0, 300));

    // A brand new session is exactly what the client gets after a 502 drops the old one.
    const second = await newSession();
    // Take control as a human: the refusal is observable proof the session found the browser,
    // because an unbound session cannot reach the lease guard at all.
    await json(`${own.url}/api/v1/browsers/${id}/control`, {
      method: "POST",
      headers: { Cookie: own.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const drive = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { pageId: 0, uid: "1_1" } } },
      second,
    );
    const text = JSON.stringify(drive.body);
    assert.ok(!text.includes("No browser is bound"), `the session should have re-bound: ${text.slice(0, 300)}`);
    // And the restored binding is still behind the lease guard, not past it.
    assert.ok(text.includes("human_controlling_browser"), text.slice(0, 300));
    own.browsers.releaseControl(id);
  });

  it("does not restore a browser the principal can no longer reach", async () => {
    const s1 = await newSession();
    const created = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tallylamp_create_browser", arguments: { persistent: false } } },
      s1,
    );
    const raw = typeof created.body === "string" ? created.body : JSON.stringify(created.body);
    const id = raw.match(/browserId\\":\\"([a-f0-9]+)/)?.[1] || raw.match(/"browserId":"([a-f0-9]+)"/)?.[1] || "";
    await json(`${own.url}/api/v1/browsers/${id}`, { method: "DELETE", headers: { Cookie: own.cookie } });
    const s2 = await newSession();
    const drive = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { pageId: 0, uid: "1_1" } } },
      s2,
    );
    assert.ok(JSON.stringify(drive.body).includes("No browser is bound"), JSON.stringify(drive.body).slice(0, 300));
  });
});

describe("abandoned mcp sessions", () => {
  it("are reaped so they cannot pin a browser as attached", async () => {
    const ctx = await startTestServer();
    try {
      const res = await fetch(`${ctx.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.agentToken}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "abandoned", version: "0" } },
        }),
      });
      await res.text();
      assert.equal(res.status, 200);
      // The client now vanishes without sending DELETE /mcp.
      process.env.TALLYLAMP_MCP_SESSION_IDLE_SEC = "0";
      await ctx.mcp.reapIdleSessions();
      const sid = res.headers.get("mcp-session-id")!;
      const after = await fetch(`${ctx.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.agentToken}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "mcp-session-id": sid,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      await after.text();
      // 404 specifically, not merely "not 200". Streamable HTTP makes 404 the signal
      // for a client to start a new session with initialize; 400 reads as a malformed
      // request and a compliant client gives up instead of recovering. The looser
      // notEqual(200) assertion passed while the server was answering 400, and the
      // claude.ai connector wedged on exactly that.
      assert.equal(after.status, 404, "a reaped session id must be answered with 404");
    } finally {
      delete process.env.TALLYLAMP_MCP_SESSION_IDLE_SEC;
      await ctx.close();
    }
  });
});
