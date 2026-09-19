import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error plain JS shipped in the extension; there are no types to import
import { guard, siteOf, withinSite } from "../extension/guard.js";
// @ts-expect-error plain JS shipped in the extension
import { normalizeServer } from "../extension/address.js";

const tab = { url: "https://app.example.com/inbox", sites: null as string[] | null };
const allowed = (method: string, params = {}, t = tab) => {
  const v = guard(t, method, params);
  assert.equal(v.ok, true, v.reason);
  return v.params;
};
const refused = (method: string, params = {}, t = tab) => {
  const v = guard(t, method, params);
  assert.equal(v.ok, false, `${method} should have been refused`);
  return v.reason as string;
};

describe("extension guard: a shared tab is not the whole profile", () => {
  it("lets ordinary page driving through untouched", () => {
    const params = { expression: "document.title" };
    assert.equal(allowed("Runtime.evaluate", params), params);
    for (const m of ["Page.enable", "Input.dispatchMouseEvent", "DOM.getDocument", "Emulation.setDeviceMetricsOverride", "Page.captureScreenshot", "Accessibility.getFullAXTree"]) allowed(m);
  });

  it("refuses the profile-wide cookie jar and strips the argument that widens the per-page one", () => {
    for (const m of ["Storage.getCookies", "Network.getAllCookies", "Storage.setCookies", "Storage.clearCookies", "Network.clearBrowserCookies"]) {
      assert.match(refused(m), /cookie/);
    }
    // With `urls`, getCookies answers for ANY site: the bank's session from the webmail tab.
    assert.deepEqual(allowed("Network.getCookies", { urls: ["https://bank.example/"] }), {});
    allowed("Network.setCookie", { name: "a", value: "b", url: "https://app.example.com/" });
    allowed("Network.setCookie", { name: "a", value: "b", domain: ".example.com" });
    refused("Network.setCookie", { name: "a", value: "b", url: "https://bank.example/" });
    refused("Network.setCookies", { cookies: [{ name: "a", value: "b", domain: "app.example.com" }, { name: "a", value: "b", domain: "bank.example" }] });
  });

  it("refuses to look at, open or attach to other tabs", () => {
    for (const m of ["Target.getTargets", "Target.setDiscoverTargets", "Target.attachToTarget", "Target.createTarget", "Target.closeTarget", "Target.activateTarget", "Target.exposeDevToolsProtocol"]) {
      assert.match(refused(m), /other tabs/);
    }
    allowed("Target.setAutoAttach", { autoAttach: true, flatten: true });
    // getTargetInfo with a targetId answers for any tab; without one, for this tab.
    assert.deepEqual(allowed("Target.getTargetInfo", { targetId: "SOMEONE-ELSES-TAB" }), {});
  });

  it("refuses the disk", () => {
    assert.match(refused("DOM.setFileInputFiles", { files: ["/Users/me/.ssh/id_ed25519"] }), /disk/);
    refused("Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/Users/me/Library/LaunchAgents" });
    assert.match(refused("Page.navigate", { url: "file:///etc/passwd" }), /only http and https/);
    refused("Page.navigate", { url: "chrome://settings/passwords" });
    refused("Page.navigate", { url: "javascript:alert(1)" });
    allowed("Page.navigate", { url: "about:blank" });
  });

  it("only lets storage methods name the tab's own origin", () => {
    allowed("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: "https://app.example.com", isLocalStorage: true } });
    refused("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: "https://bank.example", isLocalStorage: true } });
    refused("IndexedDB.requestDatabaseNames", { securityOrigin: "https://bank.example" });
    refused("Storage.clearDataForOrigin", { origin: "https://bank.example", storageTypes: "all" });
    allowed("Storage.getUsageAndQuota", { origin: "https://app.example.com" });
  });

  it("holds a site-limited share to its site, subdomains included, lookalikes not", () => {
    const limited = { url: "https://app.example.com/inbox", sites: ["example.com"] };
    allowed("Page.navigate", { url: "https://example.com/pricing" }, limited);
    allowed("Page.navigate", { url: "https://docs.example.com/" }, limited);
    allowed("Page.navigate", { url: "/settings" }, limited);
    assert.match(refused("Page.navigate", { url: "https://bank.example/" }, limited), /shared for example\.com only/);
    refused("Page.navigate", { url: "https://example.com.evil.test/" }, limited);
    refused("Page.navigate", { url: "https://notexample.com/" }, limited);
    allowed("Page.navigate", { url: "https://bank.example/" }, tab);

    assert.equal(siteOf("https://www.example.com/a"), "example.com");
    assert.equal(siteOf("chrome://newtab"), null);
    assert.equal(withinSite("https://a.b.example.com/", "example.com"), true);
  });
});

describe("extension package", () => {
  it("carries the same version as the server it ships with", () => {
    // The release attaches the extension to the GitHub release of the same tag. A manifest
    // left behind on the previous version would ship a zip that says it is something else.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
    assert.equal(manifest.version, pkg.version, "bump extension/manifest.json with package.json");
  });
});

describe("extension address parsing", () => {
  it("accepts what people actually type", () => {
    assert.deepEqual(normalizeServer("tallylamp.example.com"), { ok: true, server: "https://tallylamp.example.com" });
    assert.deepEqual(normalizeServer("  https://tallylamp.example.com/browsers?x=1 "), { ok: true, server: "https://tallylamp.example.com" });
    assert.deepEqual(normalizeServer("localhost:8080"), { ok: true, server: "http://localhost:8080" });
    assert.deepEqual(normalizeServer("http://127.0.0.1:8080/"), { ok: true, server: "http://127.0.0.1:8080" });
  });

  it("will not send a link token over plain http to somewhere that is not this computer", () => {
    assert.match(normalizeServer("http://tallylamp.example.com").error, /https/);
    assert.match(normalizeServer("").error, /Enter the address/);
    assert.match(normalizeServer("not a url at all").error, /doesn't look like/);
  });
});
