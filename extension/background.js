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

import { extensionFrameIn, extensionUrl, guard, onServer, siteOf, withinSite } from "./guard.js";
import { normalizeServer } from "./address.js";

const PROTOCOL = "1.3";
const PING_MS = 20_000; // Also what keeps this worker alive: socket traffic resets its idle timer.
const CONNECT_TIMEOUT_MS = 10_000;
const PONG_TIMEOUT_MS = 10_000;
const OFFLINE_GRACE_MS = 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const GROUP_TITLE = "Tallylamp";
// The toolbar badge: the shared-tab count on the same red as the panel's on-air card, and "!" on
// amber while those tabs are about to be handed back. White text reads on both.
const BADGE_LIVE = "#dc2626";
const BADGE_OFFLINE = "#b45309";
const ACTIVITY_KEEP = 6; // Lines of "what was just done" kept per shared tab.
const ACTIVITY_MERGE_MS = 4_000; // Keystrokes and clicks this close together read as one line.
const ACTIVITY_PUBLISH_MS = 500; // Typing would otherwise repaint the panel on every key.

/** "unpaired" | "pairing" | "connecting" | "online" | "offline" */
let link = "unpaired";
let conn = null; // { server, token, browserId, browserName }
let pairing = null; // { server, deviceCode, userCode, expiresAt }
let ws = null;
let attempts = 0;
let error = null; // Something the person has to act on.
let notice = null; // Something that happened that they should know about.
let noticeAbout = null; // { kind, tabId }: which kind of thing, so the panel can title it and offer the way back.
let fixIn = null; // { id, site, kind } when the fix is in another extension's settings. `id` if Chrome gave it away.
let lastServer = null; // The address last connected to, so a person connecting again types nothing.
let sharedOnce = false; // The panel walks a first share through its steps, and stops once there has been one.
let releaseAt = null; // When shared tabs are handed back if the server stays unreachable.
let pingTimer, retryTimer, graceTimer, pollTimer;
/** tabId -> { tabId, info: {targetId,url,title}, sites: string[] | null, byAgent: boolean, since: number, activity: [] } */
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
    server: conn?.server ?? pairing?.server ?? null,
    lastServer,
    browserName: conn?.browserName ?? null,
    pairing: pairing ? { userCode: pairing.userCode, expiresAt: pairing.expiresAt, approveUrl: approveUrl(pairing) } : null,
    shared: [...shared.values()].map((t) => ({ tabId: t.tabId, url: t.info.url, title: t.info.title, sites: t.sites, byAgent: t.byAgent, since: t.since, activity: t.activity })),
    error,
    notice,
    noticeKind: noticeAbout?.kind ?? null,
    noticeTabId: noticeAbout?.tabId ?? null,
    extensions: fixIn,
    releaseAt,
    sharedOnce,
  };
}

/** Something that happened that the person should know about. `kind` is for the panel, the words are for the person. */
function tell(kind, text = null, tabId = null) {
  notice = text;
  noticeAbout = text ? { kind, tabId } : null;
}

let publicationPending = false;
let badgeState = null;
let storedState = null;
let broadcastState = null;

function changed() {
  // State/permission changes themselves are synchronous. Collapse notifications in this
  // turn, so one Stop all or a burst of tab metadata events paints the final state once.
  if (publicationPending) return;
  publicationPending = true;
  Promise.resolve().then(() => {
    publicationPending = false;
    const away = shared.size > 0 && link === "offline";
    const badge = `${shared.size}:${away}`;
    if (badgeState !== badge) {
      const tabs = `${shared.size} tab${shared.size === 1 ? "" : "s"}`;
      chrome.action.setBadgeText({ text: away ? "!" : shared.size ? String(shared.size) : "" });
      if (shared.size) {
        chrome.action.setBadgeBackgroundColor({ color: away ? BADGE_OFFLINE : BADGE_LIVE });
        chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
      }
      chrome.action.setTitle({
        title: away ? `Tallylamp Link: can't reach ${serverHost()}. Your ${tabs} will be handed back if it stays unreachable`
          : shared.size ? `Tallylamp Link: sharing ${tabs} with your agent` : "Tallylamp Link",
      });
      badgeState = badge;
    }
    const persisted = { shared: [...shared.values()].map(({ tabId, sites, byAgent, since }) => ({ tabId, sites, byAgent, since })), releaseAt };
    const key = JSON.stringify(persisted);
    if (storedState !== key) {
      storedState = key;
      chrome.storage.session.set(persisted).catch(() => { if (storedState === key) storedState = null; });
    }
    const state = snapshot();
    const signature = JSON.stringify(state);
    if (broadcastState !== signature) {
      broadcastState = signature;
      // Nobody listening just means the panel is closed; opening it requests fresh state.
      chrome.runtime.sendMessage({ type: "state", state }).catch(() => {});
    }
  });
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
  lastServer = parsed.server;
  await chrome.storage.local.set({ pairing, lastServer });
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
  tell("disconnected", message);
  fixIn = null;
  await chrome.storage.local.remove("conn");
  changed();
}

// ---------------------------------------------------------------- the socket

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const wire = (t) => ({ tabId: t.tabId, info: { targetId: t.info.targetId, type: "page", url: t.info.url, title: t.info.title, browserContextId: t.info.browserContextId } });

function offlineGrace() {
  if (!shared.size) return;
  releaseAt ??= Date.now() + OFFLINE_GRACE_MS;
  clearTimeout(graceTimer);
  const release = () => {
    if (link === "online") return;
    tell("unreachable", "The server was unreachable for a minute, so your tabs were handed back.");
    return unshareAll("server unreachable");
  };
  if (releaseAt <= Date.now()) return release();
  graceTimer = setTimeout(release, releaseAt - Date.now());
}

function connect() {
  if (!conn || (ws && ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  link = link === "offline" ? "offline" : "connecting";
  changed();
  const socket = new WebSocket(`${conn.server.replace(/^http/, "ws")}/api/v1/links/connect`);
  ws = socket;
  let welcomed = false;
  let pongTimer;
  // Neither a DNS/TCP connection nor the application's welcome may wait forever. Closing a
  // half-open socket can itself take time, so retry without waiting for Chrome's close event.
  const helloTimer = setTimeout(() => disconnected(), CONNECT_TIMEOUT_MS);
  function disconnected(ev = {}) {
    clearTimeout(helloTimer);
    clearTimeout(pongTimer);
    if (ws !== socket) return;
    ws = null;
    clearInterval(pingTimer);
    socket.close();
    if (!conn) return;
    if (!welcomed && /revoked/.test(ev.reason ?? "")) return void unpair("This browser was disconnected from the Tallylamp dashboard.");
    link = "offline";
    offlineGrace();
    retryTimer = setTimeout(connect, BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]);
    changed();
  }
  socket.onopen = () => {
    if (ws !== socket) return;
    const version = navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/)?.[1] ?? "";
    // The token goes in the first frame, not the URL, so it never lands in an access log.
    socket.send(JSON.stringify({ event: "hello", token: conn.token, product: `Chrome/${version}`, userAgent: navigator.userAgent, tabs: [...shared.values()].map(wire) }));
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.event === "welcome") {
      if (welcomed) return;
      welcomed = true;
      clearTimeout(helloTimer);
      attempts = 0;
      link = "online";
      releaseAt = null;
      clearTimeout(graceTimer);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws !== socket) return;
        // Sending proves only that Chrome accepted bytes. A pong proves the server is there.
        pongTimer = setTimeout(() => disconnected(), PONG_TIMEOUT_MS);
        socket.send(JSON.stringify({ event: "ping" }));
      }, PING_MS);
      return changed();
    }
    if (msg.event === "pong") {
      clearTimeout(pongTimer);
      return;
    }
    if (welcomed && typeof msg.id === "number" && typeof msg.method === "string") {
      const reply = (result) => {
        // A command belongs to the socket that asked. Request IDs start over on reconnect.
        if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
      };
      handle(msg.method, msg.params ?? {}).then(
        (result) => reply({ id: msg.id, result: result ?? {} }),
        (e) => reply({ id: msg.id, error: String(e?.message ?? e) }),
      );
    }
  };
  socket.onclose = disconnected;
  socket.onerror = () => disconnected();
}

// ---------------------------------------------------------------- what the server may ask for

async function handle(method, params) {
  if (method === "cdp") {
    const tab = shared.get(params.tabId);
    if (!tab) throw new Error("that tab is not shared");
    const verdict = guard({ url: tab.info.url, sites: tab.sites, server: serverHost() }, String(params.method), params.params ?? {});
    if (!verdict.ok) throw new Error(verdict.reason);
    const sessionId = params.sessionId ? String(params.sessionId) : undefined;
    if (walled.has(sessionId)) throw new Error(`${params.method} is not allowed on a linked browser: that frame belongs to another extension.`);
    if (children.has(sessionId)) {
      // A frame Chrome announced before it had an address may hold another extension's page by
      // now, and an agent that never turns on Page or Runtime would not be told. So ask first.
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId: tab.tabId, sessionId }, "Target.getTargetInfo").catch(() => ({}));
      const url = extensionUrl(targetInfo?.url);
      if (url) {
        await wallOff(tab.tabId, sessionId, children.get(sessionId)?.parent, url, true);
        throw new Error(`${params.method} is not allowed on a linked browser: that frame belongs to another extension.`);
      }
    }
    const target = sessionId ? { tabId: tab.tabId, sessionId } : { tabId: tab.tabId };
    noteActivity(tab, String(params.method), verdict.params ?? {});
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
    if (url !== "about:blank") {
      noteActivity(tab, "Page.navigate", { url });
      await chrome.debugger.sendCommand({ tabId: tab.tabId }, "Page.navigate", { url });
    }
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
    tell("dashboard-stop", "Sharing was stopped from the Tallylamp dashboard.");
    await unshareAll(String(params.reason ?? "stopped from Tallylamp"));
    return {};
  }
  throw new Error(`unknown method ${method}`);
}

// ---------------------------------------------------------------- what the panel says was done

let activitySeq = 0;
let activityTimer = null;

const where = (url) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return null;
  }
};

/**
 * The few commands a person would recognise as doing something: opening a page, clicking,
 * scrolling, typing, pressing a key, attaching a file. Only the kind and a count are kept, never
 * what was typed, and none of it leaves the browser. Screenshots, scripts and the many reads an
 * agent's tooling makes are left out: they say nothing a person could check, and the dashboard's
 * own viewer takes screenshots too. Input from someone taking over in the dashboard arrives the
 * same way as the agent's, which is why the panel says "through Tallylamp", not "by your agent".
 */
function activityOf(method, params) {
  switch (method) {
    case "Page.navigate": return { kind: "open", where: where(params.url) };
    case "Page.reload": return { kind: "reload" };
    case "Page.navigateToHistoryEntry": return { kind: "history" };
    case "Input.insertText": return params.text ? { kind: "type", n: [...String(params.text)].length } : null;
    case "Input.dispatchMouseEvent":
      if (params.type === "mouseWheel") return { kind: "scroll" };
      return params.type === "mousePressed" && (params.clickCount ?? 1) <= 1 ? { kind: "click" } : null;
    case "Input.dispatchTouchEvent": return params.type === "touchStart" ? { kind: "tap" } : null;
    case "Input.dispatchKeyEvent": {
      if (params.type !== "keyDown" && params.type !== "rawKeyDown") return null;
      // Enter arrives with text "\r"; that is a key press, not a character typed.
      if (params.text && !/[\u0000-\u001f\u007f]/.test(params.text)) return { kind: "type", n: [...String(params.text)].length };
      return params.key ? { kind: "key", key: String(params.key).slice(0, 16) } : null;
    }
    case "DOM.setFileInputFiles": return { kind: "file" };
    default: return null;
  }
}

function noteActivity(tab, method, params) {
  const act = activityOf(method, params);
  if (!act) return;
  const now = Date.now();
  const last = tab.activity[0];
  if (act.kind !== "open" && last?.kind === act.kind && last.key === act.key && now - last.at < ACTIVITY_MERGE_MS) {
    last.n += act.n ?? 1;
    last.at = now;
  } else {
    tab.activity = [{ id: ++activitySeq, ...act, n: act.n ?? 1, at: now }, ...tab.activity].slice(0, ACTIVITY_KEEP);
  }
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = null;
    changed();
  }, ACTIVITY_PUBLISH_MS);
}

// ---------------------------------------------------------------- sharing

const CHROME_PAGE = "Chrome doesn't let extensions control this page. Open a normal website to share it.";
const DASHBOARD = "This is your Tallylamp dashboard, where you approve what agents ask for. An agent here could approve its own requests, so it can't be shared.";
const FRAME_HELP = "https://tallylamp.dev/guides/another-extension-blocks-sharing";
const FLAGGED = (site) =>
  `Another extension has a frame inside ${site}. Chrome let the tab share anyway, which usually means its "Extensions on chrome-extension:// URLs" flag is on. Your agent has been kept out of that frame.`;
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
  fixIn = { id: ids.length === 1 ? ids[0] : null, site: site ?? null, kind: "blocked" };
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
  const since = Date.now();
  const tab = {
    tabId, info: { targetId: info.targetId, url: info.url, title: info.title, browserContextId: info.browserContextId }, sites, byAgent,
    since, activity: byAgent ? [{ id: ++activitySeq, kind: "newtab", n: 1, at: since }] : [],
  };
  shared.set(tabId, tab);
  tell(null);
  error = null;
  fixIn = null;
  if (!sharedOnce) {
    sharedOnce = true;
    chrome.storage.local.set({ sharedOnce }).catch(() => {});
  }
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
  for (const sessions of [children, walled]) for (const [id, s] of sessions) if (s.tabId === tabId) sessions.delete(id);
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
  // Each unshare removes its permission before the first await. Revoke every tab now,
  // then wait for Chrome's independent detach calls together instead of one round trip each.
  await Promise.all([...shared.keys()].map(tabId => unshare(tabId, reason)));
}

// ---------------------------------------------------------------- other extensions' frames

/** Child sessions the agent was handed (frames, workers), by session id: { tabId, parent }. */
const children = new Map();
/**
 * Sessions shut out of another extension's frame: { tabId, told }. `told` if the agent heard
 * the session announced before its frame gave itself away, so it also hears it end.
 */
const walled = new Map();

/**
 * Detach the debugger from another extension's frame and say so. Chrome only lets one this far
 * when chrome://flags "Extensions on chrome-extension:// URLs" is on, and there is no API to
 * read flags, so this is also how the panel finds out.
 */
async function wallOff(tabId, sessionId, parent, url, told) {
  if (walled.has(sessionId)) return;
  walled.set(sessionId, { tabId, told });
  children.delete(sessionId);
  await chrome.debugger.sendCommand(parent ? { tabId, sessionId: parent } : { tabId }, "Target.detachFromTarget", { sessionId }).catch(() => {});
  const site = siteOf(shared.get(tabId)?.info.url ?? "");
  tell("flagged", FLAGGED(site ?? "this site"), tabId);
  fixIn = { id: /^chrome-extension:\/\/([a-p]{32})/.exec(url)?.[1] ?? null, site, kind: "flagged" };
  changed();
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!shared.has(source.tabId)) return;
  if (walled.has(source.sessionId)) return;
  if (method === "Target.detachedFromTarget" && walled.has(params.sessionId) && !walled.get(params.sessionId).told) return;
  if (method === "Target.attachedToTarget") {
    const url = extensionFrameIn(method, params);
    if (url) return void wallOff(source.tabId, params.sessionId, source.sessionId, url, false);
    children.set(params.sessionId, { tabId: source.tabId, parent: source.sessionId });
  } else if (children.has(source.sessionId)) {
    const url = extensionFrameIn(method, params);
    if (url) return void wallOff(source.tabId, source.sessionId, children.get(source.sessionId).parent, url, true);
  }
  if (method === "Target.detachedFromTarget") children.delete(params.sessionId);
  send({ event: "cdp", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId || !shared.has(source.tabId)) return;
  // Cancel on Chrome's debugging bar is the one stop control this extension cannot remove or
  // intercept, so it is treated as exactly what it looks like. Nothing is re-attached.
  if (reason === "canceled_by_user") tell("cancel", "You pressed Cancel on Chrome's debugging bar, so sharing stopped.", source.tabId);
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
    tell("left-web", "A shared tab opened a page that can't be shared, so it was handed back.", tabId);
  } else if ((await otherExtensionFrames()).length) {
    tell("blocked", `Sharing stopped. ${await blockedByExtension(site)}`, tabId);
  } else {
    tell("detached", `Chrome stopped this extension controlling the tab on ${site}, so it was handed back.`, tabId);
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
    tell("left-web", "A shared tab opened a page that can't be shared, so it was handed back.", tabId);
    return void unshare(tabId, "left the web");
  }
  if (change.url && onServer(change.url, serverHost())) {
    // The guard refuses Page.navigate to it, but a link, a redirect or a script still gets
    // there. This fires as the page commits, before the dashboard has rendered anything to press.
    tell("opened-dashboard", "A shared tab opened your Tallylamp dashboard, so it was handed back. Agents can't use the page where their requests are approved.", tabId);
    return void unshare(tabId, "opened the Tallylamp dashboard");
  }
  if (change.url && tab.sites && change.url !== "about:blank" && !tab.sites.some((s) => withinSite(change.url, s))) {
    // The guard stops the agent navigating away. A link, a redirect or the person themselves
    // still can, and the promise was about the site, so the share ends with it.
    tell("left-site", `A shared tab left ${tab.sites.join(", ")} for ${siteOf(change.url) ?? "another page"}, so it was handed back.`, tabId);
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
    tell(null);
    error = null;
    fixIn = null;
    changed();
  },
  // Another extension's details page, where its site access is changed. The list when unknown.
  openExtensions: async ({ id }) => chrome.tabs.create({ url: /^[a-p]{32}$/.test(id ?? "") ? `chrome://extensions/?id=${id}` : "chrome://extensions/" }),
  // The fixes, and what the Chrome flag that lifts the rule costs, are too long for the panel.
  openFrameHelp: async () => chrome.tabs.create({ url: FRAME_HELP }),
  unpair: () => unpair(),
};

// The keyboard shortcut (Alt+Shift+S unless the person changed it in chrome://extensions/shortcuts)
// shares the tab in front, kept to its site, or stops sharing it. It works with the panel shut, so
// when sharing can't happen the panel opens to say why. A key press counts as a user gesture, but
// only until this listener returns, so the panel is opened before anything is awaited.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== "toggle-share" || !tab?.id) return;
  const explain = () => chrome.sidePanel?.open?.({ tabId: tab.id })?.catch(() => {});
  if (shared.has(tab.id)) return void unshare(tab.id, "stopped by the person");
  const site = siteOf(tab.url ?? "");
  if (link !== "online" || !site || onServer(tab.url, serverHost())) {
    if (conn && link !== "online") fail("Not connected to your server yet, so there is nobody to share with.");
    return void explain();
  }
  ready.then(() => share(tab.id, { sites: [site] })).catch((e) => {
    error = String(e?.message ?? e);
    changed();
    explain();
  });
});

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
  const stored = await chrome.storage.local.get(["conn", "pairing", "lastServer", "sharedOnce"]);
  conn = stored.conn ?? null;
  pairing = stored.pairing ?? null;
  lastServer = stored.lastServer ?? conn?.server ?? null;
  sharedOnce = Boolean(stored.sharedOnce);
  const { shared: was = [], releaseAt: deadline } = await chrome.storage.session.get(["shared", "releaseAt"]);
  releaseAt = Number.isFinite(deadline) ? deadline : null;
  // Check independent attachments four at a time. Keep the persisted tab order, and publish
  // nothing until every attachment has been verified (including the dashboard exclusion).
  const restored = new Array(was.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, was.length) }, async () => {
    while (next < was.length) {
      const index = next++;
      const entry = was[index];
      try {
        const { targetInfo: info } = await chrome.debugger.sendCommand({ tabId: entry.tabId }, "Target.getTargetInfo");
        if (onServer(info.url, serverHost())) {
          await chrome.debugger.detach({ tabId: entry.tabId }).catch(() => {});
          continue;
        }
        const tab = {
          tabId: entry.tabId, info: { targetId: info.targetId, url: info.url, title: info.title, browserContextId: info.browserContextId },
          sites: entry.sites ?? null, byAgent: Boolean(entry.byAgent), since: Number.isFinite(entry.since) ? entry.since : Date.now(), activity: [],
        };
        restored[index] = tab;
        // Register immediately so Chrome's detach/navigation events can revoke this tab
        // while the other attachment checks are still pending.
        shared.set(entry.tabId, tab);
      } catch {
        /* no longer attached: not shared, whatever the note said */
      }
    }
  }));
  const verified = restored.filter(tab => tab && shared.get(tab.tabId) === tab);
  shared.clear();
  for (const tab of verified) shared.set(tab.tabId, tab);
  if (pairing) {
    link = "pairing";
    poll();
  } else if (conn) {
    // Worker restarts during a DNS outage must not renew the minute-long sharing grace.
    await offlineGrace();
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
