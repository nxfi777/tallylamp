// The side panel. One job: hand this tab to the agent, see that the agent has it, take it back.
//
// It stays open while the person switches tabs, so "this tab" is whichever one is in front
// right now and the share card follows it. Where a browser has no side panels the same page
// opens as a popup (?popup=1), which only changes its width.
//
// panel.html?demo=<state> renders a fixture with no extension APIs at all, so every state can
// be looked at in an ordinary browser tab. States: unpaired, unpaired-error, pairing, linked,
// connecting, ready, unshareable, dashboard, other-extension, shared-here, shared-connecting,
// shared-elsewhere, offline, notice, notice-left, flagged. &tab=2 puts another fixture tab in front.

import { onServer, siteOf } from "./guard.js";
// A copy of the dashboard's dashboard/vendor, kept identical by tests/linked-extension.test.ts.
import { orb } from "./vendor/orbs.js";
import { normalizeServer } from "./address.js";

const PRIVACY = "https://tallylamp.dev/privacy";
const SHORTCUTS = "chrome://extensions/shortcuts";
const GRACE_MS = 60_000; // background.js OFFLINE_GRACE_MS: how long an unreachable server keeps the tabs.
const CODE_MS = 600_000; // A pairing code lasts ten minutes.
const app = document.getElementById("app");
const query = new URLSearchParams(location.search);
const demo = query.get("demo");
if (query.has("popup")) document.documentElement.classList.add("popup");

let state = null;
let activeTab = null;
let windowTabs = []; // The window's tabs, for "share one of these instead" and the way back to a tab.
let busy = null; // The action in flight. Its button says so, and every button stops taking clicks.
let justShared = false;
let justLinked = false; // This panel watched the approval land: worth one line of "it worked".
let limitToSite = true;
let typed = "";
let shortcut = /Mac/.test(globalThis.navigator?.platform ?? "") ? "⌥⇧S" : "Alt+Shift+S";
let lastView = null;
let viewSince = 0;
let lastStep = null;
let lastError = null;
let errorSeq = 0;
let prefilled = false;
let collapseUntil = 0; // The first share just happened: the steps fold away, once.

// ---------------------------------------------------------------- building blocks

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null || k === "key") continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  // Every control carries a key that survives a repaint, so focus can be put back where it was.
  // A label that changes while busy ("Sharing…") gets a fixed one.
  if (tag === "button" || tag === "input") el.setAttribute("data-k", attrs.key ?? attrs.id ?? attrs["aria-label"] ?? el.textContent);
  return el;
}

/** Lucide icons (ISC), drawn as currentColor strokes. Constant markup, never anything a page sent. */
const ICONS = {
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  stop: '<rect width="13" height="13" x="5.5" y="5.5" rx="2"/>',
  wifioff: '<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M19 12.86a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  puzzle: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  pointer: '<path d="M12.586 12.586 19 19"/><path d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  scroll: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
};

function icon(name, cls = "") {
  const el = h("span", { class: `ico ${cls}`, "aria-hidden": "true" });
  el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] ?? ""}</svg>`;
  return el;
}

/** When each thing was first drawn. The panel is rebuilt on every change, and one click brings
    three or four changes in a few milliseconds, so an entrance animation is given a negative delay
    of its age: a repaint halfway through resumes it instead of restarting it or cutting it off. */
const firstDrawn = new Map();
function drawnAt(key) {
  if (!firstDrawn.has(key)) firstDrawn.set(key, Date.now());
  return firstDrawn.get(key);
}
function entering(key, ms, since = drawnAt(key)) {
  const age = Date.now() - since;
  return age < ms ? { cls: " in", style: `--age:${-age}ms` } : { cls: "", style: null };
}

/** Chrome reports whatever icon a page names, and this panel may load only some of them. A page
    belonging to another extension names an icon inside that extension (daily.dev's new tab
    does), which Chrome refuses to load here and files on chrome://extensions as an error against
    Tallylamp Link. chrome:// and file:// icons are refused the same way. */
const loadable = (url) => /^(https?|data):/.test(url ?? "");

function fav(tab, cls = "") {
  const host = siteOf(tab.url ?? "");
  return h("span", { class: `fav ${cls}`, "aria-hidden": "true" },
    loadable(tab.favIconUrl) ? h("img", { src: tab.favIconUrl, alt: "" }) : (host ?? "·").slice(0, 1).toUpperCase());
}

/** The address without its scheme, as a person would say it. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url || "A page built into the browser";
  }
}

function kbds(keys) {
  if (!keys) return null;
  const parts = keys.includes("+") ? keys.split("+") : [...keys];
  return h("span", { class: "kbds", "aria-hidden": "true" }, parts.map((k) => h("kbd", { class: "kbd" }, k)));
}

/** "Only mail.example.com", or "Any site · opened by your agent". */
function scopeWords(t) {
  return [t.sites ? `Only ${t.sites.join(", ")}` : "Any site", t.byAgent ? "opened by your agent" : null].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- the clock

/** Elements whose text follows the clock: countdowns, time shared, how long ago. Collected as
    they are built, so a tick touches only them and never repaints the panel. Each returns
    whether it still needs ticking. */
let timed = [];
let ticker;

const pad = (n) => String(n).padStart(2, "0");
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  return hh ? `${hh}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 5 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

/** A text node kept in step with the clock. `show(now)` returns [text, stillTicking]. */
function clock(show) {
  const el = h("span", {});
  const update = (now) => {
    const [text, more] = show(now);
    el.textContent = text;
    return more;
  };
  update.el = el;
  timed.push(update);
  return el;
}

function tick() {
  const now = Date.now();
  let more = false;
  for (const update of timed) more = update(now) || more;
  return more;
}

function updateTimers() {
  clearInterval(ticker);
  if (!tick() || document.visibilityState === "hidden") return;
  ticker = setInterval(() => {
    if (!tick()) clearInterval(ticker);
  }, 1000);
}
document.addEventListener("visibilitychange", updateTimers);

// ---------------------------------------------------------------- talking to the worker

async function ask(type, extra = {}) {
  if (demo) return;
  busy = type;
  render();
  try {
    const res = await chrome.runtime.sendMessage({ type, ...extra });
    if (res?.state) onState(res.state);
    if (res && !res.ok) state = { ...state, error: res.error };
    return res;
  } finally {
    busy = null;
    render();
  }
}

/** Every new state from the worker passes through here, so the moments worth marking are seen once. */
function onState(next) {
  if (state?.link === "pairing" && next.link !== "pairing" && next.link !== "unpaired") justLinked = true;
  if (state && !state.sharedOnce && next.sharedOnce) collapseUntil = Date.now() + 1_200;
  if (next.link === "unpaired" || next.shared.length) justLinked = false;
  state = next;
}

const openTab = (url) => (demo ? null : chrome.tabs.create({ url }));
const goTo = (tabId) => (demo ? null : chrome.tabs.update(tabId, { active: true }));
const openDashboard = () => state.server && openTab(state.server);

async function copyName() {
  await navigator.clipboard?.writeText(state.browserName).catch(() => {});
  toast(`Copied “${state.browserName}”.`);
}

// ---------------------------------------------------------------- header and footer

function header() {
  const [tone, words] = {
    unpaired: ["", "Not connected"],
    pairing: ["wait", "Waiting for approval"],
    connecting: ["wait", "Connecting"],
    online: ["ok", "Connected"],
    offline: ["off", "Offline"],
  }[state.link];
  return h("header", { class: "xp-h" },
    // The mark itself, copied from the dashboard. It carries its own light and dark amber.
    h("span", { class: "xp-mark" }, h("img", { src: "icons/mark.svg", alt: "", width: "16", height: "16" })),
    h("span", { class: "xp-name" }, "Tallylamp Link"),
    h("span", { class: "grow" }, h("span", { class: `xp-link ${tone}`, role: "status" }, h("i", { "aria-hidden": "true" }), h("span", {}, words))),
    h("button", { class: "btn ghost icon sm", id: "more", "aria-label": "More", "aria-haspopup": "menu", "aria-expanded": menu ? "true" : "false", onclick: openMenu }, icon("more")),
  );
}

function footer() {
  if (state.link === "unpaired" || state.link === "pairing") return null;
  return h("footer", { class: "xp-f" },
    h("span", { class: "who", title: `${state.browserName} on ${state.host}` }, h("b", {}, state.browserName), ` · ${state.host}`),
    h("button", { class: "btn ghost xs", onclick: openDashboard }, "Dashboard", icon("ext", "s12")),
  );
}

// ---------------------------------------------------------------- connecting

const STEPS = ["Connect", "Approve", "Share"];

/** Three short bars. Moving on fills the next one in, from where the panel last drew it. The
    same node is kept while the step stays put, so a repaint never restarts its motion. */
let steps = { key: null, el: null };
function stepper(at, { collapse = false } = {}) {
  const key = `${at}:${collapse}`;
  if (steps.key === key) return steps.el;
  const from = lastStep ?? at;
  lastStep = at;
  const cls = (i, step) => `xstep ${i < step ? "done" : i === step ? "on" : ""}`;
  const items = STEPS.map((name, i) => h("li", { class: cls(i, from), "aria-current": i === at ? "step" : null },
    h("span", { class: "lbl" }, i < at ? icon("check", "s12") : null, name),
    h("span", { class: "bar", "aria-hidden": "true" }, h("i", {}))));
  if (from !== at && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(() => items.forEach((li, i) => { li.className = cls(i, at); })));
  }
  const el = h("ol", { class: `xsteps${collapse ? " collapse" : ""}`, "aria-label": `Step ${Math.min(at + 1, 3)} of 3` }, items);
  steps = { key, el };
  return el;
}

function connectView() {
  if (!prefilled && state.lastServer) typed ||= shortUrl(state.lastServer);
  prefilled = true;
  if (state.error && state.error !== lastError) errorSeq++;
  lastError = state.error;
  const shake = state.error ? entering(`shake:${errorSeq}`, 320) : { cls: "", style: null };
  const expired = /expired/.test(state.error ?? "");
  const preview = h("p", { class: "xurl", id: "server-hint", "aria-live": "polite" });
  const showPreview = () => {
    const parsed = typed.trim() ? normalizeServer(typed) : null;
    preview.className = `xurl${parsed && !parsed.ok ? " soft" : ""}`;
    preview.replaceChildren(...(!parsed
      ? ["Next you approve this browser in your dashboard. There is nothing to copy or paste."]
      : parsed.ok ? [icon("check", "s12"), h("span", {}, "Connects to ", h("b", {}, parsed.server))]
        : [icon("alert", "s12"), h("span", {}, parsed.error)]));
  };
  if (!state.error) showPreview();
  const submit = (e) => {
    e.preventDefault();
    // The same mistake twice still shakes: the field forgets the old error as the new try starts.
    state = { ...state, error: null };
    lastError = null;
    ask("startPairing", { server: typed });
  };
  return [
    stepper(0),
    noticeCard(),
    h("div", {},
      h("h2", {}, "Connect this browser"),
      h("p", { class: "lede" }, "Link it to your Tallylamp server. Then you share tabs with your agent one at a time."),
    ),
    h("form", { class: "field", onsubmit: submit, novalidate: true },
      h("label", { class: "label", for: "server" }, "Server address"),
      h("input", {
        class: `input${shake.cls ? " shake" : ""}`, style: shake.style, id: "server", type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false", autofocus: true,
        placeholder: "tallylamp.example.com", value: typed,
        "aria-invalid": state.error ? "true" : null, "aria-describedby": state.error ? "server-err" : "server-hint",
        oninput: (e) => {
          typed = e.target.value;
          if (!state.error) showPreview();
        },
      }),
      state.error ? h("p", { class: "field-err", id: "server-err", role: "alert" }, icon("alert", "s12"), h("span", {}, state.error)) : preview,
      h("button", { class: `btn primary lg block${busy ? " busy" : ""}`, type: "submit", key: "connect", disabled: Boolean(busy), style: "margin-top:6px" },
        busy === "startPairing" ? [h("span", { class: "spinner", "aria-hidden": "true" }), "Contacting your server…"] : expired ? "Get a new code" : "Connect"),
    ),
    // Said here, before anything is sent, and not only in the policy: the Web Store asks for
    // disclosure in the product itself, and this is the moment somebody decides.
    h("div", { class: "xpriv" }, icon("lock", "s14"),
      h("p", {}, "This extension talks only to the server you enter here. It sends a tab's contents only after you share that tab. ",
        h("a", { href: PRIVACY, target: "_blank", rel: "noopener" }, "Privacy policy"))),
    h("p", { class: "xfine" }, "Works in Chrome, Edge, Brave, Vivaldi, Opera and Arc. Firefox and Safari don't give extensions this kind of access, so they can't be linked."),
  ];
}

function pairingView() {
  const { userCode, expiresAt } = state.pairing;
  const C = 2 * Math.PI * 6;
  const ring = h("span", {});
  ring.innerHTML = `<svg class="xring" viewBox="0 0 16 16" aria-hidden="true"><circle class="bg" cx="8" cy="8" r="6"/><circle class="fg" cx="8" cy="8" r="6" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>`;
  const exp = h("p", { class: "xexp" }, ring);
  exp.append(clock((now) => {
    const left = expiresAt - now;
    exp.className = `xexp${left < 60_000 ? " low" : ""}`;
    ring.querySelector?.(".fg")?.setAttribute("stroke-dashoffset", String(C * (1 - Math.max(0, left) / CODE_MS)));
    return left > 0 ? [`Expires in ${elapsed(left)}`, true] : ["Expired", false];
  }));
  return [
    stepper(1),
    h("div", {},
      h("h2", {}, "Approve this code in your dashboard"),
      h("p", { class: "lede" }, `The approval page for ${state.host} opened in a new tab. Check it shows this same code, then approve.`),
    ),
    h("div", { class: "xcodebox" },
      (() => {
        const e = entering(`code:${userCode}`, 700);
        return h("div", { class: `xcode${e.cls}`, style: e.style, role: "img", "aria-label": `Pairing code ${userCode.split("").join(" ")}` },
          [...userCode].map((c, i) => h("span", { class: c === "-" ? "dash" : null, style: `--i:${i}`, "aria-hidden": "true" }, c)));
      })(),
      exp,
    ),
    h("div", { class: "xwait" },
      orb("listening", 20),
      h("div", {},
        h("p", { class: "t" }, "Waiting for your approval"),
        h("p", { class: "d" }, "This panel moves on by itself once you approve."))),
    h("div", { class: "row" },
      h("button", { class: "btn grow", disabled: Boolean(busy), onclick: () => ask("reopenApproval") }, "Reopen the approval page", icon("ext", "s12")),
      h("button", { class: "btn ghost", disabled: Boolean(busy), onclick: () => ask("cancelPairing") }, "Cancel"),
    ),
    h("p", { class: "xfine" }, "The code works for 10 minutes and only once. On its own it opens nothing: somebody signed in to your dashboard has to approve it."),
  ];
}

// ---------------------------------------------------------------- banners

function banner(tone, ico, title, detail, { acts = null, dismiss = null, key = null, extra = null, role = "status" } = {}) {
  const e = entering(key ?? `${tone}:${title}`, 260);
  return h("div", { class: `xban ${tone}${e.cls}`, style: e.style, role },
    h("div", { class: "top" },
      typeof ico === "string" ? icon(ico) : ico,
      h("div", { class: "grow" }, h("p", { class: "t" }, title), detail ? h("p", { class: "d" }, detail) : null),
      dismiss ? h("button", { class: "btn ghost icon xs x", "aria-label": "Dismiss", onclick: dismiss }, icon("x", "s14")) : null),
    acts ? h("div", { class: "acts" }, acts) : null,
    extra,
  );
}

const NOTICES = {
  unreachable: ["off", "wifioff", "Your tabs were handed back"],
  "dashboard-stop": ["info", "info", "Stopped from the dashboard"],
  cancel: ["info", "stop", "Sharing stopped"],
  "left-web": ["warn", "alert", "A shared tab was handed back"],
  "left-site": ["warn", "alert", "A shared tab left its site"],
  "opened-dashboard": ["warn", "shield", "A shared tab was handed back"],
  detached: ["warn", "alert", "Chrome stopped sharing a tab"],
  flagged: ["warn", "puzzle", "Your agent was kept out of another extension's frame"],
  disconnected: ["info", "info", "This browser was disconnected"],
};

/** What happened while nobody was looking, titled by kind, with the way back to the tab when there is one. */
function noticeCard() {
  if (!state.notice || state.extensions?.kind === "blocked") return null;
  const [tone, ico, title] = NOTICES[state.noticeKind] ?? ["info", "info", "Sharing stopped"];
  const tab = state.noticeTabId && state.noticeTabId !== activeTab?.id && windowTabs.find((t) => t.id === state.noticeTabId);
  const acts = [
    tab && ["left-site", "detached", "cancel"].includes(state.noticeKind)
      ? h("button", { class: "btn sm", onclick: () => goTo(tab.id) }, "Go to the tab", icon("right", "s12")) : null,
    state.noticeKind === "flagged" ? extensionLinks() : null,
  ].filter(Boolean);
  return banner(tone, ico, title, state.notice, { acts: acts.length ? acts : null, dismiss: () => ask("dismiss"), key: `notice:${state.notice}` });
}

function extensionLinks() {
  const id = state.extensions?.id;
  return [
    h("button", { class: "linkbtn", onclick: () => ask("openExtensions", { id }) }, id ? "Show that extension" : "Open your extensions"),
    h("button", { class: "linkbtn", onclick: () => ask("openFrameHelp") }, "Why, and other fixes"),
  ];
}

function offlineBanner() {
  const releaseAt = state.shared.length ? state.releaseAt : null;
  const drain = h("i", {});
  const words = releaseAt
    ? ["Trying again. Your shared tabs are handed back in ", clock((now) => {
      const left = releaseAt - now;
      drain.setAttribute("style", `transform:scaleX(${Math.max(0, Math.min(1, left / GRACE_MS))})`);
      return [`${Math.max(0, Math.ceil(left / 1000))}s`, left > 0];
    }), " if it stays unreachable."]
    : "Trying again. Nothing is shared, so nothing is waiting on it.";
  return banner("off", "wifioff", `Can't reach ${state.host}`, words, {
    key: "offline",
    role: "alert",
    acts: [h("button", { class: "btn sm", key: "retry", disabled: Boolean(busy), onclick: () => ask("retry") }, busy === "retry" ? "Trying…" : "Try now")],
    extra: releaseAt ? h("span", { class: "xdrain", "aria-hidden": "true" }, drain) : null,
  });
}

// ---------------------------------------------------------------- the tab in front

function tabRow(tab) {
  const web = Boolean(siteOf(tab.url ?? ""));
  return h("div", { class: "xtab" }, fav(tab),
    h("div", { class: "m" }, h("p", { class: "t" }, tab.title || "Untitled tab"),
      h("p", { class: web ? "u" : "u plain" }, web ? shortUrl(tab.url) : "A page built into the browser")));
}

function shareCard(tab, site) {
  const connecting = state.link !== "online";
  const pick = (only) => {
    limitToSite = only;
  };
  const share = async () => {
    const res = await ask("shareTab", { tabId: tab.id, site: limitToSite ? site : null });
    justShared = Boolean(res?.ok);
    render();
  };
  return h("section", { class: "xcard", "aria-label": "Share this tab" },
    tabRow(tab),
    h("fieldset", { class: "xscope" },
      h("legend", { class: "sr" }, "Where your agent may take this tab"),
      h("label", { class: "xopt" },
        h("input", { type: "radio", name: "scope", key: "scope:only", checked: limitToSite, onchange: () => pick(true) }),
        h("div", {}, h("p", { class: "t" }, `Only ${site}`, h("span", { class: "badge ok" }, "Recommended")),
          h("p", { class: "d" }, `If the tab leaves ${site}, sharing stops.`))),
      h("label", { class: "xopt risky" },
        h("input", { type: "radio", name: "scope", key: "scope:any", checked: !limitToSite, onchange: () => pick(false) }),
        h("div", {}, h("p", { class: "t" }, "Any site"),
          h("p", { class: "d" }, "Your agent can take this tab anywhere, signed in as you.")))),
    h("div", { class: "xshare" },
      h("button", { class: `btn primary lg block${busy ? " busy" : ""}`, key: "share", disabled: Boolean(busy) || connecting, onclick: share, "aria-keyshortcuts": shortcut || null },
        busy === "shareTab" ? [h("span", { class: "spinner", "aria-hidden": "true" }), "Sharing…"]
          : connecting ? "Connecting to your server…" : ["Share this tab", kbds(shortcut)]),
      h("p", { class: "xwhy" }, `Your agent sees and controls this tab through ${state.host}, signed in as you. Chrome shows a debugging bar while anything is shared, and Cancel on that bar stops sharing too.`)),
  );
}

const ACTIVITY = {
  open: ["globe", (a) => ["Opened ", h("b", {}, a.where ?? "a page")]],
  newtab: ["plus", () => "Opened this tab"],
  reload: ["reload", () => "Reloaded the page"],
  history: ["back", () => "Went back or forward"],
  click: ["pointer", (a) => (a.n > 1 ? `Clicked ${a.n} times` : "Clicked")],
  tap: ["pointer", (a) => (a.n > 1 ? `Tapped ${a.n} times` : "Tapped")],
  scroll: ["scroll", () => "Scrolled"],
  type: ["type", (a) => `Typed ${a.n} character${a.n === 1 ? "" : "s"}`],
  key: ["keyboard", (a) => ["Pressed ", h("b", {}, a.key), a.n > 1 ? ` ×${a.n}` : ""]],
  file: ["file", () => "Attached a file"],
};

// The agent counts as at work for this long after its newest action: long enough to span a
// model's pause between calls, the same window the dashboard uses.
const WORKING_MS = 15_000;

/** "Working", beside the feed's heading while the agent's newest action is that fresh. */
function working(at) {
  const el = h("span", { class: "xfeed-now" }, orb("working", 20), "Working");
  const update = (now) => {
    el.hidden = !(at && now - at < WORKING_MS);
    return !el.hidden;
  };
  update.el = el;
  update(Date.now());
  timed.push(update);
  return el;
}

function feed(entry, cardDrawn) {
  const events = entry.activity ?? [];
  return h("div", { class: "xfeed", id: "feed" },
    h("p", { class: "xfeed-h" }, "Activity through Tallylamp", working(events[0]?.at)),
    events.length
      ? h("ul", { style: "margin:0;padding:0;list-style:none", "aria-live": "polite" }, events.map((a) => {
        const [ico, words] = ACTIVITY[a.kind] ?? ["pointer", () => a.kind];
        const at = drawnAt(`ev:${a.id}`);
        const e = at - cardDrawn > 100 ? entering(`ev:${a.id}`, 360) : { cls: "", style: null };
        return h("li", { class: `xev${e.cls}`, style: e.style },
          icon(ico, "s14"), h("span", { class: "w" }, words(a)),
          h("span", { class: "ago" }, clock((now) => [ago(now - a.at), true])));
      }))
      : h("p", { class: "xfeed-empty" }, "Nothing yet. Pages opened, clicks and typing in this tab show up here as they happen. What was typed is never kept."),
  );
}

function stop(entry) {
  justShared = false;
  ask("unshareTab", { tabId: entry.tabId }).then((res) => {
    if (!res?.ok) return;
    // Undo shares it again with the same limit. It cannot quietly resume the old share: Chrome
    // shows its debugging bar again, and that is the point.
    const undo = !entry.byAgent && (entry.sites?.length ?? 0) <= 1
      ? () => ask("shareTab", { tabId: entry.tabId, site: entry.sites?.[0] ?? null }).then((r) => { justShared = Boolean(r?.ok); render(); })
      : null;
    toast(`Stopped sharing “${entry.title || "the tab"}”.`, { action: undo && "Undo", onAction: undo, ms: 6000 });
  });
}

/** The tab in front is the agent's: say so loudly, say for how long and how far it may go, and keep Stop in reach. */
function airCard(tab, entry) {
  const paused = state.link !== "online";
  const key = `air:${entry.tabId}:${entry.since}`;
  const e = entering(key, 420);
  return h("section", { class: `xcard xair${paused ? " paused" : ""}${e.cls}`, style: e.style, "aria-label": "Shared with your agent" },
    h("div", { class: "xair-top" },
      h("span", { class: "dot", "aria-hidden": "true" }),
      paused ? "Reconnecting." : "Shared with your agent",
      h("span", { class: "since", title: "Shared for" }, clock((now) => [elapsed(now - (entry.since ?? now)), true]))),
    tabRow(tab),
    h("p", { class: "xscope-line" }, icon(entry.sites ? "lock" : "globe", "s12"), scopeWords(entry)),
    paused
      ? h("p", { class: "xname paused" }, "Your agent can use this tab again once the connection returns.")
      : h("div", { class: "xname" },
        h("p", { class: "grow" }, justShared
          ? [h("b", {}, "Shared. "), "Tell your agent to use the browser called “", h("b", {}, state.browserName), "”."]
          : ["Your agent can see and control this tab. It finds it as “", h("b", {}, state.browserName), "”."]),
        h("button", { class: "btn ghost icon xs", "aria-label": "Copy browser name", title: "Copy browser name", onclick: copyName }, icon("copy", "s14"))),
    feed(entry, drawnAt(key)),
    h("div", { class: "xair-foot" },
      h("button", { class: "btn danger lg block", disabled: Boolean(busy), onclick: () => stop(entry), "aria-keyshortcuts": shortcut || null },
        icon("stop", "s14"), "Stop sharing this tab", kbds(shortcut))),
  );
}

/** Up to three tabs in this window that could be shared instead, one click to bring each to the front. */
function picks() {
  const ok = windowTabs.filter((t) => t.id !== activeTab?.id && siteOf(t.url ?? "") && !onServer(t.url, state.host) && !state.shared.some((s) => s.tabId === t.id)).slice(0, 3);
  if (!ok.length) return null;
  return h("div", { class: "xpick" },
    h("p", { class: "sec-h" }, "Share one of these instead"),
    ok.map((t) => h("button", { onclick: () => goTo(t.id) }, fav(t, "sm"), h("span", { class: "t" }, t.title || shortUrl(t.url)), icon("right", "s14"))));
}

function cantShareCard(tab) {
  const dashboard = Boolean(tab) && onServer(tab.url, state.host);
  const [ico, title, words] = !tab
    ? ["info", "No tab in front", "Open the website you want to hand over, and this panel offers to share it."]
    : dashboard
      ? ["shield", "This is your Tallylamp dashboard", "It's where you approve what agents ask for. An agent here could approve its own requests, so it can't be shared."]
      : ["lock", "Chrome keeps this page to itself", "Chrome doesn't let extensions control its own pages, the Web Store or local files. Open an ordinary website and share that."];
  return h("section", { class: "xcard" },
    tab ? tabRow(tab) : null,
    h("div", { class: "xinfo", style: tab ? "border-top:1px solid var(--line)" : null },
      h("span", { class: "ic" }, icon(ico)), h("h3", {}, title), h("p", {}, words)),
    picks(),
  );
}

/** Chrome refused the tab, or let go of it, because another extension has a frame inside it. */
function extensionCard() {
  const fix = state.extensions;
  const site = fix.site ?? "this site";
  const here = activeTab && siteOf(activeTab.url ?? "") === fix.site && !state.shared.some((t) => t.tabId === activeTab.id);
  return h("section", { class: "xcard", role: "alert" },
    h("div", { class: "xinfo" },
      h("div", { class: "row" },
        h("span", { class: "ic warn" }, icon("puzzle")),
        h("span", { class: "grow" }),
        h("button", { class: "btn ghost icon xs", "aria-label": "Dismiss", onclick: () => ask("dismiss") }, icon("x", "s14"))),
      h("h3", {}, state.error ? "Another extension is in the way" : "Sharing stopped: another extension got in the way"),
      h("p", {}, `It has put a frame inside ${site}, and Chrome won't let one extension control a page that holds another extension's frame.`),
      h("ol", { class: "xsteps-ol" },
        h("li", {}, fix.id ? "Open that extension's details." : "Open your extensions and find the one that runs on this site."),
        h("li", {}, `Set its site access to “On click”, or turn it off for ${site}.`),
        h("li", {}, "Reload the page and share it again.")),
      h("div", { class: "acts" },
        h("button", { class: "btn sm", onclick: () => ask("openExtensions", { id: fix.id }) }, fix.id ? "Show that extension" : "Open your extensions", icon("ext", "s12")),
        here ? h("button", { class: "btn sm primary", key: "reload-share", disabled: Boolean(busy), onclick: reloadAndShare }, busy === "reload" ? "Reloading…" : "Reload and share") : null,
        h("button", { class: "linkbtn", onclick: () => ask("openFrameHelp") }, "Why, and other fixes"))),
  );
}

/** One click for step three: reload, wait for the page to finish, share with the same limit. */
async function reloadAndShare() {
  const tab = activeTab;
  const site = siteOf(tab.url ?? "");
  busy = "reload";
  render();
  const loaded = new Promise((resolve) => {
    const done = (tabId, change) => {
      if (tabId !== tab.id || change.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 10_000);
  });
  await chrome.tabs.reload(tab.id).catch(() => {});
  await loaded;
  const res = await ask("shareTab", { tabId: tab.id, site: limitToSite ? site : null });
  justShared = Boolean(res?.ok);
  render();
}

function alsoShared(others, offline) {
  if (!others.length) return null;
  const all = state.shared.length;
  return [
    h("p", { class: "sec-h" }, all === others.length ? "Shared with your agent" : "Also shared", h("span", { class: "cnt" }, String(others.length)),
      all > 1 ? h("button", { class: "btn danger xs", disabled: Boolean(busy), onclick: () => ask("stopAll").then((r) => r?.ok && toast(`Stopped sharing ${all} tabs.`)) }, `Stop all ${all}`) : null),
    h("ul", { class: "xlist", style: "margin:0;padding:0;list-style:none" }, others.map((t) => h("li", { class: "xrow" },
      fav(windowTabs.find((w) => w.id === t.tabId) ?? { url: t.url }, "sm"),
      h("div", { class: "m" }, h("p", { class: "t" }, t.title || "Untitled tab"),
        h("p", { class: "s" }, h("span", {}, t.sites ? `Only ${t.sites.join(", ")}` : "Any site"), t.byAgent ? h("span", { class: "badge human" }, "opened by your agent") : null)),
      h("span", { class: "acts" },
        offline ? null : h("button", { class: "btn ghost icon sm", "aria-label": `Go to ${t.title || "the tab"}`, title: "Go to the tab", onclick: () => goTo(t.tabId) }, icon("right", "s14")),
        h("button", { class: "btn danger sm", disabled: Boolean(busy), "aria-label": `Stop sharing ${t.title || "this tab"}`, onclick: () => stop(t) }, "Stop")),
    ))),
  ];
}

function pairedView() {
  const offline = state.link === "offline";
  const tab = activeTab;
  const here = tab && state.shared.find((t) => t.tabId === tab.id);
  const site = tab ? siteOf(tab.url ?? "") : null;
  const blocked = state.extensions?.kind === "blocked" && (state.error || state.notice);
  // The fix card ends in Reload and share, so a second Share for the same site would compete with it.
  const fixing = blocked && site && site === state.extensions.site;
  // Offline, nothing can be shared, so a share card would be a large dead control sitting on
  // top of the one list that matters: the tabs about to be handed back, each with its Stop.
  const others = state.shared.filter((t) => offline || t.tabId !== tab?.id);
  return [
    !state.sharedOnce ? stepper(2) : Date.now() < collapseUntil ? stepper(3, { collapse: true }) : null,
    justLinked && !state.shared.length
      ? banner("ok", (() => {
        const e = entering("linked-check", 600);
        const s = h("span", { class: `xcheck${e.cls}`, style: e.style, "aria-hidden": "true" });
        s.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
        return s;
      })(), `Linked to ${state.host}`, "Now open the tab you want to hand over and press Share.", { dismiss: () => { justLinked = false; render(); }, key: "linked" })
      : null,
    offline ? offlineBanner() : null,
    blocked ? extensionCard() : null,
    state.error && !blocked ? banner("err", "alert", state.error, null, { dismiss: () => ask("dismiss"), key: `error:${state.error}`, role: "alert" }) : null,
    noticeCard(),
    offline || (fixing && !here) ? null : here ? airCard(tab, here) : site && !onServer(tab.url, state.host) ? shareCard(tab, site) : cantShareCard(tab),
    offline && !others.length ? h("p", { class: "xfine" }, "Nothing is shared right now. You can share a tab again once the server is back.") : null,
    alsoShared(others, offline),
  ];
}

// ---------------------------------------------------------------- menu, dialog, toasts

let menu = null;

// The trigger is looked up each time: a repaint replaces it while the menu stays open.
const trigger = () => document.getElementById("more");
function closeMenu(refocus = false) {
  if (!menu) return;
  menu.remove();
  menu = null;
  trigger()?.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", outside, true);
  if (refocus) trigger()?.focus();
}
const outside = (e) => menu && !menu.contains(e.target) && !trigger()?.contains(e.target) && closeMenu();

/** Everything that is not the job itself: the dashboard, the browser's name, the shortcut, the policy, and Disconnect. */
function openMenu() {
  if (menu) return closeMenu(true);
  const paired = state.link !== "unpaired" && state.link !== "pairing";
  const item = (ico, label, run, { keys = null, danger = false } = {}) => h("button", {
    class: `mi${danger ? " danger" : ""}`, role: "menuitem", tabindex: "-1",
    onclick: () => { closeMenu(); run(); },
  }, icon(ico), label, kbds(keys));
  const items = [
    state.server && paired ? item("ext", "Open dashboard", openDashboard) : null,
    paired && state.browserName ? item("copy", "Copy browser name", copyName) : null,
    item("keyboard", shortcut ? "Keyboard shortcut" : "Set a keyboard shortcut", () => openTab(SHORTCUTS), { keys: shortcut }),
    item("lock", "Privacy policy", () => openTab(PRIVACY)),
    paired ? h("div", { class: "msep", role: "separator" }) : null,
    paired ? item("logout", "Disconnect…", confirmDisconnect, { danger: true }) : null,
  ];
  const el = h("div", {
    class: "menu", role: "menu", "aria-label": "More",
    onkeydown: (e) => {
      const list = [...el.querySelectorAll(".mi")];
      const at = list.indexOf(document.activeElement);
      const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
      if (move !== undefined) {
        e.preventDefault();
        list[(move + list.length) % list.length].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(true);
      } else if (e.key === "Tab") closeMenu();
    },
  }, items);
  document.body.append(el);
  menu = el;
  trigger()?.setAttribute("aria-expanded", "true");
  el.querySelector(".mi")?.focus();
  document.addEventListener("pointerdown", outside, true);
}

function confirmDisconnect() {
  const dialog = document.getElementById("confirm");
  const n = state.shared.length;
  dialog.replaceChildren(h("form", { method: "dialog" },
    h("div", { class: "dlg-h" },
      h("h2", { id: "confirm-title" }, "Disconnect this browser?"),
      h("p", {}, `${n ? `Your ${n === 1 ? "shared tab is" : `${n} shared tabs are`} handed back, and this` : "This"} browser stops talking to ${state.host}. To link it again you connect and approve it in the dashboard.`)),
    h("div", { class: "dlg-f" },
      h("button", { class: "btn", value: "cancel", autofocus: true }, "Cancel"),
      h("button", { class: "btn danger-solid", value: "disconnect" }, "Disconnect"))));
  dialog.returnValue = "";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "disconnect") ask("unpair");
  }, { once: true });
  dialog.showModal();
}

let toastTimer;
function toast(text, { action = null, onAction = null, ms = 4000 } = {}) {
  const box = document.getElementById("toasts");
  clearTimeout(toastTimer);
  const dismiss = () => {
    clearTimeout(toastTimer);
    el.classList.add("out");
    setTimeout(() => el.remove(), 200);
  };
  const el = h("div", { class: "toast" }, icon("check", "s14"), h("p", { class: "grow" }, text),
    action ? h("button", { class: "btn xs", onclick: () => { dismiss(); onAction(); } }, action) : null,
    h("span", { class: "toast-bar", style: `animation-duration:${ms}ms`, "aria-hidden": "true" }));
  box.replaceChildren(el);
  toastTimer = setTimeout(dismiss, ms);
}

// ---------------------------------------------------------------- painting

/** Which screen this is. A new one fades in; the same one repainted stays still. */
function viewKey() {
  if (state.link === "unpaired" || state.link === "pairing") return state.link;
  const here = activeTab && state.shared.some((t) => t.tabId === activeTab.id);
  return `paired:${activeTab?.id ?? 0}:${here}:${state.link === "offline"}`;
}

function render() {
  if (!state) return;
  // Keep focus, and the caret, where they were: the panel is rebuilt on every state change.
  const focused = document.activeElement?.getAttribute?.("data-k");
  const caret = focused === "server" ? document.activeElement.selectionStart : null;
  const view = viewKey();
  if (view !== lastView) viewSince = lastView === null ? 0 : Date.now();
  lastView = view;
  const swap = entering(null, 220, viewSince);
  timed = [];
  if (state.link !== "unpaired" && state.link !== "pairing" && state.sharedOnce) lastStep = null;
  const body = h("div", { class: `xp-b${swap.cls ? " swap" : ""}`, style: swap.style },
    state.link === "unpaired" ? connectView() : state.link === "pairing" ? pairingView() : pairedView());
  app.replaceChildren(...[header(), body, footer()].filter(Boolean));
  if (focused) {
    const el = app.querySelector(`[data-k="${CSS.escape(focused)}"]`);
    el?.focus();
    if (caret !== null) el?.setSelectionRange?.(caret, caret);
  }
  updateTimers();
}

/** Typing in a shared tab changes nothing but its activity lines. Those are patched in place, so a
    keyboard user's focus on Stop is never disturbed twice a second. Returns false to fall back to a full repaint. */
function patchActivity(prev, next) {
  const strip = (s) => JSON.stringify({ ...s, shared: s.shared.map(({ activity, ...t }) => t) });
  if (!prev || strip(prev) !== strip(next)) return false;
  const old = document.getElementById("feed");
  const entry = activeTab && next.shared.find((t) => t.tabId === activeTab.id);
  if (!old || !entry) return true;
  old.replaceWith(feed(entry, drawnAt(`air:${entry.tabId}:${entry.since}`)));
  timed = timed.filter((update) => update.el.isConnected);
  updateTimers();
  return true;
}

// ---------------------------------------------------------------- start

const DEMO_TAB = { id: 1, title: "Inbox (3) · Example Mail", url: "https://mail.example.com/inbox" };
const base = {
  link: "online", host: "tallylamp.example.com", server: "https://tallylamp.example.com", lastServer: null, browserName: "Chrome on macOS", pairing: null, shared: [],
  error: null, notice: null, noticeKind: null, noticeTabId: null, extensions: null, releaseAt: null, sharedOnce: true,
};
const now = Date.now();
const also = [
  {
    tabId: 2, title: "Q3 forecast · Sheets", url: "https://sheets.example.com/d/1", sites: ["sheets.example.com"], byAgent: false, since: now - 754_000,
    activity: [{ id: 3, kind: "type", n: 12, at: now - 4_000 }, { id: 2, kind: "click", n: 2, at: now - 31_000 }, { id: 1, kind: "open", where: "sheets.example.com/d/1", n: 1, at: now - 750_000 }],
  },
  // Made-up sites only: these fixtures are what the Web Store screenshots show.
  {
    tabId: 3, title: "Flights to Lisbon · Example Travel", url: "https://travel.example.com/flights", sites: null, byAgent: true, since: now - 128_000,
    activity: [{ id: 5, kind: "open", where: "travel.example.com/flights", n: 1, at: now - 120_000 }, { id: 4, kind: "newtab", n: 1, at: now - 128_000 }],
  },
];
const mailShare = { tabId: 1, title: DEMO_TAB.title, url: DEMO_TAB.url, sites: ["mail.example.com"], byAgent: false, since: now - 42_000, activity: [] };
const DEMOS = {
  unpaired: { ...base, link: "unpaired", host: null, server: null, browserName: null, sharedOnce: false },
  "unpaired-error": { ...base, link: "unpaired", host: null, server: null, browserName: null, sharedOnce: false, error: "Couldn't reach tallylamp.example.com. Check the address, and that the server is running." },
  pairing: { ...base, link: "pairing", browserName: null, sharedOnce: false, pairing: { userCode: "KXQ7-M2PD", expiresAt: now + 582_000, approveUrl: "#" } },
  linked: { ...base, sharedOnce: false },
  connecting: { ...base, link: "connecting" },
  ready: base,
  unshareable: base,
  dashboard: base,
  "other-extension": {
    ...base,
    error: "Another extension has put a frame inside mail.example.com, and Chrome won't let an extension control a page with a different extension's frame in it. Stop that extension running on mail.example.com, reload the page, then share again.",
    extensions: { id: "abcdefghijklmnopabcdefghijklmnop", site: "mail.example.com", kind: "blocked" },
  },
  "shared-here": { ...base, shared: [{ ...mailShare, activity: [{ id: 7, kind: "key", key: "Enter", n: 1, at: now - 3_000 }, { id: 6, kind: "type", n: 18, at: now - 6_000 }, { id: 5, kind: "click", n: 1, at: now - 14_000 }] }] },
  "shared-connecting": { ...base, link: "connecting", shared: [mailShare] },
  "shared-elsewhere": { ...base, shared: also },
  offline: { ...base, link: "offline", shared: also, releaseAt: now + 42_000 },
  notice: { ...base, notice: "You pressed Cancel on Chrome's debugging bar, so sharing stopped.", noticeKind: "cancel", noticeTabId: 1 },
  "notice-left": { ...base, notice: "A shared tab left sheets.example.com for accounts.example.com, so it was handed back.", noticeKind: "left-site", noticeTabId: 2 },
  flagged: {
    ...base, shared: [mailShare], noticeKind: "flagged", noticeTabId: 1,
    notice: "Another extension has a frame inside mail.example.com. Chrome let the tab share anyway, which usually means its \"Extensions on chrome-extension:// URLs\" flag is on. Your agent has been kept out of that frame.",
    extensions: { id: "abcdefghijklmnopabcdefghijklmnop", site: "mail.example.com", kind: "flagged" },
  },
};

if (demo) {
  state = DEMOS[demo] ?? DEMOS.ready;
  const front = also.find((t) => t.tabId === Number(query.get("tab")));
  activeTab = demo === "unshareable"
    ? { id: 9, title: "Extensions", url: "chrome://extensions" }
    : demo === "dashboard" ? { id: 8, title: "Browsers · Tallylamp", url: "https://tallylamp.example.com/browsers" }
      : front ? { id: front.tabId, title: front.title, url: front.url } : DEMO_TAB;
  windowTabs = [DEMO_TAB, ...also.map((t) => ({ id: t.tabId, title: t.title, url: t.url }))];
  justShared = demo === "shared-here";
  justLinked = demo === "linked";
  if (demo === "unpaired-error") typed = "tallylamp.example.com";
  render();
} else {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "state") return;
    const prev = state;
    onState(msg.state);
    if (!busy && patchActivity(prev, state)) return;
    render();
  });
  // The panel outlives the tab it was opened on. Every switch re-asks which tab is in front,
  // and a new tab starts from the safe choices again: site limit on, no "Shared." still showing
  // from the tab before.
  let followSequence = 0;
  const followTab = async () => {
    const sequence = ++followSequence;
    const [[tab], tabs] = await Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), chrome.tabs.query({ currentWindow: true })]);
    if (sequence !== followSequence) return;
    if (tab?.id !== activeTab?.id) {
      justShared = false;
      limitToSite = true;
    }
    activeTab = tab ?? null;
    windowTabs = tabs;
    render();
  };
  chrome.tabs.onActivated.addListener(followTab);
  chrome.tabs.onCreated.addListener(followTab);
  chrome.tabs.onRemoved.addListener(followTab);
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!(change.url || change.title || change.favIconUrl)) return;
    windowTabs = windowTabs.map((t) => (t.id === tabId ? tab : t));
    if (tabId === activeTab?.id) activeTab = tab;
    render();
  });
  // Shown on the Share and Stop buttons, so it is the person's own binding, or none if they cleared it.
  chrome.commands?.getAll().then((commands) => {
    shortcut = commands.find((c) => c.name === "toggle-share")?.shortcut ?? "";
    render();
  });
  await Promise.all([
    chrome.runtime.sendMessage({ type: "getState" }).then((res) => { onState(res.state); render(); }),
    followTab(),
  ]);
}
