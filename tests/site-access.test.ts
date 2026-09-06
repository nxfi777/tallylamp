import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/auth.js";
import { normalizeSiteOrigin } from "../src/site-access.js";
import { json, startTestServer, type TestCtx } from "./helpers.js";

let ctx: TestCtx;

describe("profile site inventory", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("normalizes a hostname without mistaking cookies for proof", () => {
    assert.equal(normalizeSiteOrigin("mobbin.com/saved/screens?sort=recent"), "https://mobbin.com");
    assert.equal(normalizeSiteOrigin("http://localhost:5173/callback"), "http://localhost:5173");
    assert.throws(() => normalizeSiteOrigin("file:///tmp/profile"), /http or https/);
    assert.throws(() => normalizeSiteOrigin("https://person:secret@example.com"), /credentials/);
  });

  it("records, returns and updates signed-in sites with provenance", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Research", start: false, metadata: { project: "Design" } }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;

    const reported = await json(`${ctx.url}/api/v1/browsers/${id}/sites`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "https://www.mobbin.com/apps", name: "Mobbin", state: "confirmed" }),
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));
    const site = (reported.body as { site: { id: string; origin: string; state: string; reportedBy: { type: string } } }).site;
    assert.equal(site.origin, "https://www.mobbin.com");
    assert.equal(site.state, "confirmed");
    assert.equal(site.reportedBy.type, "admin");

    const renamed = await json(`${ctx.url}/api/v1/browsers/${id}`, {
      method: "PATCH",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Creative research", metadata: { project: "References", purpose: "Study flows" } }),
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const browser = (renamed.body as {
      browser: { name: string; metadata: { project: string }; signedInSites: Array<{ origin: string }> };
    }).browser;
    assert.equal(browser.name, "Creative research");
    assert.equal(browser.metadata.project, "References");
    assert.deepEqual(browser.signedInSites.map((entry) => entry.origin), ["https://www.mobbin.com"]);

    const removed = await json(`${ctx.url}/api/v1/browsers/${id}/sites/${site.id}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    assert.equal(removed.status, 204);
  });

  it("copies a template manifest as expected rather than confirmed", async () => {
    const source = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Social bundle", start: false }),
    });
    const sourceId = (source.body as { browser: { id: string } }).browser.id;
    await json(`${ctx.url}/api/v1/browsers/${sourceId}/sites`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "youtube.com", name: "YouTube", state: "confirmed" }),
    });

    const seeded = await json(`${ctx.url}/api/v1/seeds`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: sourceId, name: "Social template" }),
    });
    assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
    const seedId = (seeded.body as { seed: { id: string } }).seed.id;

    const clone = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One-off social", persistent: false, start: false, seedId }),
    });
    assert.equal(clone.status, 201, JSON.stringify(clone.body));
    const sites = (clone.body as {
      browser: { signedInSites: Array<{ origin: string; state: string; inheritedFromSeedId: string }> };
    }).browser.signedInSites;
    assert.deepEqual(sites.map((site) => [site.origin, site.state, site.inheritedFromSeedId]), [
      ["https://youtube.com", "expected", seedId],
    ]);

    const templates = await json(`${ctx.url}/api/v1/seeds`, { headers: { Cookie: ctx.cookie } });
    const template = (templates.body as { seeds: Array<{ id: string; signedInSites: Array<{ name: string }> }> }).seeds.find(
      (seed) => seed.id === seedId,
    );
    assert.equal(template?.signedInSites[0]?.name, "YouTube");
  });

  it("does not let another agent edit the profile inventory", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Owned", start: false }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    const other = createAgent({ name: "Other" });
    const denied = await json(`${ctx.url}/api/v1/browsers/${id}/sites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "instagram.com", state: "confirmed" }),
    });
    assert.equal(denied.status, 403);
  });
});
