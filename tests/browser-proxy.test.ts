import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseBrowserProxy, proxyView } from "../src/browser-proxy.js";
import { BrowserManager } from "../src/browsers.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { requestBrowser, answerRequest } from "../src/lending.js";
import { getDb } from "../src/db.js";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const proxy = { server: "https://proxy.example.com:8443", username: "proxy-user", password: " secret : value " };
const summary = { server: proxy.server, hasAuthentication: true };
const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;

describe("proxy configuration", () => {
  it("canonicalizes endpoints, preserves credentials, and exposes only a summary", () => {
    assert.equal(parseBrowserProxy(undefined), null);
    assert.equal(parseBrowserProxy(null), null);
    assert.deepEqual(parseBrowserProxy({ server: " HTTPS://Proxy.Example.com:443/ " }), { server: "https://proxy.example.com" });
    assert.deepEqual(parseBrowserProxy(proxy), proxy);
    assert.deepEqual(proxyView(proxy), summary);
    assert.deepEqual(parseBrowserProxy({ server: "http://[::1]:8080", username: "user", password: "" }), { server: "http://[::1]:8080", username: "user", password: "" });
  });

  it("dashboard uses masked inputs, preserves credentials and sends a proxy-only PATCH", async () => {
    const script = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
    const source = script.slice(script.indexOf("function proxyFields("), script.indexOf("async function editBrowser("));
    const calls: any[] = [];
    const values = { proxyServer: proxy.server, proxyUsername: proxy.username, proxyPassword: proxy.password };
    const sandbox: any = {
      askFor: async (_title: string, fields: any[], _label: string, submit: (values: unknown) => Promise<void>) => {
        assert.equal(fields.find(f => f.name === "proxyPassword").type, "password");
        assert.equal(fields.find(f => f.name === "proxyPassword").preserveWhitespace, true);
        await submit(values); return values;
      },
      api: async (...args: unknown[]) => { calls.push(args); }, flash: () => {}, refresh: async () => {}, render: () => {},
    };
    runInNewContext(source, sandbox);
    await sandbox.editProxy({ id: "example-browser", proxy: summary });
    assert.equal(calls[0][0], "/api/v1/browsers/example-browser");
    assert.equal(calls[0][1].method, "PATCH");
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)), { proxy });
    assert.equal(sandbox.proxyFromFields({ proxyServer: "", proxyUsername: "", proxyPassword: "" }), null);
    assert.throws(() => sandbox.proxyFromFields({ proxyServer: "", proxyUsername: "user", proxyPassword: "" }));
  });

  it("rejects invalid settings without reflecting submitted secrets", () => {
    for (const input of ["http://proxy", [], {}, { server: 1 }, { server: "socks5://proxy:1080" },
      { server: "http://user:SECRET@proxy:80" }, { server: "http://proxy:0" }, { server: "http://proxy:65536" },
      { server: "http://proxy/path" }, { server: "http://proxy?SECRET" }, { server: "http://proxy#SECRET" },
      { server: "http://proxy\\SECRET" }, { server: "http://proxy", bypass: "*" },
      { server: "http://proxy", username: "u" }, { server: "http://proxy", password: "SECRET" },
      { server: "http://proxy", username: "u:x", password: "SECRET" },
      { server: "http://proxy", username: "u", password: "SECRET\r\n" }]) {
      assert.throws(() => parseBrowserProxy(input), (error: Error) => !error.message.includes("SECRET"));
    }
  });
});

describe("per-browser proxy lifecycle", () => {
  let ctx: TestCtx;
  before(async () => { ctx = await startTestServer(); });
  after(async () => ctx.close());
  const api = async (endpoint: string, method = "GET", body?: unknown, token?: string) => json(`${ctx.url}/api/v1${endpoint}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: ctx.cookie }), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it("persists, redacts, rejects live changes, resumes, replaces and removes settings", async () => {
    const created = await api("/browsers", "POST", { name: "Proxy lifecycle", proxy, start: false, metadata: { project: "Proxy" } });
    assert.equal(created.status, 201);
    const browser = (created.body as any).browser;
    assert.deepEqual(browser.proxy, summary);
    assert.ok(!JSON.stringify(created.body).includes(proxy.password));
    assert.ok(!JSON.stringify(created.body).includes(proxy.username));
    const row = ctx.browsers.row(browser.id);
    assert.deepEqual(JSON.parse(row.proxy_json!), proxy);
    const recovered = new BrowserManager();
    await recovered.recoverOnBoot();
    assert.deepEqual(recovered.publicView(recovered.row(row.id)).proxy, summary);
    assert.equal((await api(`/browsers/${row.id}/start`, "POST")).status, 200);
    assert.equal((await api(`/browsers/${row.id}`, "PATCH", { proxy: null })).status, 409);
    assert.deepEqual(JSON.parse(ctx.browsers.row(row.id).proxy_json!), proxy);
    await api(`/browsers/${row.id}/stop`, "POST");
    const patched = await api(`/browsers/${row.id}`, "PATCH", { proxy: { server: "http://other.example:8080" } });
    assert.equal(patched.status, 200);
    assert.deepEqual((patched.body as any).browser.proxy, { server: "http://other.example:8080", hasAuthentication: false });
    assert.deepEqual((patched.body as any).browser.metadata, { project: "Proxy" }, "proxy-only PATCH must not replace metadata");
    assert.equal((await api(`/browsers/${row.id}`, "PATCH", { proxy: null })).status, 200);
    assert.equal(ctx.browsers.row(row.id).proxy_json, null);
    const list = await api("/browsers");
    assert.ok(!JSON.stringify(list.body).includes(proxy.password));
    const audits = JSON.stringify(getDb().prepare("SELECT * FROM audit_events").all());
    assert.ok(!audits.includes(proxy.password));
    assert.ok(!audits.includes(proxy.username));
  });

  it("rejects invalid input before creating a browser or overwriting its route", async () => {
    const count = ctx.browsers.list().length;
    assert.equal((await api("/browsers", "POST", { proxy: { server: "socks5://proxy:1080" }, start: false })).status, 400);
    assert.equal(ctx.browsers.list().length, count);
    const row = ctx.browsers.create({ principal: admin, via: "dashboard", proxy });
    assert.equal((await api(`/browsers/${row.id}`, "PATCH", { proxy: { server: "http://a:b@proxy" } })).status, 400);
    assert.deepEqual(JSON.parse(ctx.browsers.row(row.id).proxy_json!), proxy);
  });

  it("keeps browser routes separate and does not copy them into saved profiles", async () => {
    const source = ctx.browsers.create({ principal: admin, via: "dashboard", proxy });
    const direct = ctx.browsers.create({ principal: admin, via: "dashboard" });
    assert.equal(direct.proxy_json, null);
    const saved = await ctx.browsers.saveProfile(source.id, admin, { name: "Profile without proxy" });
    const copy = ctx.browsers.create({ principal: admin, via: "dashboard", seedId: saved.id });
    assert.equal(copy.proxy_json, null);
    assert.deepEqual(JSON.parse(ctx.browsers.row(source.id).proxy_json!), proxy);
  });

  it("allows only an owner/admin with control permission to update a stopped browser", async () => {
    const owner = createAgent({ name: "Proxy owner" });
    const other = createAgent({ name: "Unrelated agent" });
    const row = ctx.browsers.create({ principal: owner.agent, via: "mcp" });
    assert.equal((await api(`/browsers/${row.id}`, "PATCH", { proxy }, other.token)).status, 403);
    assert.equal((await api(`/browsers/${row.id}`, "PATCH", { proxy }, owner.token)).status, 200);
    assert.throws(() => ctx.browsers.updateProxy(row.id, null, { ...owner.agent, scopes: ["browser:read:own"] }));
    ctx.browsers.acquireControl(row.id, "human", "admin", { force: true });
    assert.throws(() => ctx.browsers.updateProxy(row.id, null, owner.agent), /human/i);
    // The guard is against the agent, not the operator who holds the lease.
    assert.deepEqual(JSON.parse(ctx.browsers.updateProxy(row.id, proxy, admin).proxy_json!), proxy);
    ctx.browsers.releaseControl(row.id, admin);
    const starting = ctx.browsers.ensureRunning(row.id);
    assert.throws(() => ctx.browsers.updateProxy(row.id, null, owner.agent), /stop the browser/);
    await starting;
    await ctx.browsers.stop(row.id);
  });

  it("does not let a borrower alter the owner's route", () => {
    const owner = createAgent({ name: "Lending proxy owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend"] });
    const borrower = createAgent({ name: "Proxy borrower", scopes: [...DEFAULT_AGENT_SCOPES, "browser:borrow"] });
    const row = ctx.browsers.create({ principal: owner.agent, via: "mcp", proxy });
    const request = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    assert.equal(request.state, "pending");
    answerRequest(ctx.browsers, owner.agent, { requestId: request.state === "pending" ? request.requestId : "", decision: "grant" });
    ctx.browsers.assertAccess(borrower.agent, row, "control");
    assert.throws(() => ctx.browsers.updateProxy(row.id, null, borrower.agent), /only the owner/);
    assert.deepEqual(JSON.parse(ctx.browsers.row(row.id).proxy_json!), proxy);
  });
});
