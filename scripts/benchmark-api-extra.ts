import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { TestCtx } from "../tests/helpers.js";
import type { BrowserRow } from "../src/browsers.js";
import { AGENT_SCOPES, createAgent } from "../src/auth.js";
import { config } from "../src/config.js";
import { requestBrowser } from "../src/lending.js";
import { parseJoinToken } from "../src/worker.js";

type Bench = (name: string, action: () => Promise<unknown> | unknown, meta?: Record<string, unknown>) => Promise<void>;
type Request = (route: string, method?: string, body?: unknown, cookie?: string, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers; bytes: number }>;

/** Supplemental after-change coverage. These paths were not measured in the first baseline. */
export async function extra(ctx: TestCtx, bench: Bench, request: Request, fixture: BrowserRow) {
  const base = `/api/v1/browsers/${fixture.id}`;
  const paths = (...coveredRoutes: string[]) => ({ coveredRoutes, comparison: "after only; no before-change measurement" });
  await bench("agent.create", () => request("/api/v1/agents", "POST", { name: "Supplemental fixture" }), paths("POST /api/v1/agents"));
  await bench("browser.thread estimates reset", () => request(`${base}/threads/reset`, "POST", {}), paths("POST /api/v1/browsers/:id/threads/reset"));
  await bench("browser.disable extension support", () => request(`${base}/extensions`, "PUT", { enabled: false }), paths("PUT /api/v1/browsers/:id/extensions"));
  await bench("browser.disable native agent control", () => request(`${base}/agent-desktop`, "PUT", { enabled: false }), paths("PUT /api/v1/browsers/:id/agent-desktop"));
  await bench("pairing.start + pending poll + describe + deny", async () => {
    const { body } = await request("/api/v1/links/pair", "POST", { deviceName: "Fixture" }, "");
    const poll = await request("/api/v1/links/pair/poll", "POST", { deviceCode: body.deviceCode }, "");
    assert.equal(poll.body.state, "pending");
    await request(`/api/v1/links/pair/${body.userCode}`);
    await request(`/api/v1/links/pair/${body.userCode}/deny`, "POST", {});
  }, paths("POST /api/v1/links/pair", "POST /api/v1/links/pair/poll", "GET /api/v1/links/pair/:code", "POST /api/v1/links/pair/:code/deny"));
  await bench("pairing.approve + collect + access read/write + unlink + delete", async () => {
    const { body } = await request("/api/v1/links/pair", "POST", { deviceName: "Fixture" }, "");
    const approved = await request(`/api/v1/links/pair/${body.userCode}/approve`, "POST", { anyAgent: false, agentIds: [] });
    const id = approved.body.browserId;
    const poll = await request("/api/v1/links/pair/poll", "POST", { deviceCode: body.deviceCode }, "");
    assert.equal(poll.body.state, "approved");
    await request(`/api/v1/browsers/${id}/access`);
    await request(`/api/v1/browsers/${id}/access`, "PUT", { anyAgent: false, agentIds: [] });
    await request(`/api/v1/browsers/${id}/link`, "DELETE");
    await request(`/api/v1/browsers/${id}`, "DELETE");
  }, paths("POST /api/v1/links/pair/:code/approve", "GET /api/v1/browsers/:id/access", "PUT /api/v1/browsers/:id/access", "DELETE /api/v1/browsers/:id/link"));

  await bench("tunnel.create + list + revoke", async () => {
    const created = await request(`${base}/tunnels`, "POST", { host: "localhost", port: 45678 });
    await request(`${base}/tunnels`);
    await request(`/api/v1/tunnels/${created.body.tunnel.id}`, "DELETE");
  }, paths("POST /api/v1/browsers/:id/tunnels", "GET /api/v1/browsers/:id/tunnels", "DELETE /api/v1/tunnels/:id"));

  const borrower = createAgent({ name: "Supplemental borrower", scopes: AGENT_SCOPES.slice() });
  await bench("lending.request + grant read + revoke", async () => {
    const asked = requestBrowser(ctx.browsers, borrower.agent, { browserId: fixture.id, access: "read" });
    await request(`/api/v1/requests/${asked.requestId}/answer`, "POST", { decision: "grant", access: "read", untilRevoked: true });
    await request(`${base}/grants/${borrower.agent.id}`, "DELETE");
  }, paths("POST /api/v1/requests/:id/answer", "DELETE /api/v1/browsers/:id/grants/:granteeId"));

  // Polls hit a real local HTTP fixture instead of inventing a reachable remote worker.
  ctx.app.get("/worker/v1/state", (_req, res) => res.json({ version: config.release, browsers: [], linkedBridges: [], pids: null, fullBrowser: false }));
  await bench("worker.join token + join + hello + remove (local state fixture)", async () => {
    const issued = await request("/api/v1/workers/join-tokens", "POST", {});
    const { secret } = parseJoinToken(issued.body.token);
    const joined = await request("/api/v1/workers/join", "POST", { token: secret, name: "Fixture worker", url: ctx.url, version: config.release }, "");
    await request("/api/v1/workers/hello", "POST", { ...joined.body, name: "Fixture worker", url: ctx.url, version: config.release }, "");
    await ctx.browsers.workers.poll();
    await request(`/api/v1/workers/${joined.body.workerId}`, "DELETE");
  }, paths("POST /api/v1/workers/join-tokens", "POST /api/v1/workers/join", "POST /api/v1/workers/hello", "DELETE /api/v1/workers/:id"));

  const redirect = "http://127.0.0.1:54321/fixture-callback";
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  async function form(route: string, fields: URLSearchParams) {
    const res = await fetch(`${ctx.url}${route}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: ctx.cookie, Origin: ctx.url }, body: fields, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    assert.ok(res.ok || res.status === 302, `${route} ${res.status}: ${text}`);
    return { res, text };
  }
  await bench("OAuth register + consent + code exchange + refresh + revoke", async () => {
    const registered = await request("/oauth/register", "POST", { redirect_uris: [redirect], client_name: "Benchmark host" }, "");
    const client = registered.body.client_id;
    const query = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "benchmark", resource: `${ctx.url}/mcp` });
    const page = await fetch(`${ctx.url}/oauth/authorize?${query}`, { headers: { Cookie: ctx.cookie }, signal: AbortSignal.timeout(15_000) });
    assert.equal(page.status, 200);
    const html = await page.text();
    const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(consent);
    const fields = new URLSearchParams(query); fields.set("consent", consent); fields.set("action", "approve");
    AGENT_SCOPES.forEach(scope => fields.append("grant_scope", scope));
    const approved = await form("/oauth/authorize", fields);
    const code = new URL(approved.res.headers.get("location")!).searchParams.get("code")!;
    const exchanged = JSON.parse((await form("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client, code_verifier: verifier }))).text);
    assert.ok(exchanged.access_token);
    const refreshed = JSON.parse((await form("/oauth/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: exchanged.refresh_token, client_id: client }))).text);
    assert.ok(refreshed.access_token);
    await form("/oauth/revoke", new URLSearchParams({ token: refreshed.access_token }));
  }, paths("POST /oauth/register", "GET /oauth/authorize", "POST /oauth/authorize", "POST /oauth/token", "POST /oauth/revoke"));

  await bench("profile.create empty + delete", async () => {
    const made = await request("/api/v1/seeds", "POST", { browserId: fixture.id, name: "Supplemental profile" });
    await request(`/api/v1/seeds/${made.body.seed.id}`, "DELETE", { confirmName: "Supplemental profile" });
  }, paths("POST /api/v1/seeds", "DELETE /api/v1/seeds/:id"));

  await bench("guest complete control session (fake Chrome)", async () => {
    const created = await request(`${base}/guests`, "POST", { label: "Fixture guest", modes: ["watch", "control"], expiresInSec: 600 });
    const token = new URL(created.body.url).hash.slice(1);
    const exchange = await request("/guest/api/v1/session", "POST", { token }, "");
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
    await request("/guest/api/v1/browser", "GET", undefined, cookie);
    await request("/guest/api/v1/start", "POST", {}, cookie);
    const acquired = await request("/guest/api/v1/control", "POST", {}, cookie);
    await request("/guest/api/v1/control/heartbeat", "POST", { leaseToken: acquired.body.browser.control.leaseToken }, cookie);
    await request("/guest/api/v1/viewer-ticket", "POST", { mode: "control" }, cookie);
    await request("/guest/api/v1/control", "DELETE", undefined, cookie);
    await request("/guest/api/v1/session", "DELETE", undefined, cookie);
    await request(`${base}/guests/${created.body.guest.id}`, "DELETE");
    await request(`${base}/stop`, "POST", {});
  }, paths("POST /guest/api/v1/session", "GET /guest/api/v1/browser", "POST /guest/api/v1/start", "POST /guest/api/v1/control", "POST /guest/api/v1/control/heartbeat", "POST /guest/api/v1/viewer-ticket", "DELETE /guest/api/v1/control", "DELETE /guest/api/v1/session"));

  // Export the real temporary fixture data only; archive output is consumed, never published.
  writeFileSync(path.join(fixture.profile_path, "fixture-export"), Buffer.alloc(1024 * 1024, 11));
  await bench("instance.export fixture 1 MiB", async () => {
    const exported = await request("/api/v1/export", "POST", {});
    assert.equal(exported.headers.get("content-type"), "application/gzip");
    assert.ok(exported.bytes > 1000);
    // HTTP EOF can precede staging-directory cleanup. Include actual export completion
    // rather than racing the next sample against the intentional transfer lock.
    const deadline = Date.now() + 5000;
    while (ctx.browsers.transferInProgress) {
      assert.ok(Date.now() < deadline, "export cleanup exceeded 5 seconds");
      await setImmediate();
    }
  }, paths("POST /api/v1/export"));
}
