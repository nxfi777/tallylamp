// The side panel. One job: hand this tab to the agent, see that the agent has it, take it back.
//
// It stays open while the person switches tabs, so "this tab" is whichever one is in front
// right now and the share card follows it. Where a browser has no side panels the same page
// opens as a popup (?popup=1), which only changes its width.
//
// panel.html?demo=<state> renders a fixture with no extension APIs at all, so every state can
// be looked at in an ordinary browser tab. States: unpaired, unpaired-error, pairing,
// connecting, ready, unshareable, dashboard, other-extension, shared-here, shared-elsewhere,
// offline, notice.

import { onServer, siteOf } from "./guard.js";

const app = document.getElementById("app");
const query = new URLSearchParams(location.search);
const demo = query.get("demo");
if (query.has("popup")) document.documentElement.classList.add("popup");

let state = null;
let activeTab = null;
let busy = false; // A click is in flight. Buttons say so and stop taking clicks.
let justShared = false;
let limitToSite = true;
let typed = "";
let tick;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function ask(type, extra = {}) {
  if (demo) return;
  busy = true;
  render();
  try {
    const res = await chrome.runtime.sendMessage({ type, ...extra });
    if (res?.state) state = res.state;
    if (res && !res.ok) state = { ...state, error: res.error };
    return res;
  } finally {
    busy = false;
    render();
  }
}

// ---------------------------------------------------------------- pieces

function bar() {
  const s = {
    unpaired: ["", "Not connected"],
    pairing: ["waiting", "Waiting for approval"],
    connecting: ["waiting", "Connecting"],
    online: ["online", "Connected"],
    offline: ["offline", "Offline"],
  }[state.link];
  return h("div", { class: "bar" },
    // The mark itself, copied from the dashboard. It carries its own light and dark amber.
    h("div", { class: "brand" }, h("img", { class: "lamp", src: "icons/mark.svg", alt: "", width: "18", height: "18" }), "Tallylamp Link"),
    h("div", { class: `status ${s[0]}`, role: "status" }, h("i", { "aria-hidden": "true" }), s[1]),
  );
}

/** "mail.example.com only", or "linear.app · any site · opened by agent". Words, not pills: two
    pills beside a hostname ran out of room at 360px and cut each other off mid-word. */
function scopeLine(t) {
  const host = siteOf(t.url);
  const parts = t.sites ? [`${t.sites.join(", ")} only`] : [host, "any site"];
  if (t.byAgent) parts.push("opened by agent");
  return parts.filter(Boolean).join(" · ");
}

function tabLine(tab, caption) {
  const host = siteOf(tab.url);
  return h("div", { class: "tab" },
    // A round letter, never an empty rounded square: that is exactly what an unticked
    // checkbox looks like, and there is a real checkbox directly underneath.
    tab.favIconUrl ? h("img", { src: tab.favIconUrl, alt: "" }) : h("span", { class: "fav", "aria-hidden": "true" }, (host ?? "·").slice(0, 1).toUpperCase()),
    h("div", { class: "words" },
      h("div", { class: "title" }, tab.title || "Untitled tab"),
      h("div", { class: "host" }, caption ?? host ?? "A page built into the browser"),
    ),
  );
}

function banners() {
  const out = [];
  if (state.link === "offline") {
    const secs = state.releaseAt ? Math.max(0, Math.ceil((state.releaseAt - Date.now()) / 1000)) : null;
    out.push(h("div", { class: "banner warn", role: "alert" },
      h("div", { class: "grow" },
        `Can't reach ${state.host}. Trying again.`,
        secs !== null && state.shared.length ? ` Your shared tabs will be handed back in ${secs}s if it stays unreachable.` : "",
      ),
      h("button", { class: "link", onclick: () => ask("retry") }, "Try now"),
    ));
  }
  // The fix for another extension's frame is in that extension's settings, so the way there
  // goes under whichever message explains it. Its own line: two links beside the text crowd it.
  const fix = state.extensions
    ? h("div", { style: "margin-top:6px" }, h("button", { class: "link", onclick: () => ask("openExtensions", { id: state.extensions.id }) }, state.extensions.id ? "Show that extension" : "Open your extensions"))
    : null;
  const error = state.error && state.link !== "unpaired";
  if (error) out.push(h("div", { class: "banner err", role: "alert" }, h("div", { class: "grow" }, state.error, fix), h("button", { class: "link", onclick: () => ask("dismiss") }, "OK")));
  if (state.notice) out.push(h("div", { class: "banner warn", role: "status" }, h("div", { class: "grow" }, state.notice, error ? null : fix), h("button", { class: "link", onclick: () => ask("dismiss") }, "OK")));
  return out;
}

// ---------------------------------------------------------------- screens

function unpaired() {
  const submit = (e) => {
    e.preventDefault();
    ask("startPairing", { server: typed });
  };
  return h("form", { class: "stack", onsubmit: submit, novalidate: true },
    h("div", {},
      h("h1", {}, "Connect this browser"),
      h("p", { class: "muted" }, "Link it to your Tallylamp server. After that you share tabs with your agent one at a time."),
    ),
    h("div", {},
      h("label", { class: "field", for: "server" }, "Server address"),
      h("input", {
        id: "server", type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false", autofocus: true,
        placeholder: "tallylamp.example.com", value: typed,
        "aria-invalid": state.error ? "true" : null, "aria-describedby": state.error ? "server-err" : "server-hint",
        oninput: (e) => { typed = e.target.value; },
      }),
      state.error
        ? h("p", { class: "fielderr", id: "server-err", role: "alert" }, state.error)
        : h("p", { class: "small muted", id: "server-hint", style: "margin-top:6px" }, "Next you approve this browser in your dashboard. There is nothing to copy or paste."),
    ),
    h("button", { class: "primary", type: "submit", disabled: busy }, busy ? "Contacting your server…" : "Connect"),
    h("p", { class: "small muted" }, "Works in Chrome, Edge, Brave, Vivaldi, Opera and Arc. Firefox and Safari don't give extensions this kind of access, so they can't be linked."),
  );
}

function pairingScreen() {
  return h("div", { class: "stack" },
    h("div", {},
      h("p", { class: "eyebrow" }, "Step 2 of 3"),
      h("h1", {}, "Approve this code in your dashboard"),
      h("p", { class: "muted" }, `The approval page for ${state.host} opened in a new tab. Check it shows this same code, then approve.`),
    ),
    h("div", { class: "code", "aria-label": `Pairing code ${state.pairing.userCode.split("").join(" ")}` }, state.pairing.userCode),
    h("div", { class: "row" },
      h("button", { class: "grow", onclick: () => ask("reopenApproval") }, "Open the approval page again"),
      h("button", { class: "quiet", onclick: () => ask("cancelPairing") }, "Cancel"),
    ),
    h("p", { class: "small muted" }, "The code works for 10 minutes and only once. On its own it opens nothing: somebody signed in to your dashboard has to approve it."),
  );
}

function shareCard() {
  const tab = activeTab;
  const here = tab && state.shared.find((t) => t.tabId === tab.id);
  const site = tab ? siteOf(tab.url) : null;

  if (here) {
    return h("div", { class: "card" },
      tabLine(tab, scopeLine(here)),
      justShared
        ? h("div", { class: "banner ok", role: "status" }, h("div", {}, h("b", {}, "Shared. "), `Tell your agent to use the browser called “${state.browserName}”.`))
        : h("p", { class: "small muted" }, `Your agent can see and control this tab. It finds it as “${state.browserName}”.`),
      h("button", { class: "stop wide", disabled: busy, onclick: () => { justShared = false; ask("unshareTab", { tabId: tab.id }); } }, "Stop sharing this tab"),
    );
  }

  const dashboard = Boolean(tab) && onServer(tab.url, state.host);
  if (!tab || !site || dashboard) {
    return h("div", { class: "card" },
      tab ? tabLine(tab) : null,
      h("button", { class: "primary", disabled: true, "aria-describedby": "why-not" }, "Can't share this page"),
      h("p", { class: "small muted", id: "why-not" }, dashboard
        ? "This is your Tallylamp dashboard, where you approve what agents ask for. An agent here could approve its own requests, so it can't be shared."
        : "Chrome doesn't let extensions control its own pages, the Web Store or local files. Open an ordinary website and share that."),
    );
  }

  const waiting = state.link !== "online";
  return h("div", { class: "card" },
    tabLine(tab),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: limitToSite, onchange: (e) => { limitToSite = e.target.checked; render(); } }),
      h("span", {}, `Keep the agent on ${site}`,
        h("span", { class: "hint" }, limitToSite ? `If this tab leaves ${site}, sharing stops.` : "The agent can take this tab to any website, signed in as you wherever you are.")),
    ),
    h("button", {
      class: "primary", disabled: busy || waiting,
      onclick: async () => {
        const res = await ask("shareTab", { tabId: tab.id, site: limitToSite ? site : null });
        justShared = Boolean(res?.ok);
        render();
      },
    }, busy ? "Sharing…" : state.link === "connecting" ? "Connecting to your server…" : waiting ? "Can't share while offline" : "Share this tab"),
    h("p", { class: "small muted" }, "Your agent will see and control this tab, signed in as you. Chrome shows a debugging bar while anything is shared, and Cancel on that bar stops sharing too."),
  );
}

function paired() {
  // Offline, nothing can be shared, so a share card would be a large dead control sitting on
  // top of the one list that matters: the tabs about to be handed back, each with its Stop.
  const offline = state.link === "offline";
  const others = state.shared.filter((t) => offline || t.tabId !== activeTab?.id);
  return h("div", { class: "fill" }, h("div", { class: "body" },
    h("div", { class: "stack" }, banners(), offline ? null : shareCard()),
    offline && !others.length ? h("p", { class: "muted", style: "margin-top:12px" }, "Nothing is shared right now. You can share a tab again once the server is back.") : null,
    others.length ? [
      h("h2", { class: "heading" }, state.shared.length === others.length ? "Shared with your agent" : "Also shared"),
      h("ul", { class: "list" }, others.map((t) => h("li", {},
        h("div", { class: "grow", style: "min-width:0" }, tabLine(t, scopeLine(t))),
        h("button", { class: "stop", disabled: busy, "aria-label": `Stop sharing ${t.title || "this tab"}`, onclick: () => ask("unshareTab", { tabId: t.tabId }) }, "Stop"),
      ))),
    ] : null,
    state.shared.length > 1 ? h("button", { class: "stop wide", style: "margin-top:10px", disabled: busy, onclick: () => ask("stopAll") }, `Stop sharing all ${state.shared.length} tabs`) : null,
    ),
    h("footer", {},
      h("span", { class: "grow", title: `${state.browserName} on ${state.host}` }, `${state.browserName} · ${state.host}`),
      h("button", { class: "link", disabled: busy, onclick: () => ask("unpair") }, "Disconnect"),
    ),
  );
}

function render() {
  if (!state) return;
  clearInterval(tick);
  // Keep the caret where it was: the form is rebuilt on every state change.
  const focused = document.activeElement?.id;
  app.replaceChildren(bar(), state.link === "unpaired" ? unpaired() : state.link === "pairing" ? pairingScreen() : paired());
  if (focused) document.getElementById(focused)?.focus();
  if (state.link === "offline" && state.releaseAt) tick = setInterval(render, 1000);
}

// ---------------------------------------------------------------- start

const DEMO_TAB = { id: 1, title: "Inbox (3) · Example Mail", url: "https://mail.example.com/inbox" };
const base = { link: "online", host: "tallylamp.example.com", browserName: "Chrome on macOS", pairing: null, shared: [], error: null, notice: null, extensions: null, releaseAt: null };
const also = [
  { tabId: 2, title: "Q3 forecast · Sheets", url: "https://sheets.example.com/d/1", sites: ["sheets.example.com"], byAgent: false },
  { tabId: 3, title: "Pricing · Linear", url: "https://linear.app/pricing", sites: null, byAgent: true },
];
const DEMOS = {
  unpaired: { ...base, link: "unpaired", host: null, browserName: null },
  "unpaired-error": { ...base, link: "unpaired", host: null, browserName: null, error: "Couldn't reach tallylamp.example.com. Check the address, and that the server is running." },
  pairing: { ...base, link: "pairing", browserName: null, pairing: { userCode: "KXQ7-M2PD", expiresAt: Date.now() + 600_000, approveUrl: "#" } },
  connecting: { ...base, link: "connecting" },
  ready: base,
  unshareable: base,
  dashboard: base,
  "other-extension": {
    ...base,
    error: "Another extension has put a frame inside mail.example.com, and Chrome won't let an extension control a page with a different extension's frame in it. Stop that extension running on mail.example.com, reload the page, then share again.",
    extensions: { id: "abcdefghijklmnopabcdefghijklmnop" },
  },
  "shared-here": { ...base, shared: [{ tabId: 1, title: DEMO_TAB.title, url: DEMO_TAB.url, sites: ["mail.example.com"], byAgent: false }] },
  "shared-elsewhere": { ...base, shared: also },
  offline: { ...base, link: "offline", shared: also, releaseAt: Date.now() + 42_000 },
  notice: { ...base, notice: "You pressed Cancel on Chrome's debugging bar, so sharing stopped." },
};

if (demo) {
  state = DEMOS[demo] ?? DEMOS.ready;
  activeTab = demo === "unshareable"
    ? { id: 9, title: "Extensions", url: "chrome://extensions" }
    : demo === "dashboard" ? { id: 8, title: "Browsers · Tallylamp", url: "https://tallylamp.example.com/browsers" } : DEMO_TAB;
  justShared = demo === "shared-here";
  if (demo === "unpaired-error") typed = "tallylamp.example.com";
  render();
} else {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "state") return;
    state = msg.state;
    render();
  });
  // The panel outlives the tab it was opened on. Every switch re-asks which tab is in front,
  // and a new tab starts from the safe choices again: site limit on, no "Shared." still showing
  // from the tab before.
  const followTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== activeTab?.id) {
      justShared = false;
      limitToSite = true;
    }
    activeTab = tab ?? null;
    render();
  };
  chrome.tabs.onActivated.addListener(followTab);
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === activeTab?.id && (change.url || change.title || change.favIconUrl)) followTab();
  });
  const res = await chrome.runtime.sendMessage({ type: "getState" });
  state = res.state;
  await followTab();
}
