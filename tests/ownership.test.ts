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
