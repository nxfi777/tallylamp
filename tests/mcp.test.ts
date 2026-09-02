import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";

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
  });
});
