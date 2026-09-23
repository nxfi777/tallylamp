import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/auth.js";
import { normalizeSiteOrigin } from "../src/site-access.js";
import { json, startTestServer, type TestCtx } from "./helpers.js";
import { runInNewContext } from "node:vm";
import { SIGN_IN_OBSERVATION, SiteDetector } from "../src/site-detection.js";
import { WebSocketServer } from "ws";
import { listSiteAccess, removeSiteAccess, type SeedSiteAccessView as SeedSite } from "../src/site-access.js";
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

  it("recognises Google's signed-in account menu without recording account details or trusting lookalike domains", () => {
    const observe = (host: string, href: string, visible = true) => runInNewContext(SIGN_IN_OBSERVATION, {
      URL, location: { protocol: "https:", hostname: host, href: `https://${host}/`, origin: `https://${host}` },
      document: { querySelectorAll: () => [{ getClientRects: () => visible ? [{}] : [], getAttribute: (name: string) => name === "href" ? href : null, innerText: "" }] },
      getComputedStyle: () => ({ visibility: "visible", opacity: "1" }),
    });
    const accountLink = "https://accounts.google.com/SignOutOptions?hl=en";
    assert.equal(observe("www.google.com", accountLink).signedIn, true);
    assert.equal(observe("www.google.com", accountLink).name, "Google");
    assert.equal(observe("mail.google.com", accountLink).signedIn, true);
    assert.equal(observe("www.google.com.evil.test", accountLink).signedIn, false);
    assert.equal(observe("www.google.com", "https://accounts.google.com.evil.test/SignOutOptions").signedIn, false);
    assert.equal(observe("www.google.com", "https://accounts.google.com/ServiceLogin").signedIn, false);
    assert.equal(observe("www.google.com", accountLink, false).signedIn, false);
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
      h: (_tag: string, attrs: object, ...children: unknown[]) => ({ attrs, children, append() {}, replaceChildren() {}, classList: { add() {} } }),
      principal: () => "Test", layout() {}, icon() {}, settingsSection: () => [], tunnelSection() {}, guestSection() {}, guestHolds: () => false,
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
    let cancelledWith: unknown = "not cancelled";
    const browser = { id: "browser", name: "Renamed browser", savedProfileId: "linked-id", metadata: { project: "Browser metadata" } };
    const sandbox = { browser,
      viewer: { cancel: (keepControl: unknown) => { cancelledWith = keepControl; } } as { cancel: (keepControl: unknown) => void } | null,
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
    // Saving restarts Chrome under a human who holds control. A plain teardown closes with 1000,
    // which the server takes as the operator leaving and hands the browser back to the agent.
    assert.equal(cancelledWith, true, "the re-render after a save must keep the control lease");
    await runInNewContext(`${code}\nsaveProfileTemplate(browser, null, true)`, sandbox);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "/api/v1/seeds");
    sandbox.state.seeds = [];
    await runInNewContext(`${code}\nsaveProfileTemplate(browser)`, sandbox);
    assert.equal(calls.length, 2, "a missing linked profile must not turn Save into Save as new");
    assert.match(message, /unavailable/);
  });

  it("dashboard saved-profile deletion requires confirmation and cancel sends no request", async () => {
    const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
    const code = source.match(/^async function deleteSavedProfile\([\s\S]*?^}/m)![0];
    const calls: Array<{ url: string; method: string; body: { confirmName: string } }> = [];
    let accept = false;
    let prompt = "";
    const sandbox = { profile: { id: "test-profile", name: "Main" },
      confirm: (text: string) => { prompt = text; return accept; },
      api: async (url: string, options: { method: string; body: { confirmName: string } }) => { calls.push({ url, ...options }); return { cleanupPending: false }; },
      act: (fn: () => Promise<void>) => fn(), render: async () => {}, flash: () => {},
    };
    await runInNewContext(`${code}\ndeleteSavedProfile(profile)`, sandbox);
    assert.equal(calls.length, 0);
    assert.match(prompt, /Main/);
    assert.match(prompt, /Existing browsers and their logins stay unchanged/);
    accept = true;
    await runInNewContext(`${code}\ndeleteSavedProfile(profile)`, sandbox);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, "/api/v1/seeds/test-profile");
    assert.equal(calls[0].body.confirmName, "Main");
  });

  it("automatically records a signal once, with system provenance, and respects manual removal", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Detected sites", start: false }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    let signedIn = false;
    const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(resolve => ws.once("listening", resolve));
    ws.on("connection", client => client.on("message", raw => {
      const message = JSON.parse(String(raw));
      client.send(JSON.stringify({ id: message.id, result: { result: { value: { origin: "https://example.com", signedIn } } } }));
    }));
    try {
      const detector = new SiteDetector();
      const pages = [{ type: "page", url: "https://example.com/account", webSocketDebuggerUrl: `ws://127.0.0.1:${(ws.address() as { port: number }).port}` }];
      await detector.scan(id, pages, () => true);
      assert.deepEqual(listSiteAccess(id), []);
      signedIn = true;
      await detector.scan(id, pages, () => true);
      assert.deepEqual(listSiteAccess(id), [], "periodic detection is throttled");
      await detector.scan(id, pages, () => true, true);
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
  it("corrects a saved profile's manifest in place, without inventing a confirmation", async () => {
    const source = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kraken desk", start: false }),
    });
    const sourceId = (source.body as { browser: { id: string } }).browser.id;
    await json(`${ctx.url}/api/v1/browsers/${sourceId}/sites`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "kraken.com", name: "Kraken", state: "confirmed" }),
    });
    const seeded = await json(`${ctx.url}/api/v1/seeds`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: sourceId, name: "Kraken" }),
    });
    const seedId = (seeded.body as { seed: { id: string } }).seed.id;
    const seedSites = async () => {
      const listed = await json(`${ctx.url}/api/v1/seeds`, { headers: { Cookie: ctx.cookie } });
      return (listed.body as { seeds: Array<{ id: string; signedInSites: SeedSite[] }> }).seeds
        .find((seed) => seed.id === seedId)!.signedInSites;
    };
    const observed = (await seedSites())[0];
    assert.ok(observed.lastConfirmedAt, "a snapshotted observation keeps its timestamp");

    // Detection missed this one; recording it by hand must not dress it up as an observation.
    const added = await json(`${ctx.url}/api/v1/seeds/${seedId}/sites`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "tradingview.com/chart/", name: "TradingView", state: "confirmed" }),
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual((added.body as { site: SeedSite }).site, {
      origin: "https://tradingview.com", name: "TradingView", state: "confirmed", lastConfirmedAt: null,
    });
    assert.deepEqual((added.body as { seed: { signedInSites: SeedSite[] } }).seed.signedInSites.map((s) => s.origin),
      ["https://kraken.com", "https://tradingview.com"]);

    // Editing the observed entry changes what it says, never when it was seen.
    await json(`${ctx.url}/api/v1/seeds/${seedId}/sites`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "https://kraken.com", name: "Kraken Pro", state: "needs_sign_in" }),
    });
    const edited = (await seedSites()).find((site) => site.origin === "https://kraken.com")!;
    assert.equal(edited.name, "Kraken Pro");
    assert.equal(edited.state, "needs_sign_in");
    assert.equal(edited.lastConfirmedAt, observed.lastConfirmedAt);

    // A hand-written claim still reaches a copy as expected, and needs_sign_in survives intact.
    const clone = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kraken copy", persistent: false, start: false, seedId }),
    });
    assert.deepEqual((clone.body as { browser: { signedInSites: Array<{ origin: string; state: string }> } })
      .browser.signedInSites.map((site) => [site.origin, site.state]), [
      ["https://kraken.com", "needs_sign_in"],
      ["https://tradingview.com", "expected"],
    ]);

    const removed = await json(`${ctx.url}/api/v1/seeds/${seedId}/sites`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "tradingview.com" }),
    });
    assert.equal(removed.status, 204);
    assert.deepEqual((await seedSites()).map((site) => site.origin), ["https://kraken.com"]);

    const gone = await json(`${ctx.url}/api/v1/seeds/${seedId}/sites`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "tradingview.com" }),
    });
    assert.equal(gone.status, 404);
  });

  it("keeps a shared profile's inventory out of reach of agents, including profile writers", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Shared source", start: false }),
    });
    const sourceId = (created.body as { browser: { id: string } }).browser.id;
    const seeded = await json(`${ctx.url}/api/v1/seeds`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: sourceId, name: "Shared" }),
    });
    const seedId = (seeded.body as { seed: { id: string } }).seed.id;
    // seed:write is permission to publish a browser you own over its own linked profile. It is
    // not permission to relabel what every other agent believes a shared profile can reach.
    const writer = createAgent({ name: "Profile writer", scopes: ["browser:create", "seed:use", "seed:write"] });
    const denied = await json(`${ctx.url}/api/v1/seeds/${seedId}/sites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "instagram.com", state: "confirmed" }),
    });
    assert.equal(denied.status, 403);

    const missing = await json(`${ctx.url}/api/v1/seeds/does-not-exist/sites`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "instagram.com", state: "confirmed" }),
    });
    assert.equal(missing.status, 404);
  });

  it("dashboard site edits post one change at a time and repaint from the server", async () => {
    const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
    const code = source.match(/^function editSeedSites\([\s\S]*?^}/m)![0];
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const clicks = new Map<string, () => void>();
    let refreshed = 0;
    let onClose: (() => void) | undefined;
    const collect = (attrs: Record<string, unknown>, children: unknown[]) => {
      const label = children.filter((child) => typeof child === "string").join("");
      if (attrs?.onClick && label) clicks.set(label, attrs.onClick as () => void);
      return { attrs, children, replaceChildren() {}, focus() {} };
    };
    const seed = { id: "seed-1", name: "Main", signedInSites: [{ origin: "https://mobbin.com", name: "Mobbin", state: "confirmed", lastConfirmedAt: null }] };
    const sandbox = {
      seed, ago: () => "1 d ago",
      h: (_tag: string, attrs: Record<string, unknown>, ...children: unknown[]) => collect(attrs, children),
      api: async (url: string, options: { method: string; body: Record<string, unknown> }) => {
        calls.push({ url, ...options });
        return { seed: { signedInSites: [] } };
      },
      openModal: (_title: string, _build: unknown, close: () => void) => { onClose = close; return { close() {}, box: {} }; },
      refresh: async () => { refreshed += 1; return true; },
      render: async () => {},
    };
    runInNewContext(`${code}\neditSeedSites(seed)`, sandbox);

    clicks.get("Needs sign-in")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls[0].url, "/api/v1/seeds/seed-1/sites");
    assert.equal(calls[0].method, "POST");
    // The body crosses a realm boundary, so compare its shape, not its prototype.
    assert.equal(JSON.stringify(calls[0].body), JSON.stringify({ origin: "https://mobbin.com", name: "Mobbin", state: "needs_sign_in" }));

    clicks.get("Remove")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls[1].method, "DELETE");
    assert.equal(JSON.stringify(calls[1].body), JSON.stringify({ origin: "https://mobbin.com" }));

    onClose!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshed, 1, "closing after a change must reload the saved-profile list");
  });
});
