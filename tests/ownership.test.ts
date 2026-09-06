import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { createAgent } from "../src/auth.js";

let ctx: TestCtx;

describe("browser ownership", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("agent creates a browser with trusted provenance", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ persistent: true, start: false, metadata: { source: "human", purpose: "spoof attempt" } }),
    });
    assert.equal(r.status, 201);
    const b = (r.body as { browser: { owner: { type: string }; provenance: { createdByType: string }; metadata: { source: string } } }).browser;
    assert.equal(b.owner.type, "agent");
    assert.equal(b.provenance.createdByType, "agent");
    assert.equal(b.metadata.source, "human");
  });

  it("agent cannot see another agent's browser", async () => {
    const other = createAgent({ name: "Other" });
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mine", start: false }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    const list = await json(`${ctx.url}/api/v1/browsers`, { headers: { Authorization: `Bearer ${other.token}` } });
    const ids = ((list.body as { browsers: Array<{ id: string }> }).browsers || []).map((b) => b.id);
    assert.equal(ids.includes(id), false);
    const get = await json(`${ctx.url}/api/v1/browsers/${id}`, { headers: { Authorization: `Bearer ${other.token}` } });
    assert.equal(get.status, 403);
  });

  it("admin can list all browsers", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers`, { headers: { Cookie: ctx.cookie } });
    assert.equal(r.status, 200);
    assert.ok(((r.body as { browsers: unknown[] }).browsers).length >= 1);
  });

  it("human can create a browser from the dashboard", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "prepared", start: false, metadata: { purpose: "login later" } }),
    });
    assert.equal(r.status, 201);
    const b = (r.body as { browser: { provenance: { createdVia: string; createdByType: string } } }).browser;
    assert.equal(b.provenance.createdByType, "admin");
    assert.equal(b.provenance.createdVia, "dashboard");
  });
});

describe("seed authorization", () => {
  let ctx2: TestCtx;
  before(async () => {
    ctx2 = await startTestServer();
  });
  after(async () => ctx2.close());

  /** Snapshot a stopped browser as a seed, the way an administrator would. */
  async function makeSeed(): Promise<string> {
    const created = await json(`${ctx2.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx2.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "seed source", start: false }),
    });
    assert.equal(created.status, 201);
    const id = (created.body as { browser: { id: string } }).browser.id;
    const seeded = await json(`${ctx2.url}/api/v1/seeds`, {
      method: "POST",
      headers: { Cookie: ctx2.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: id, name: "logged-in" }),
    });
    assert.equal(seeded.status, 201);
    return (seeded.body as { seed: { id: string } }).seed.id;
  }

  it("a seed id alone does not let an agent clone its logins", async () => {
    // A seed is a whole authenticated profile. Creating one is admin-only, but cloning one
    // used to need nothing past browser:create, so any agent that learned a seed id inherited
    // every login inside it. Seed ids are not secrets.
    const seedId = await makeSeed();
    const agent = createAgent({ name: "no seed scope" });
    assert.ok(!agent.agent.scopes.includes("seed:use"), agent.agent.scopes.join(","));

    const r = await json(`${ctx2.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ start: false, seedId }),
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.ok(JSON.stringify(r.body).includes("seed:use"), JSON.stringify(r.body));
  });

  it("an agent granted seed:use can clone one", async () => {
    const seedId = await makeSeed();
    const agent = createAgent({ name: "seed user", scopes: ["browser:create", "seed:use"] });
    const r = await json(`${ctx2.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ start: false, seedId }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it("a refused clone leaves no seeded profile behind", async () => {
    const seedId = await makeSeed();
    const agent = createAgent({ name: "refused" });
    const before = await json(`${ctx2.url}/api/v1/browsers`, {
      headers: { Cookie: ctx2.cookie },
    });
    const countBefore = (before.body as { browsers: unknown[] }).browsers.length;
    await json(`${ctx2.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ start: false, seedId }),
    });
    const after = await json(`${ctx2.url}/api/v1/browsers`, { headers: { Cookie: ctx2.cookie } });
    assert.equal((after.body as { browsers: unknown[] }).browsers.length, countBefore);
  });
});
