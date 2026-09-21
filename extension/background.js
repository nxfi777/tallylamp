// Tallylamp Link: the service worker.
//
// A dumb pipe with one opinion. It dials out to a Tallylamp server, and for the tabs a person
// has shared it runs the few calls the server may make: `cdp`, `tabs.create`, `tabs.close`,
// `tabs.activate`, `window.get`, `unshare.all`. Every CDP fake lives on the server. The one
// opinion is scope: which tabs are shared, and which CDP methods would reach past them
// (guard.js), are decided here, because the server is the party being limited.
//
// Three things it will never do on its own: attach to a tab nobody shared, re-attach after
// the person pressed Cancel on Chrome's debugging bar, or keep tabs attached while the server
// is unreachable for more than a minute.

import { guard, onServer, siteOf, withinSite } from "./guard.js";
import { normalizeServer } from "./address.js";

const PROTOCOL = "1.3";
const PING_MS = 20_000; // Also what keeps this worker alive: socket traffic resets its idle timer.
const OFFLINE_GRACE_MS = 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const GROUP_TITLE = "Tallylamp";

/** "unpaired" | "pairing" | "connecting" | "online" | "offline" */
let link = "unpaired";
let conn = null; // { server, token, browserId, browserName }
let pairing = null; // { server, deviceCode, userCode, expiresAt }
let ws = null;
let attempts = 0;
let error = null; // Something the person has to act on.
let notice = null; // Something that happened that they should know about.
let fixIn = null; // { id } when the fix is in another extension's settings. `id` if Chrome gave it away.
let releaseAt = null; // When shared tabs are handed back if the server stays unreachable.
let pingTimer, retryTimer, graceTimer, pollTimer;
/** tabId -> { tabId, info: {targetId,url,title}, sites: string[] | null, byAgent: boolean } */
const shared = new Map();

const hostOf = (server) => {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
};
/** The linked server's host, which no shared tab may be on. */
const serverHost = () => (conn ? hostOf(conn.server) : null);

// ---------------------------------------------------------------- state out to the panel

function snapshot() {
  return {
    link,
    host: conn ? hostOf(conn.server) : pairing ? hostOf(pairing.server) : null,
    browserName: conn?.browserName ?? null,
    pairing: pairing ? { userCode: pairing.userCode, expiresAt: pairing.expiresAt, approveUrl: approveUrl(pairing) } : null,
    shared: [...shared.values()].map((t) => ({ tabId: t.tabId, url: t.info.url, title: t.info.title, sites: t.sites, byAgent: t.byAgent })),
    error,
    notice,
    extensions: fixIn,
    releaseAt,
  };
}

function changed() {
  chrome.action.setBadgeText({ text: shared.size ? String(shared.size) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#b8770c" });
  chrome.action.setTitle({
    title: shared.size ? `Tallylamp Link: sharing ${shared.size} tab${shared.size === 1 ? "" : "s"} with your agent` : "Tallylamp Link",
  });
  chrome.storage.session.set({ shared: [...shared.values()].map(({ tabId, sites, byAgent }) => ({ tabId, sites, byAgent })) });
  // Nobody listening just means the panel is closed.
  chrome.runtime.sendMessage({ type: "state", state: snapshot() }).catch(() => {});
}

// ---------------------------------------------------------------- pairing

const approveUrl = (p) => `${p.server}/pair?code=${encodeURIComponent(p.userCode)}`;

function deviceName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const known = ["Brave", "Microsoft Edge", "Opera", "Vivaldi", "Arc", "Google Chrome", "Chromium"];
  const brand = (known.find((b) => brands.includes(b)) ?? "Chromium").replace(/^(Google|Microsoft) /, "");
  const platform = navigator.userAgentData?.platform;
  return platform ? `${brand} on ${platform}` : brand;
}

async function startPairing(rawServer) {
  const parsed = normalizeServer(rawServer);
  if (!parsed.ok) return fail(parsed.error);
  error = null;
  const host = hostOf(parsed.server);
  let res;
  try {
    res = await fetch(`${parsed.server}/api/v1/links/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: deviceName() }),
    });
  } catch {
    // A failed fetch does not say why, and the usual reason is not a dead server. A Tallylamp
    // from before linked browsers answers the CORS preflight with a 401 and no allow-origin
    // header, which the browser reports exactly like a network failure. An opaque no-cors
    // request cannot be blocked that way, so it resolves for any server that is up at all.
    const up = await fetch(`${parsed.server}/api/v1/openapi.json`, { mode: "no-cors" }).then(() => true, () => false);
    return fail(up
      ? `${host} is running, but its Tallylamp is too old to link browsers. Update the server, then connect again.`
      : `Couldn't reach ${host}. Check the address, and that the server is running.`);
  }
  if (res.status === 429) return fail("Too many attempts from this network. Wait a minute, then try again.");
  if (!res.ok) return fail(`${host} answered, but not like a Tallylamp server that can link browsers. It may need updating.`);
  const body = await res.json();
  pairing = { server: parsed.server, deviceCode: body.deviceCode, userCode: body.userCode, expiresAt: Date.now() + body.expiresInSec * 1000 };
  link = "pairing";
  await chrome.storage.local.set({ pairing });
  chrome.tabs.create({ url: approveUrl(pairing) });
  poll();
  changed();
}

function fail(message) {
  error = message;
  changed();
}

function poll() {
  clearTimeout(pollTimer);
  if (!pairing) return;
  pollTimer = setTimeout(async () => {
    if (!pairing) return;
    const stop = async (message) => {
      pairing = null;
      link = "unpaired";
      error = message;
      await chrome.storage.local.remove("pairing");
      changed();
    };
    if (Date.now() > pairing.expiresAt) return stop("That code expired before it was approved. Connect again to get a new one.");
    let body;
    try {
      const res = await fetch(`${pairing.server}/api/v1/links/pair/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: pairing.deviceCode }),
      });
      body = await res.json();
    } catch {
      return poll(); // A dropped request is not a verdict.
    }
    if (body.state === "approved") {
      conn = { server: pairing.server, token: body.token, browserId: body.browserId, browserName: body.browserName };
      pairing = null;
      error = null;
      await chrome.storage.local.set({ conn });
      await chrome.storage.local.remove("pairing");
      return connect();
    }
    if (body.state === "denied") return stop("That request was denied in the dashboard.");
    if (body.state === "expired") return stop("That code expired before it was approved. Connect again to get a new one.");
    poll();
  }, 2_000);
}

async function cancelPairing() {
  clearTimeout(pollTimer);
  pairing = null;
  link = "unpaired";
  error = null;
  await chrome.storage.local.remove("pairing");
  changed();
}

async function unpair(message = null) {
  await unshareAll("disconnected");
  clearTimeout(retryTimer);
  clearTimeout(graceTimer);
  clearInterval(pingTimer);
  const old = ws;
  ws = null;
  old?.close();
  conn = null;
  releaseAt = null;
  link = "unpaired";
  error = null;
  notice = message;
  fixIn = null;
  await chrome.storage.local.remove("conn");
  changed();
}

// ---------------------------------------------------------------- the socket

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const wire = (t) => ({ tabId: t.tabId, info: { targetId: t.info.targetId, type: "page", url: t.info.url, title: t.info.title, browserContextId: t.info.browserContextId } });

function connect() {
  if (!conn || (ws && ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  link = link === "offline" ? "offline" : "connecting";
  changed();
  const socket = new WebSocket(`${conn.server.replace(/^http/, "ws")}/api/v1/links/connect`);
  ws = socket;
  let welcomed = false;
  socket.onopen = () => {
    const version = navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/)?.[1] ?? "";
    // The token goes in the first frame, not the URL, so it never lands in an access log.
    socket.send(JSON.stringify({ event: "hello", token: conn.token, product: `Chrome/${version}`, userAgent: navigator.userAgent, tabs: [...shared.values()].map(wire) }));
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.event === "welcome") {
      welcomed = true;
      attempts = 0;
      link = "online";
      releaseAt = null;
      clearTimeout(graceTimer);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ event: "ping" }), PING_MS);
      return changed();
    }
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      handle(msg.method, msg.params ?? {}).then(
        (result) => send({ id: msg.id, result: result ?? {} }),
        (e) => send({ id: msg.id, error: String(e?.message ?? e) }),
      );
    }
  };
  socket.onclose = (ev) => {
    if (ws !== socket) return;
    ws = null;
    clearInterval(pingTimer);
    if (!conn) return;
    // Refused at hello: the link was revoked in the dashboard, or its browser was deleted.
    // Retrying a revoked token forever would just be noise in somebody's audit log.
    if (!welcomed && /revoked/.test(ev.reason)) return void unpair("This browser was disconnected from the Tallylamp dashboard.");
    link = "offline";
    if (shared.size && !releaseAt) {
      releaseAt = Date.now() + OFFLINE_GRACE_MS;
      graceTimer = setTimeout(() => {
        if (link === "online") return;
        notice = "The server was unreachable for a minute, so your tabs were handed back.";
        unshareAll("server unreachable");
      }, OFFLINE_GRACE_MS);
    }
    retryTimer = setTimeout(connect, BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]);
    changed();
  };
  socket.onerror = () => socket.close();
}

// ---------------------------------------------------------------- what the server may ask for

async function handle(method, params) {
  if (method === "cdp") {
    const tab = shared.get(params.tabId);
    if (!tab) throw new Error("that tab is not shared");
    const verdict = guard({ url: tab.info.url, sites: tab.sites, server: serverHost() }, String(params.method), params.params ?? {});
    if (!verdict.ok) throw new Error(verdict.reason);
    const target = params.sessionId ? { tabId: tab.tabId, sessionId: String(params.sessionId) } : { tabId: tab.tabId };
    return chrome.debugger.sendCommand(target, String(params.method), verdict.params);
  }
  if (method === "tabs.create") {
    if (!shared.size) throw new Error("no tab is shared, so the agent may not open one. Ask the person at this browser to share a tab first");
    // A new tab inherits the narrowest promise already made. If every share is limited to a
    // site, a tab that could go anywhere would make those limits meaningless.
    const all = [...shared.values()];
    const sites = all.some((t) => !t.sites) ? null : [...new Set(all.flatMap((t) => t.sites))];
    const url = String(params.url ?? "about:blank");
    const verdict = guard({ url: "about:blank", sites, server: serverHost() }, "Page.navigate", { url });
    if (!verdict.ok) throw new Error(verdict.reason);
    // about:blank commits at once, and the debugger can only attach to a committed page.
    const created = await chrome.tabs.create({ url: "about:blank", active: false });
    const tab = await share(created.id, { sites, byAgent: true });
    if (url !== "about:blank") await chrome.debugger.sendCommand({ tabId: tab.tabId }, "Page.navigate", { url });
    return { tabId: tab.tabId };
  }
  if (method === "tabs.close") {
    const tab = shared.get(params.tabId);
    if (!tab) throw new Error("that tab is not shared");
    // Closing somebody's own tab can lose their work. The agent may only close what it opened.
    if (!tab.byAgent) throw new Error("this tab belongs to the person at the browser. The agent can only close tabs it opened");
    await chrome.tabs.remove(tab.tabId);
    return {};
  }
  if (method === "tabs.activate") {
    if (!shared.has(params.tabId)) throw new Error("that tab is not shared");
    await chrome.tabs.update(params.tabId, { active: true });
    return {};
  }
  if (method === "window.get") {
    const tabs = await Promise.all([...shared.keys()].map((id) => chrome.tabs.get(id).catch(() => null)));
    const windowId = params.windowId ?? tabs.find((t) => t?.id === params.tabId)?.windowId;
    if (!tabs.some((t) => t?.windowId === windowId)) throw new Error("that window holds no shared tab");
    const w = await chrome.windows.get(windowId);
    return { windowId: w.id, bounds: { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state } };
  }
  if (method === "unshare.all") {
    notice = "Sharing was stopped from the Tallylamp dashboard.";
    await unshareAll(String(params.reason ?? "stopped from Tallylamp"));
    return {};
  }
  throw new Error(`unknown method ${method}`);
}

// ---------------------------------------------------------------- sharing

const CHROME_PAGE = "Chrome doesn't let extensions control this page. Open a normal website to share it.";
const DASHBOARD = "This is your Tallylamp dashboard, where you approve what agents ask for. An agent here could approve its own requests, so it can't be shared.";
const OTHER_EXTENSION = (site) =>
  `Another extension has put a frame inside ${site}, and Chrome won't let an extension control a page with a different extension's frame in it. Stop that extension running on ${site}, reload the page, then share again.`;

const ATTACH_ERRORS = [
  [/chrome:\/\/|chrome-extension:\/\/|Cannot access|cannot be debugged|webstore/i, CHROME_PAGE],
  [/Another debugger/i, "Another tool is already debugging this tab. Close it there, then share again."],
  [/No tab with/i, "That tab was closed."],
];

/**
 * Chrome refuses a tab that holds another extension's frame, and detaches from a shared one the
 * moment such a frame turns up. Its words for that, "Cannot access a chrome-extension:// URL of
 * different extension", read like a browser page. Password managers and other extensions do it
 * to ordinary sites.
 */
const byOtherExtension = (message) => /different extension/i.test(message);

/**
 * The extensions with a frame open anywhere in this browser. Chrome hides other extensions'
 * frames from webNavigation and doesn't say which tab a frame is in, but a refused tab holds at
 * least one of them, so when there is exactly one, that is the extension in the way.
 */
async function otherExtensionFrames() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const ids = targets
    .filter((t) => t.type === "other")
    .map((t) => /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url)?.[1])
    .filter((id) => id && id !== chrome.runtime.id);
  return [...new Set(ids)];
}

async function blockedByExtension(site) {
  const ids = await otherExtensionFrames();
  fixIn = { id: ids.length === 1 ? ids[0] : null };
  return OTHER_EXTENSION(site ?? "this site");
}

/**
 * Only ordinary web pages. Chrome refuses chrome:// and the Web Store by itself, but it lets an
 * extension debug its OWN pages, and CDP on one of those is the extension's privileges: read
 * the link token out of storage, attach to any tab in the browser. Found by loading this into
 * a real Chrome, where the popup page shared without complaint. Never rely on Chrome to say no.
 */
const shareable = (url, byAgent) => Boolean(siteOf(url)) || (byAgent && url === "about:blank");

async function share(tabId, { sites = null, byAgent = false } = {}) {
  if (shared.has(tabId)) return shared.get(tabId);
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current) throw new Error("That tab was closed.");
  const url = current.url || current.pendingUrl || "";
  if (!shareable(url, byAgent)) throw new Error(CHROME_PAGE);
  if (onServer(url, serverHost())) throw new Error(DASHBOARD);
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const message = String(e?.message ?? e);
    if (byOtherExtension(message)) {
      // Kept as the panel's error, not just returned, because it points at a fix elsewhere.
      error = await blockedByExtension(siteOf(url));
      changed();
      throw new Error(error);
    }
    throw new Error(ATTACH_ERRORS.find(([re]) => re.test(message))?.[1] ?? `Chrome wouldn't share this tab: ${message}`);
  }
  let info;
  try {
    // Only announced once attached and answering. The server's clients block on every tab they
    // are told about, so one that then refused the debugger would hang all of them.
    ({ targetInfo: info } = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"));
  } catch (e) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw new Error(`Chrome wouldn't share this tab: ${e?.message ?? e}`);
  }
  const tab = { tabId, info: { targetId: info.targetId, url: info.url, title: info.title, browserContextId: info.browserContextId }, sites, byAgent };
  shared.set(tabId, tab);
  notice = null;
  error = null;
  fixIn = null;
  group(tabId);
  send({ event: "tab.shared", tab: wire(tab) });
  changed();
  return tab;
}

/** A tab group is the one marker Chrome shows in the tab strip itself. Not every Chromium has them. */
async function group(tabId) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const [existing] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId });
    const groupId = await chrome.tabs.group(existing ? { tabIds: tabId, groupId: existing.id } : { tabIds: tabId, createProperties: { windowId } });
    if (!existing) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange" });
  } catch {
    /* decoration; sharing works without it */
  }
}

async function unshare(tabId, reason, { detach = true } = {}) {
  const tab = shared.get(tabId);
  if (!tab) return;
  shared.delete(tabId);
  if (detach) await chrome.debugger.detach({ tabId }).catch(() => {});
  chrome.tabs.ungroup?.(tabId).catch(() => {});
  send({ event: "tab.unshared", tabId, reason });
  if (!shared.size) {
    clearTimeout(graceTimer);
    releaseAt = null;
  }
  changed();
}

async function unshareAll(reason) {
  for (const tabId of [...shared.keys()]) await unshare(tabId, reason);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!shared.has(source.tabId)) return;
  send({ event: "cdp", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId || !shared.has(source.tabId)) return;
  // Cancel on Chrome's debugging bar is the one stop control this extension cannot remove or
  // intercept, so it is treated as exactly what it looks like. Nothing is re-attached.
  if (reason === "canceled_by_user") notice = "You pressed Cancel on Chrome's debugging bar, so sharing stopped.";
  else explainDetach(source.tabId);
  unshare(source.tabId, reason, { detach: false });
});

/**
 * Anything else Chrome calls "target_closed". A closed tab never gets here: onRemoved arrives
 * first and has already handed it back. So the tab is still open, and it either started loading
 * a page Chrome keeps extensions off or another extension's frame turned up in it. Chrome
 * detaches before the tab's address changes, so it is read a moment later.
 */
async function explainDetach(tabId) {
  await new Promise((r) => setTimeout(r, 500));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || shared.has(tabId)) return;
  const url = tab.pendingUrl || tab.url || "";
  const site = siteOf(url);
  if (!site || site === "chromewebstore.google.com" || url.startsWith("https://chrome.google.com/webstore")) {
    notice = "A shared tab opened a page that can't be shared, so it was handed back.";
  } else if ((await otherExtensionFrames()).length) {
    notice = `Sharing stopped. ${await blockedByExtension(site)}`;
  } else {
    notice = `Chrome stopped this extension controlling the tab on ${site}, so it was handed back.`;
  }
  changed();
}

chrome.tabs.onRemoved.addListener((tabId) => unshare(tabId, "tab closed", { detach: false }));

chrome.tabs.onUpdated.addListener((tabId, change, tabNow) => {
  const tab = shared.get(tabId);
  if (!tab || (change.url === undefined && change.title === undefined)) return;
  if (change.url && !shareable(change.url, true)) {
    // However it got there, a shared tab now showing a browser or extension page is one the
    // debugger must not stay attached to.
    notice = "A shared tab opened a page that can't be shared, so it was handed back.";
    return void unshare(tabId, "left the web");
  }
  if (change.url && onServer(change.url, serverHost())) {
    // The guard refuses Page.navigate to it, but a link, a redirect or a script still gets
    // there. This fires as the page commits, before the dashboard has rendered anything to press.
    notice = "A shared tab opened your Tallylamp dashboard, so it was handed back. Agents can't use the page where their requests are approved.";
    return void unshare(tabId, "opened the Tallylamp dashboard");
  }
  if (change.url && tab.sites && change.url !== "about:blank" && !tab.sites.some((s) => withinSite(change.url, s))) {
    // The guard stops the agent navigating away. A link, a redirect or the person themselves
    // still can, and the promise was about the site, so the share ends with it.
    notice = `A shared tab left ${tab.sites.join(", ")} for ${siteOf(change.url) ?? "another page"}, so it was handed back.`;
    return void unshare(tabId, "left the shared site");
  }
  tab.info.url = tabNow.url ?? tab.info.url;
  tab.info.title = tabNow.title ?? tab.info.title;
  send({ event: "tab.updated", tabId, url: tab.info.url, title: tab.info.title });
  changed();
});

// ---------------------------------------------------------------- the panel

const actions = {
  getState: async () => {},
  startPairing: ({ server }) => startPairing(server),
  cancelPairing,
  reopenApproval: async () => pairing && chrome.tabs.create({ url: approveUrl(pairing) }),
  shareTab: async ({ tabId, site }) => {
    if (link !== "online") throw new Error("Not connected to your server yet, so there is nobody to share with.");
    await share(tabId, { sites: site ? [site] : null });
  },
  unshareTab: ({ tabId }) => unshare(tabId, "stopped by the person"),
  stopAll: () => unshareAll("stopped by the person"),
  retry: async () => {
    attempts = 0;
    connect();
  },
  dismiss: async () => {
    notice = null;
    error = null;
    fixIn = null;
    changed();
  },
  // Another extension's details page, where its site access is changed. The list when unknown.
  openExtensions: async ({ id }) => chrome.tabs.create({ url: /^[a-p]{32}$/.test(id ?? "") ? `chrome://extensions/?id=${id}` : "chrome://extensions/" }),
  unpair: () => unpair(),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const action = actions[msg?.type];
  if (!action) return false;
  ready
    .then(() => action(msg))
    .then(() => reply({ ok: true, state: snapshot() }), (e) => reply({ ok: false, error: String(e?.message ?? e), state: snapshot() }));
  return true;
});

// ---------------------------------------------------------------- waking up

// The worker is torn down whenever Chrome likes. Debugger attachments outlive it, so what was
// shared has to be read back and checked against reality before anything is claimed.
async function boot() {
  const stored = await chrome.storage.local.get(["conn", "pairing"]);
  conn = stored.conn ?? null;
  pairing = stored.pairing ?? null;
  const { shared: was = [] } = await chrome.storage.session.get("shared");
  for (const entry of was) {
    try {
      const { targetInfo: info } = await chrome.debugger.sendCommand({ tabId: entry.tabId }, "Target.getTargetInfo");
      // Shared by a version that let the dashboard be shared.
      if (onServer(info.url, serverHost())) {
        await chrome.debugger.detach({ tabId: entry.tabId }).catch(() => {});
        continue;
      }
      shared.set(entry.tabId, { tabId: entry.tabId, info: { targetId: info.targetId, url: info.url, title: info.title, browserContextId: info.browserContextId }, sites: entry.sites ?? null, byAgent: Boolean(entry.byAgent) });
    } catch {
      /* no longer attached: not shared, whatever the note said */
    }
  }
  if (pairing) {
    link = "pairing";
    poll();
  } else if (conn) {
    connect();
  }
  changed();
}

const ready = boot();

// The toolbar icon opens a side panel, not a popup. A popup closes the moment you click
// anything else, which is exactly when this is needed: beside the approval page while the two
// codes are compared, and beside a shared tab while an agent works in it. Not every Chromium
// has side panels, so where the API is missing or refuses, the same page opens as a popup.
(async () => {
  try {
    if (!chrome.sidePanel?.setPanelBehavior) throw new Error("no side panel here");
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.action.setPopup({ popup: "" });
  } catch {
    await chrome.action.setPopup({ popup: "panel.html?popup=1" });
  }
})();

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => ready.then(() => (pairing ? poll() : connect())));
chrome.runtime.onStartup.addListener(() => {});
