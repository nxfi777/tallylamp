import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { getDb } from "../src/db.js";
import { resetRateLimits } from "../src/rate-limit.js";
import { AGENT_SCOPES } from "../src/auth.js";

let ctx: TestCtx;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const REDIRECT = "http://127.0.0.1:54321/callback";

async function register(redirectUris: string[] = [REDIRECT]) {
  const r = await json(`${ctx.url}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Test Host" }),
  });
  return r;
}

/** Drive the consent page the way a browser would: GET it, read the CSRF token, POST it. */
async function approve(opts: {
  clientId: string;
  challenge: string;
  redirect?: string;
  state?: string;
  cookie?: string;
  action?: string;
  scopes?: readonly string[];
}) {
  const redirect = opts.redirect ?? REDIRECT;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: redirect,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: opts.state ?? "xyz",
    resource: `${ctx.url}/mcp`,
  });
  const cookie = opts.cookie ?? ctx.cookie;
  const page = await fetch(`${ctx.url}/oauth/authorize?${query}`, { headers: { cookie }, redirect: "manual" });
  const html = await page.text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const body = new URLSearchParams(query);
  body.set("consent", consent);
  body.set("action", opts.action ?? "approve");
  // The consent form submits one grant_scope field per ticked box. Unchecked boxes are
  // simply absent, so an empty selection is a refusal and the server rejects it.
  for (const scope of opts.scopes ?? AGENT_SCOPES) body.append("grant_scope", scope);
  const res = await fetch(`${ctx.url}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body,
  });
  return { page, html, consent, res };
}

async function exchange(code: string, verifier: string, clientId: string, redirect = REDIRECT) {
  const res = await fetch(`${ctx.url}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function fullGrant() {
  const { verifier, challenge } = pkce();
  const reg = await register();
  const clientId = (reg.body as { client_id: string }).client_id;
  const { res } = await approve({ clientId, challenge });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const token = await exchange(code, verifier, clientId);
  return { clientId, code, verifier, token: token.body };
}

async function callMcp(token: string) {
  return json(`${ctx.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "oauth-host", version: "0" } },
    }),
  });
}

describe("oauth for MCP hosts that refuse static bearer tokens", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());
  // The suite drives the consent flow far harder than a human ever would.
  beforeEach(() => resetRateLimits());

  describe("discovery", () => {
    it("advertises only grants it implements", async () => {
      const r = await json(`${ctx.url}/.well-known/oauth-authorization-server`);
      assert.equal(r.status, 200);
      const b = r.body as Record<string, unknown>;
      assert.ok(String(b.authorization_endpoint).endsWith("/oauth/authorize"));
      assert.deepEqual(b.grant_types_supported, ["authorization_code", "refresh_token"]);
      assert.ok(!(b.grant_types_supported as string[]).includes("client_credentials"));
      assert.deepEqual(b.code_challenge_methods_supported, ["S256"]);
      assert.equal(b.client_id_metadata_document_supported, true);
      assert.deepEqual(b.token_endpoint_auth_methods_supported, ["none"]);
      assert.equal(b.authorization_response_iss_parameter_supported, true);
      assert.ok(String(b.revocation_endpoint).endsWith("/oauth/revoke"));
    });

    it("serves both well-known spellings directly, with no redirect", async () => {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/mcp",
      ]) {
        const res = await fetch(`${ctx.url}${path}`, { redirect: "manual" });
        assert.equal(res.status, 200, `${path} should be 200, got ${res.status}`);
      }
    });

    it("names /mcp as the protected resource", async () => {
      const r = await json(`${ctx.url}/.well-known/oauth-protected-resource`);
      assert.equal((r.body as { resource: string }).resource, `${ctx.url}/mcp`);
      assert.deepEqual((r.body as { authorization_servers: string[] }).authorization_servers, [ctx.url]);
    });

    it("answers CORS preflight so browser hosts can send Authorization", async () => {
      const res = await fetch(`${ctx.url}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/i);
      assert.match(res.headers.get("access-control-expose-headers") ?? "", /WWW-Authenticate/i);
    });

    it("challenges an unauthenticated /mcp with resource_metadata", async () => {
      const res = await fetch(`${ctx.url}/mcp`, { method: "POST" });
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    });
  });

  describe("client registration", () => {
    it("registers a public client", async () => {
      const r = await register();
      assert.equal(r.status, 201);
      assert.ok((r.body as { client_id: string }).client_id.startsWith("tallylamp_"));
    });

    it("rejects a non-loopback http redirect", async () => {
      const r = await register(["http://evil.example/callback"]);
      assert.equal(r.status, 400);
    });

    it("caps the number of redirect_uris", async () => {
      const many = Array.from({ length: 12 }, (_, i) => `https://example.com/cb${i}`);
      const r = await register(many);
      assert.equal(r.status, 201);
      assert.equal((r.body as { redirect_uris: string[] }).redirect_uris.length, 5);
    });
  });

  describe("authorization endpoint refuses unbound clients", () => {
    it("refuses a client_id that was never registered, without rendering a credential form", async () => {
      const { challenge } = pkce();
      const res = await fetch(
        `${ctx.url}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: "x",
          redirect_uri: "https://evil.example/cb",
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: ctx.cookie }, redirect: "manual" },
      );
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null, "must never redirect an unresolvable client");
      const html = await res.text();
      assert.ok(!html.includes('type="password"'), "must not prompt for the admin secret");
      assert.ok(!html.includes("evil.example") || html.includes("Unknown client"));
    });

    it("refuses a redirect_uri that is not registered for the client", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const res = await fetch(
        `${ctx.url}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: "https://evil.example/cb",
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: ctx.cookie }, redirect: "manual" },
      );
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    });

    it("refuses a non-S256 challenge before anything else happens", async () => {
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const res = await fetch(
        `${ctx.url}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: "plainchallenge",
          code_challenge_method: "plain",
        })}`,
        { headers: { cookie: ctx.cookie }, redirect: "manual" },
      );
      assert.equal(res.status, 400);
    });

    it("sends an unauthenticated operator to the dashboard login, preserving the request", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const res = await fetch(
        `${ctx.url}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { redirect: "manual" },
      );
      assert.equal(res.status, 302);
      const loc = res.headers.get("location") ?? "";
      assert.ok(loc.startsWith("/login?next="), `expected a login redirect, got ${loc}`);
      assert.match(decodeURIComponent(loc), /\/oauth\/authorize\?/);
    });

    it("refuses a consent POST with no dashboard session", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const res = await fetch(`${ctx.url}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          action: "approve",
        }),
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("location"), null);
    });

    it("refuses a consent POST with a forged CSRF token", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const res = await fetch(`${ctx.url}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: ctx.cookie },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          consent: "not-the-right-token",
          action: "approve",
        }),
      });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    });

    it("sets anti-framing and no-store headers on the consent page", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const res = await fetch(
        `${ctx.url}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: ctx.cookie }, redirect: "manual" },
      );
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      assert.equal(res.headers.get("cache-control"), "no-store");
    });

    it("escapes reflected parameters", async () => {
      const res = await fetch(
        `${ctx.url}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: "</p><script>alert(1)</script>",
          redirect_uri: REDIRECT,
          code_challenge: "c".repeat(43),
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: ctx.cookie }, redirect: "manual" },
      );
      const html = await res.text();
      assert.ok(!html.includes("<script>alert(1)</script>"));
    });
  });

  describe("the grant", () => {
    it("issues an audience-bound access token plus a refresh token", async () => {
      const { token } = await fullGrant();
      assert.equal(token.token_type, "Bearer");
      assert.ok(token.access_token.startsWith("tl_oa_"));
      assert.ok(token.refresh_token.startsWith("tl_rt_"));
      assert.ok(Number(token.expires_in) <= 3600);
    });

    it("returns the issuer on the authorization response (RFC 9207)", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge });
      const loc = new URL(res.headers.get("location")!);
      assert.equal(loc.searchParams.get("iss"), ctx.url);
      assert.equal(loc.searchParams.get("state"), "xyz");
    });

    it("honours Deny", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge, action: "deny" });
      const loc = new URL(res.headers.get("location")!);
      assert.equal(loc.searchParams.get("error"), "access_denied");
      assert.equal(loc.searchParams.get("code"), null);
    });

    it("never binds a code to the admin principal", async () => {
      await fullGrant();
      const rows = getDb().prepare(`SELECT principal_type FROM oauth_codes`).all() as Array<{ principal_type: string }>;
      assert.ok(rows.length > 0);
      assert.ok(rows.every((r) => r.principal_type === "agent"), "OAuth must never mint the admin principal");
    });

    it("creates a revocable connector agent, not an admin", async () => {
      const { token } = await fullGrant();
      const agents = await json(`${ctx.url}/api/v1/agents`, { headers: { cookie: ctx.cookie } });
      const list = (agents.body as { agents: Array<{ name: string; labels: Record<string, string>; maxBrowsers: number }> }).agents;
      const connector = list.find((a) => a.labels?.kind === "connector");
      assert.ok(connector, "the grant should appear on the Agents page");
      assert.equal(connector!.maxBrowsers, 2);
      assert.ok(token.access_token);
    });

    it("accepts the token at /mcp", async () => {
      const { token } = await fullGrant();
      const r = await callMcp(token.access_token);
      assert.ok(r.status === 200 || r.status === 202);
      const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      assert.ok(text.includes("tallylamp"));
    });

    it("refuses the same token on the control API (audience binding)", async () => {
      const { token } = await fullGrant();
      const r = await json(`${ctx.url}/api/v1/browsers`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      assert.equal(r.status, 401, "a token minted for /mcp must not work on the control API");
      const admin = await json(`${ctx.url}/api/v1/agents`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      assert.equal(admin.status, 401);
    });

    it("refuses the refresh token as a bearer credential", async () => {
      const { token } = await fullGrant();
      const r = await callMcp(token.refresh_token);
      assert.equal(r.status, 401);
    });
  });

  describe("token endpoint", () => {
    it("rejects a wrong PKCE verifier", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const out = await exchange(code, "totally-wrong-verifier-value-xxxx", clientId);
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "invalid_grant");
    });

    it("rejects a code presented by a different client", async () => {
      const { verifier, challenge } = pkce();
      const reg = await register();
      const other = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const otherId = (other.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const out = await exchange(code, verifier, otherId);
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "invalid_grant");
    });

    it("rejects a mismatched redirect_uri", async () => {
      const { verifier, challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const out = await exchange(code, verifier, clientId, "http://127.0.0.1:9999/other");
      assert.equal(out.status, 400);
    });

    it("kills the whole grant when a code is replayed", async () => {
      const { clientId, code, verifier, token } = await fullGrant();
      const replay = await exchange(code, verifier, clientId);
      assert.equal(replay.status, 400);
      const after = await callMcp(token.access_token);
      assert.equal(after.status, 401, "replaying a code must revoke what it already produced");
    });

    it("rejects an unsupported grant type instead of failing obscurely", async () => {
      const res = await fetch(`${ctx.url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, "unsupported_grant_type");
    });
  });

  describe("refresh", () => {
    it("rotates the refresh token and keeps the connector alive", async () => {
      const { clientId, token } = await fullGrant();
      const res = await fetch(`${ctx.url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: clientId }),
      });
      assert.equal(res.status, 200);
      const next = (await res.json()) as Record<string, string>;
      assert.ok(next.access_token.startsWith("tl_oa_"));
      assert.notEqual(next.refresh_token, token.refresh_token);
      const call = await callMcp(next.access_token);
      assert.ok(call.status === 200 || call.status === 202);
    });

    it("treats refresh reuse as theft and revokes the family", async () => {
      const { clientId, token } = await fullGrant();
      const first = await fetch(`${ctx.url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: clientId }),
      });
      const rotated = (await first.json()) as Record<string, string>;
      const replay = await fetch(`${ctx.url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: clientId }),
      });
      assert.equal(replay.status, 400);
      const after = await callMcp(rotated.access_token);
      assert.equal(after.status, 401, "reuse must revoke every token in the family");
    });

    it("rejects a refresh token presented by another client", async () => {
      const { token } = await fullGrant();
      const other = await register();
      const res = await fetch(`${ctx.url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
          client_id: (other.body as { client_id: string }).client_id,
        }),
      });
      assert.equal(res.status, 400);
    });
  });

  describe("revocation", () => {
    it("revokes a grant through the RFC 7009 endpoint", async () => {
      const { token } = await fullGrant();
      const res = await fetch(`${ctx.url}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: token.access_token }),
      });
      assert.equal(res.status, 200);
      const after = await callMcp(token.access_token);
      assert.equal(after.status, 401);
    });

    it("reports success for an unknown token", async () => {
      const res = await fetch(`${ctx.url}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "tl_oa_nope" }),
      });
      assert.equal(res.status, 200);
    });

    it("disconnects the host when the connector agent is revoked in the dashboard", async () => {
      const { token } = await fullGrant();
      const agents = await json(`${ctx.url}/api/v1/agents`, { headers: { cookie: ctx.cookie } });
      const connector = (agents.body as { agents: Array<{ id: string; labels: Record<string, string> }> }).agents.find(
        (a) => a.labels?.kind === "connector",
      )!;
      const patch = await json(`${ctx.url}/api/v1/agents/${connector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: ctx.cookie },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(patch.status, 200);
      const after = await callMcp(token.access_token);
      assert.equal(after.status, 401);
    });
  });

  describe("the static bearer path still works", () => {
    it("accepts a dashboard agent token at /mcp", async () => {
      const r = await callMcp(ctx.agentToken);
      assert.ok(r.status === 200 || r.status === 202, `expected success, got ${r.status}`);
    });

    it("accepts the same token on the control API", async () => {
      const r = await json(`${ctx.url}/api/v1/browsers`, { headers: { Authorization: `Bearer ${ctx.agentToken}` } });
      assert.equal(r.status, 200);
    });

    it("does not accept ADMIN_SECRET as a bearer token by default", async () => {
      const r = await json(`${ctx.url}/api/v1/browsers`, { headers: { Authorization: `Bearer ${ctx.adminSecret}` } });
      assert.equal(r.status, 401);
    });
  });

  describe("session and revocation hardening", () => {
    it("refuses to let one principal drive another principal's MCP session", async () => {
      const { token } = await fullGrant();
      const opened = await callMcp(token.access_token);
      const sid = opened.headers.get("mcp-session-id");
      assert.ok(sid, "initialize should return a session id");
      // The session id travels in a response header; it is not a secret.
      const stolen = await json(`${ctx.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.agentToken}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "mcp-session-id": sid!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      assert.equal(stolen.status, 403, "another principal must not reuse this session");
    });

    it("revokes credentials when an agent is disabled, and re-enabling does not resurrect them", async () => {
      const { clientId, token } = await fullGrant();
      const agents = await json(`${ctx.url}/api/v1/agents`, { headers: { cookie: ctx.cookie } });
      const connector = (agents.body as { agents: Array<{ id: string; labels: Record<string, string> }> }).agents
        .find((a) => a.labels?.client_id === clientId)!;
      await json(`${ctx.url}/api/v1/agents/${connector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: ctx.cookie },
        body: JSON.stringify({ enabled: false }),
      });
      await json(`${ctx.url}/api/v1/agents/${connector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: ctx.cookie },
        body: JSON.stringify({ enabled: true }),
      });
      const after = await callMcp(token.access_token);
      assert.equal(after.status, 401, "re-enabling must not resurrect a revoked token");
    });

    it("refuses to rotate a connector's credential into a null-audience token", async () => {
      const { clientId } = await fullGrant();
      const agents = await json(`${ctx.url}/api/v1/agents`, { headers: { cookie: ctx.cookie } });
      const connector = (agents.body as { agents: Array<{ id: string; labels: Record<string, string> }> }).agents
        .find((a) => a.labels?.client_id === clientId)!;
      const r = await json(`${ctx.url}/api/v1/agents/${connector.id}/rotate`, {
        method: "POST",
        headers: { cookie: ctx.cookie },
      });
      assert.equal(r.status, 400);
    });
  });

  describe("the consent checkboxes must not lie", () => {
    it("refuses an approval with no scopes ticked instead of granting them all", async () => {
      const { challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge, scopes: [] });
      assert.equal(res.status, 400, "unticking everything must not grant everything");
      assert.equal(res.headers.get("location"), null, "and it must not issue a code");
    });

    it("grants exactly the scopes that were ticked", async () => {
      const { verifier, challenge } = pkce();
      const reg = await register();
      const clientId = (reg.body as { client_id: string }).client_id;
      const { res } = await approve({ clientId, challenge, scopes: ["browser:create", "browser:list:own"] });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const out = await exchange(code, verifier, clientId);
      assert.equal(out.status, 200);
      assert.deepEqual(out.body.scope.split(" ").sort(), ["browser:create", "browser:list:own"]);
    });
  });

  // A consent form that cannot reach the client is a consent form that does nothing: the
  // browser re-checks form-action on the 302 back to the client, and blames the pre-redirect
  // URL when it blocks, so the failure reads as this server refusing its own form.
  describe("the consent form has to be able to reach the client", () => {
    const CLIENT_REDIRECT = "https://client.example.com/cb";

    it("names the validated redirect origin in form-action, on the page and on the 302", async () => {
      const reg = await register([CLIENT_REDIRECT]);
      const clientId = (reg.body as { client_id: string }).client_id;
      const { challenge } = pkce();
      const { page, res } = await approve({ clientId, challenge, redirect: CLIENT_REDIRECT });

      assert.match(
        page.headers.get("content-security-policy") ?? "",
        /form-action 'self' https:\/\/client\.example\.com;/,
      );
      assert.equal(res.status, 302);
      assert.match(
        res.headers.get("content-security-policy") ?? "",
        /form-action 'self' https:\/\/client\.example\.com;/,
      );
      assert.ok(res.headers.get("location")!.startsWith(CLIENT_REDIRECT));
    });

    it("leaves form-action bare for a redirect_uri the client never registered", async () => {
      const reg = await register([CLIENT_REDIRECT]);
      const clientId = (reg.body as { client_id: string }).client_id;
      const { challenge } = pkce();
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://attacker.example.com/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "xyz",
        resource: `${ctx.url}/mcp`,
      });
      const page = await fetch(`${ctx.url}/oauth/authorize?${query}`, {
        headers: { cookie: ctx.cookie },
        redirect: "manual",
      });
      await page.text();
      assert.equal(page.status, 400);
      assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self';/);
    });
  });
});
