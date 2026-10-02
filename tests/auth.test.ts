import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { AGENT_SCOPES } from "../src/auth.js";

let ctx: TestCtx;

describe("authentication", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => {
    await ctx.close();
  });

  it("rejects unauthenticated admin API", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers`);
    assert.equal(r.status, 401);
  });

  it("rejects unauthenticated MCP", async () => {
    const r = await json(`${ctx.url}/mcp`, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    });
    assert.equal(r.status, 401);
    assert.ok(r.headers.get("www-authenticate")?.includes("resource_metadata"));
  });

  it("rejects wrong admin secret", async () => {
    const r = await json(`${ctx.url}/api/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "nope" }),
    });
    assert.equal(r.status, 401);
  });

  it("accepts admin cookie session", async () => {
    const r = await json(`${ctx.url}/api/v1/me`, { headers: { Cookie: ctx.cookie } });
    assert.equal(r.status, 200);
    assert.equal((r.body as { principal: { type: string } }).principal.type, "admin");
  });

  it("agent bearer cannot access dashboard agent admin routes", async () => {
    const r = await json(`${ctx.url}/api/v1/agents`, {
      headers: { Authorization: `Bearer ${ctx.agentToken}` },
    });
    assert.equal(r.status, 403);
  });

  it("revoked credentials are rejected", async () => {
    const created = await json(`${ctx.url}/api/v1/agents`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "temp" }),
    });
    const token = (created.body as { token: string }).token;
    const id = (created.body as { agent: { id: string } }).agent.id;
    await json(`${ctx.url}/api/v1/agents/${id}`, {
      method: "PATCH",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const r = await json(`${ctx.url}/api/v1/browsers`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 401);
  });

  it("offers every non-default scope as a permission the dashboard can grant at creation", async () => {
    const list = await json(`${ctx.url}/api/v1/agents`, { headers: { Cookie: ctx.cookie } });
    const { permissions, defaultScopes } = list.body as {
      permissions: { scope: string; label: string; detail: string }[];
      defaultScopes: string[];
    };
    // A scope that is neither a default nor offered can only be granted through the raw API.
    // That is how browser:tunnel went without a dashboard control.
    assert.deepEqual([...defaultScopes, ...permissions.map((p) => p.scope)].sort(), [...AGENT_SCOPES].sort());
    for (const p of permissions) assert.ok(p.label && p.detail, `${p.scope} says what it hands over`);

    const created = await json(`${ctx.url}/api/v1/agents`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "loads profiles", scopes: [...defaultScopes, "seed:use"] }),
    });
    assert.equal(created.status, 201);
    const { scopes } = (created.body as { agent: { scopes: string[] } }).agent;
    assert.ok(scopes.includes("seed:use"), "granted on the create form, not afterwards");
    assert.ok(scopes.includes("browser:create"), "still drives its own browsers");
    assert.ok(!scopes.includes("seed:write"), "nothing it was not given");
  });

  it("serves standalone favicons without leaking markup into the dashboard", async () => {
    const response = await fetch(ctx.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
    assert.ok(head, "dashboard has a document head");

    // Orphaned SVG fragments after a favicon link make the browser close the
    // head early and render the leftover attribute terminators above sign-in.
    const unexpectedMarkup = head
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<(meta|link)\b[^>]*>/gi, "")
      .trim();
    assert.equal(unexpectedMarkup, "", "no stray text or SVG markup in the document head");

    for (const name of ["favicon-light.svg", "favicon-dark.svg"]) {
      assert.ok(head.includes(`href="/${name}"`), `${name} is linked`);
      const icon = await fetch(`${ctx.url}/${name}`);
      assert.equal(icon.status, 200);
      assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);
      assert.match(await icon.text(), /<svg\b/);
    }
  });

  it("healthz is unauthenticated and minimal", async () => {
    const r = await json(`${ctx.url}/healthz`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "ok" });
  });
});
