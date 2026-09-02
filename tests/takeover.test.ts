import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let browserId: string;

describe("human takeover", () => {
  before(async () => {
    ctx = await startTestServer();
    const r = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "takeover", start: true }),
    });
    browserId = (r.body as { browser: { id: string } }).browser.id;
  });
  after(async () => ctx.close());

  it("watch ticket is issued without granting control", async () => {
    const t = await json(`${ctx.url}/api/v1/browsers/${browserId}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "watch" }),
    });
    assert.equal(t.status, 200);
    const b = await json(`${ctx.url}/api/v1/browsers/${browserId}`, { headers: { Cookie: ctx.cookie } });
    assert.notEqual((b.body as { browser: { control: { controllerType: string } } }).browser.control.controllerType, "human");
  });

  it("interactive viewer ticket is refused while the agent holds the browser", async () => {
    const t = await json(`${ctx.url}/api/v1/browsers/${browserId}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "control" }),
    });
    assert.equal(t.status, 403);
  });

  it("admin can take control of the same browser", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers/${browserId}/control`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { control: { controllerType: string } }).control.controllerType, "human");
    assert.ok(ctx.browsers.isHumanControlled(browserId));
  });

  it("forced takeover is audited", async () => {
    const audit = await json(`${ctx.url}/api/v1/audit`, { headers: { Cookie: ctx.cookie } });
    const events = (audit.body as { events: Array<{ action: string }> }).events;
    assert.ok(events.some((e) => e.action === "human.takeover" || e.action === "control.forced"));
  });

  it("returning control releases the human lease", async () => {
    const r = await json(`${ctx.url}/api/v1/browsers/${browserId}/control`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { control: { controllerType: string } }).control.controllerType, "none");
  });

  it("stale leases expire", async () => {
    process.env.TALLYLAMP_HUMAN_LEASE_TTL_SEC = "0";
    ctx.browsers.acquireControl(browserId, "human", "admin");
    await new Promise((r) => setTimeout(r, 20));
    const state = ctx.browsers.controlState(browserId);
    assert.equal(state.controllerType, "none");
    delete process.env.TALLYLAMP_HUMAN_LEASE_TTL_SEC;
  });
});
