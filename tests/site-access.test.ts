import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/auth.js";
import { normalizeSiteOrigin } from "../src/site-access.js";
import { json, startTestServer, type TestCtx } from "./helpers.js";
import { runInNewContext } from "node:vm";
import { SIGN_IN_OBSERVATION, SiteDetector } from "../src/site-detection.js";
import { WebSocketServer } from "ws";
import { listSiteAccess, removeSiteAccess } from "../src/site-access.js";
import { readFileSync } from "node:fs";

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

  it("detects only visible, explicit sign-out controls without reading storage", () => {
    const observe = (label: string, visible = true, protocol = "https:") => runInNewContext(SIGN_IN_OBSERVATION, {
      location: { protocol, origin: "https://example.com" },
      document: {
        get cookie() { throw new Error("must not read cookies"); },
        querySelectorAll: () => [{ getClientRects: () => visible ? [{}] : [], getAttribute: () => null, innerText: label }],
      },
      getComputedStyle: () => ({ visibility: "visible", opacity: "1" }),
    });
    assert.equal(observe("Sign out").signedIn, true);
    assert.equal(observe("Log out").signedIn, true);
    for (const label of ["Sign in", "Profile", "Account", "How to log out", ""]) assert.equal(observe(label).signedIn, false);
    assert.equal(observe("Sign out", false).signedIn, false);
    assert.equal(observe("Sign out", true, "about:"), null);
  });

  it("prefills the manual form from the viewer's active tab, not the cached URL", async () => {
    const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
    const functions = ["browserView", "siteAccessSection", "currentOrigin", "addSite"].map(name => {
      const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, "m"));
      assert.ok(match, `missing dashboard function ${name}`);
      return match[0];
    }).join("\n");
    const browser = { id: "test", name: "Research", status: "running", url: "https://stale.example", persistent: true, metadata: {}, provenance: {}, owner: {} };
    let active: { onActiveTab: (tab: { url: string; title: string }) => void } | undefined;
    let fields: Array<{ name: string; value?: string }> = [];
    const sandbox = {
      browser, URL, document: {}, state: { status: {} },
      api: async () => ({ browser }),
      h: (_tag: string, attrs: object, ...children: unknown[]) => ({ attrs, children, append() {}, replaceChildren() {} }),
      principal: () => "Test", layout() {}, icon() {}, lendingSection() {}, tunnelSection() {},
      ICON_BACK: [], ICON_FORWARD: [], ICON_RELOAD: [], ICON_FULLSCREEN: [], ICON_PLUS: [],
      connectViewer: (...args: unknown[]) => { active = args[5] as typeof active; },
      askFor: async (_title: string, values: typeof fields) => { fields = values; return null; },
    };
    await runInNewContext(`${functions}\n(async () => { await browserView('test'); })()`, sandbox);
    assert.ok(active);
    active.onActiveTab({ url: "https://mobbin.com/discover/apps/ios/latest", title: "Mobbin" });
    await runInNewContext(`${functions}\naddSite(browser)`, sandbox);
    assert.equal(fields.find(field => field.name === "origin")?.value, "https://mobbin.com");
    assert.equal(fields.find(field => field.name === "name")?.value, "mobbin.com");
    active.onActiveTab({ url: "about:blank", title: "" });
    await runInNewContext(`${functions}\naddSite(browser)`, sandbox);
    assert.equal(fields.find(field => field.name === "origin")?.value, "");
  });

  it("dashboard Save updates the linked ID; Save as new explicitly posts a separate profile", async () => {
    const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
    const code = source.match(/^async function saveProfileTemplate\([\s\S]*?^}/m)![0];
    const calls: Array<{ url: string; method: string; body: { name: string; metadata: unknown } }> = [];
    let message = "";
    const browser = { id: "browser", name: "Renamed browser", savedProfileId: "linked-id", metadata: { project: "Browser metadata" } };
    const sandbox = { browser,
      state: { seeds: [{ id: "linked-id", name: "Original saved name", metadata: { project: "Saved metadata" } }] },
      askFor: async (_title: string, fields: Array<{ name: string; value?: string }>, _label: string, submit: (values: unknown) => Promise<void>) => {
        const values = Object.fromEntries(fields.map(field => [field.name, field.value || ""]));
        await submit(values); return values;
      },
      api: async (url: string, options: { method: string; body: { name: string; metadata: unknown } }) => { calls.push({ url, ...options }); return { seed: { resumed: false } }; },
      act: (fn: () => Promise<void>) => fn(), render: async () => {}, flash: (text: string) => { message = text; },
    };
    await runInNewContext(`${code}\nsaveProfileTemplate(browser)`, sandbox);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].url, "/api/v1/seeds/linked-id");
    assert.equal(calls[0].body.name, "Original saved name");
    assert.equal(JSON.stringify(calls[0].body.metadata), JSON.stringify({ project: "Saved metadata" }));
    await runInNewContext(`${code}\nsaveProfileTemplate(browser, null, true)`, sandbox);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "/api/v1/seeds");
    sandbox.state.seeds = [];
    await runInNewContext(`${code}\nsaveProfileTemplate(browser)`, sandbox);
    assert.equal(calls.length, 2, "a missing linked profile must not turn Save into Save as new");
    assert.match(message, /unavailable/);
  });

  it("automatically records a signal once, with system provenance, and respects manual removal", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Detected sites", start: false }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(resolve => ws.once("listening", resolve));
    ws.on("connection", client => client.on("message", raw => {
      const message = JSON.parse(String(raw));
      client.send(JSON.stringify({ id: message.id, result: { result: { value: { origin: "https://example.com", signedIn: true } } } }));
    }));
    try {
      const detector = new SiteDetector();
      const pages = [{ type: "page", url: "https://example.com/account", webSocketDebuggerUrl: `ws://127.0.0.1:${(ws.address() as { port: number }).port}` }];
      await detector.scan(id, pages, () => true);
      const sites = listSiteAccess(id);
      assert.equal(sites.length, 1);
      assert.equal(sites[0].reportedBy.type, "system");
      assert.equal(sites[0].state, "confirmed");
      removeSiteAccess(id, sites[0].id, { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] });
      // A fresh detector simulates restarting the service, not just another poll.
      await new SiteDetector().scan(id, pages, () => true);
      assert.deepEqual(listSiteAccess(id), []);
    } finally {
      for (const client of ws.clients) client.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
    }
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
