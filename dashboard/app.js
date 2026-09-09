const app = document.getElementById("app");

// The live viewer owns a socket, a heartbeat, a reconnect timer and key handlers. Held here so
// every re-render can tear it down: without this, keys pressed anywhere in the dashboard kept
// being injected into the last browser you controlled — including into the login field.
let viewer = null;

function teardownViewer() {
  if (!viewer) return;
  viewer.cancel();
  viewer = null;
}

window.addEventListener("beforeunload", teardownViewer);

// Held in state, not only in the DOM. refresh() reports a partial failure and the render that
// immediately follows it used to rebuild the layout and throw the message away — so the messages
// this code takes care to compose were unreachable exactly when they mattered.
function flash(message) {
  state.flash = message || "";
  const el = document.querySelector(".flash");
  if (el) el.textContent = state.flash;
}

/**
 * Modal shell: focus trap, Escape, backdrop click, focus restore, and `inert` on the page
 * behind. `aria-modal` on its own was a promise the dashboard did not keep — every nav link
 * behind the dialog stayed in the tab order.
 *
 * `build` receives a `close(result)` it can call; `onClose` gets that result, or undefined.
 */
function openModal(title, build, onClose) {
  const restoreFocus = document.activeElement;
  const box = h("div", { class: "modal-box", role: "dialog", "aria-modal": "true", "aria-label": title });
  const dialog = h("div", { class: "modal", onMousedown: (e) => { if (e.target === dialog) close(); } }, box);

  function close(result) {
    document.removeEventListener("keydown", onKey, true);
    dialog.remove();
    const app = document.getElementById("app");
    if (app) app.removeAttribute("inert");
    if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
    if (onClose) onClose(result);
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const stops = [...box.querySelectorAll("input, textarea, select, button")].filter((el) => !el.disabled);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  box.replaceChildren(...[].concat(build(close)).filter(Boolean));
  document.body.append(dialog);
  const app = document.getElementById("app");
  if (app) app.setAttribute("inert", "");
  document.addEventListener("keydown", onKey, true);
  return { close, box };
}

/**
 * Ask for a few values at once. This replaces a run of prompt() dialogs, which arrive one at a
 * time with no labels, no hint of how many are coming, and no way back to the previous answer.
 */
function askFor(title, fields, submitLabel) {
  return new Promise((resolve) => {
    const inputs = new Map();
    const { box } = openModal(title, (close) => {
      const form = h("form", {
        onSubmit: (e) => {
          e.preventDefault();
          const out = {};
          for (const [name, el] of inputs) out[name] = el.value.trim();
          close(out);
        },
      });
      for (const f of fields) {
        const id = `field-${f.name}`;
        const input = h("input", {
          id, name: f.name, type: "text", value: f.value || "",
          placeholder: f.placeholder || "", maxlength: String(f.maxLength || 120), autocomplete: "off",
        });
        inputs.set(f.name, input);
        form.append(h("label", { for: id }, f.label), input);
        if (f.hint) form.append(h("div", { class: "sub field-hint" }, f.hint));
      }
      form.append(h("div", { class: "row modal-foot" },
        h("button", { class: "btn primary", type: "submit" }, submitLabel),
        h("button", { class: "btn", type: "button", onClick: () => close() }, "Cancel"),
      ));
      return [h("h2", {}, title), form];
    }, (result) => resolve(result || null));
    const first = box.querySelector("input");
    if (first) first.focus();
  });
}

/**
 * Show a credential that exists exactly once. A native alert() gave the operator nothing to
 * select, nothing to copy, and no second chance if they dismissed it.
 *
 * The token and anything shown beside it get their own field and their own button. They used
 * to share one textarea, so Copy returned the credential with a sentence of English stapled to
 * it — which is not a credential any more once it is pasted into a header.
 */
function revealToken(title, token, { note, command } = {}) {
  const status = h("span", { class: "sub", role: "status" }, "");

  const copyButton = (label, getText, primary) => h("button", {
    class: primary ? "btn primary" : "btn",
    onClick: async () => {
      const text = getText();
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = `${label} copied.`;
      } catch {
        status.textContent = `Select the ${label.toLowerCase()} and press ${navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+C.`;
      }
    },
  }, `Copy ${label.toLowerCase()}`);

  const tokenField = h("textarea", { class: "token", readonly: "readonly", rows: "2", spellcheck: "false", "aria-label": `${title} — the token` }, token);
  const commandField = command
    ? h("textarea", { class: "token", readonly: "readonly", rows: "3", spellcheck: "false", "aria-label": "Command to add this server to Claude Code" }, command)
    : null;

  openModal(title, (close) => [
    h("h2", {}, title),
    h("p", { class: "sub" }, "Tallylamp keeps only a hash of this, so it cannot show it to you again. Copy it now."),
    tokenField,
    h("div", { class: "row" }, copyButton("Token", () => token, true)),
    command ? h("p", { class: "sub cmd-label" }, "To point Claude Code at this deployment:") : null,
    commandField,
    command ? h("div", { class: "row" }, copyButton("Command", () => command, false)) : null,
    note ? h("p", { class: "sub" }, note) : null,
    h("div", { class: "row modal-foot" }, h("button", { class: "btn", onClick: () => close() }, "Done"), status),
  ]);

  tokenField.focus();
  tokenField.select();
}

/**
 * Theme. Three states, not two: light, dark, and "follow the system" — which is the default and
 * stays reachable, because an operator who never chose should keep tracking their OS.
 * `data-theme` is absent in that third state, which is what the CSS keys off.
 */
const THEMES = ["system", "light", "dark"];

function currentTheme() {
  return document.documentElement.dataset.theme || "system";
}

function applyTheme(next) {
  if (next === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = next;
  }
  try {
    if (next === "system") localStorage.removeItem("tallylamp-theme");
    else localStorage.setItem("tallylamp-theme", next);
  } catch {
    /* storage can be unavailable; the theme still applies for this page */
  }
}

function themeButton() {
  const label = () => {
    const t = currentTheme();
    if (t === "light") return "Theme: light";
    if (t === "dark") return "Theme: dark";
    return "Theme: system";
  };
  const btn = h("button", {
    class: "link theme",
    // The control cycles, so say what it will do rather than only what it is.
    title: "Switch between system, light and dark",
    onClick: () => {
      applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
      btn.textContent = label();
    },
  }, label());
  return btn;
}

/**
 * What to do with an address bar entry that is not an address. A person typing "mobbin" means
 * "search for mobbin", and refusing them was the wrong answer — but which engine to send it to
 * is theirs to pick, not ours to assume, because the query leaves the browser either way.
 * Google first because it is what most people expect; "off" stays reachable for anyone who
 * would rather a typo went nowhere than to a search engine.
 */
const SEARCHES = [
  { id: "google", label: "Google", url: "https://www.google.com/search?q=" },
  { id: "duckduckgo", label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  { id: "bing", label: "Bing", url: "https://www.bing.com/search?q=" },
  { id: "brave", label: "Brave", url: "https://search.brave.com/search?q=" },
  { id: "off", label: "off", url: null },
];

function currentSearch() {
  let id = "google";
  try {
    id = localStorage.getItem("tallylamp-search") || "google";
  } catch {
    /* storage can be unavailable; the default still applies */
  }
  return SEARCHES.find((e) => e.id === id) || SEARCHES[0];
}

function searchButton() {
  const label = () => `Search: ${currentSearch().label}`;
  const btn = h("button", {
    class: "link theme",
    title: "Choose where the address bar sends a search",
    onClick: () => {
      const next = SEARCHES[(SEARCHES.indexOf(currentSearch()) + 1) % SEARCHES.length];
      try {
        localStorage.setItem("tallylamp-search", next.id);
      } catch {
        /* the choice still applies for this page */
      }
      btn.textContent = label();
    },
  }, label());
  return btn;
}

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.teardown();
  openMenu = null;
}

/**
 * A context menu at a point on screen.
 *
 * `items` are `{ label, onSelect, danger }`, or `"-"` for a separator. Anything falsy is
 * dropped, so callers can inline conditionals per browser state.
 *
 * Native rather than a component library: this dashboard ships as raw ES modules with no build
 * step and no client dependencies, so a React/Radix menu would mean adopting a bundler for one
 * widget.
 */
function showMenu(x, y, items, label) {
  closeMenu();
  const restoreFocus = document.activeElement;
  const entries = items.filter(Boolean);

  const menu = h("div", { class: "menu", role: "menu", "aria-label": label, tabindex: "-1" });
  const focusable = [];
  for (const it of entries) {
    if (it === "-") {
      menu.append(h("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    const btn = h("button", {
      class: "menu-item" + (it.danger ? " danger" : ""),
      role: "menuitem",
      type: "button",
      onClick: () => { closeMenu(); it.onSelect(); },
    }, it.label);
    focusable.push(btn);
    menu.append(btn);
  }
  document.body.append(menu);

  // Measure, then keep it on screen: flip rather than let the viewport clip a Delete item.
  const r = menu.getBoundingClientRect();
  const pad = 8;
  const left = x + r.width + pad > window.innerWidth ? Math.max(pad, x - r.width) : x;
  const top = y + r.height + pad > window.innerHeight ? Math.max(pad, y - r.height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onKey = (e) => {
    const i = focusable.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); focusable[(i + 1) % focusable.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusable[(i - 1 + focusable.length) % focusable.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); focusable[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); focusable[focusable.length - 1].focus(); }
    else if (e.key === "Tab") { e.preventDefault(); closeMenu(); }
  };
  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  // A menu pinned to a viewport coordinate is wrong the moment anything moves under it.
  const onMove = () => closeMenu();

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("contextmenu", onDown, true);
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);

  openMenu = {
    teardown() {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      menu.remove();
      if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
    },
  };
  if (focusable[0]) focusable[0].focus();
}

/** The actions that make sense for one browser, given what it is currently doing. */
function browserMenu(b) {
  const running = b.status === "running";
  const human = b.control?.controllerType === "human";
  return [
    { label: "Watch", onSelect: () => go(`/browsers/${b.id}`) },
    human
      ? { label: "Return to agent", onSelect: () => returnControl(b.id) }
      : { label: "Take control", onSelect: () => takeControl(b.id) },
    "-",
    running
      ? { label: b.persistent ? "Stop & keep profile" : "Stop temporary browser", onSelect: () => call(`/api/v1/browsers/${b.id}/stop`) }
      : { label: "Start", onSelect: () => call(`/api/v1/browsers/${b.id}/start`) },
    running && { label: "Restart", onSelect: () => call(`/api/v1/browsers/${b.id}/restart`) },
    "-",
    { label: "Edit profile…", onSelect: () => editBrowser(b) },
    !running && { label: "Save as profile template…", onSelect: () => saveProfileTemplate(b) },
    { label: "Copy browser id", onSelect: () => act(async () => {
      await navigator.clipboard.writeText(b.id);
      flash(`Copied ${b.id}.`);
    }) },
    { label: "Delete…", danger: true, onSelect: () => destroyBrowser(b.id, b.name) },
  ];
}

function sitePills(b, limit = 3) {
  const sites = b.signedInSites || [];
  if (!sites.length) return null;
  const shown = sites.slice(0, limit);
  return h("div", { class: "site-pills", "aria-label": "Recorded signed-in sites" },
    ...shown.map((site) => h("span", {
      class: `site-pill ${site.state}`,
      title: `${site.origin} · ${site.state.replaceAll("_", " ")}`,
    }, site.name)),
    sites.length > limit ? h("span", { class: "site-pill more-sites" }, `+${sites.length - limit}`) : null,
  );
}

/** Every action button routes through this: api() throws, and nothing used to catch it. */
async function act(fn) {
  try {
    flash("");
    await fn();
  } catch (e) {
    flash(e.message);
  }
}

const state = {
  me: null,
  browsers: [],
  agents: [],
  seeds: [],
  status: null,
  filter: "",
  flash: "",
  events: [],
  requests: [],
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    // Only declare a JSON body when there is one. Announcing it on GETs and on bodyless POSTs
    // is a lie some proxies and CSRF filters take seriously.
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// The brand mark. Two bezel arcs holding a lens, drawn on a 24 grid -- see the .lamp block in
// app.css for the geometry that must not drift. h() uses createElement, which cannot make namespaced
// SVG nodes, so the markup goes in through innerHTML: the HTML parser puts <svg> in the SVG
// namespace there, and a <span> wrapper keeps the CSS sizing and colour in one place.
const LAMP_BEZEL =
  '<path d="M14.29 3.44a7.4 9 0 0 1 0 17.12"/><path d="M9.71 3.44a7.4 9 0 0 0 0 17.12"/>';
const LAMP_LENS = '<circle cx="12" cy="12" r="3.3" fill="currentColor" stroke="none"/>';
// State is a difference in mass, not in colour: an empty bezel, a filled lens, an upright caret.
// The caret is stroked at 2.8 rather than the bezel's 1.7 so that "a human has taken the browser"
// is not the faintest of the three states -- at 1.7 it carried 42% of the lens's ink, at 2.8 it
// carries 74%.
const LAMP_CORE = { idle: "", human: '<path d="M12 8.6V15.4" stroke-width="2.8"/>' };

/**
 * A stroked 24-grid icon, drawn the same way and at the same weight as the lamp mark. Text
 * glyphs were tried first and were not good enough: "⟳" renders as an unreadable dot at this
 * size, and "‹ › ⟳" have three different optical weights in the same row.
 */
function icon(paths, label) {
  return h("span", {
    class: "icon",
    html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      paths +
      "</svg>",
    ...(label ? { title: label } : {}),
  });
}

const ICON_BACK = '<path d="M14.5 5.5 8 12l6.5 6.5"/>';
const ICON_FORWARD = '<path d="M9.5 5.5 16 12l-6.5 6.5"/>';
const ICON_RELOAD = '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5V9h-4.5"/>';
const ICON_FULLSCREEN = '<path d="M9 3.5H3.5V9"/><path d="M15 3.5h5.5V9"/><path d="M9 20.5H3.5V15"/><path d="M15 20.5h5.5V15"/>';
const ICON_PLUS = '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>';
const ICON_CLOSE = '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>';

function lamp(state) {
  const core = state in LAMP_CORE ? LAMP_CORE[state] : LAMP_LENS;
  return h("span", {
    class: state ? `lamp ${state}` : "lamp",
    html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" aria-hidden="true" focusable="false">' +
      LAMP_BEZEL + core + "</svg>",
  });
}

function route() {
  const p = location.pathname;
  if (p.startsWith("/browsers/") && p.split("/").length >= 3) return { name: "browser", id: p.split("/")[2] };
  if (p.startsWith("/agents")) return { name: "agents" };
  if (p.startsWith("/seeds")) return { name: "seeds" };
  if (p.startsWith("/security")) return { name: "security" };
  if (p.startsWith("/login")) return { name: "login" };
  return { name: "home" };
}

function go(path) {
  history.pushState({}, "", path);
  void render();
}

/**
 * How long ago, in the coarsest unit that is still true. Requests expire, so "asked 4 minutes
 * ago" is the number that tells an operator whether this is fresh or nearly stale; a timestamp
 * would make them do that subtraction themselves.
 */
function ago(iso) {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

/** "admin admin" was the principal printed twice. Say it once unless the id adds something. */
function principal(type, id) {
  return id && id !== type ? `${type} ${id}` : type;
}

// Sentence case in the DOM, capitals from CSS. A screen reader spells short all-caps tokens out
// letter by letter — "L, I, V, E".
function badge(b) {
  if (b.control?.controllerType === "human") return h("span", { class: "badge human" }, "Human");
  if (b.status === "running") return h("span", { class: "badge live" }, "Live");
  return h("span", { class: "badge idle" }, b.status || "stopped");
}

function layout(main) {
  app.replaceChildren(
    h("div", { class: "app" },
      // Four nav links stand between a keyboard operator and the fleet, on every navigation.
      h("a", { href: "#main", class: "skip", onClick: (e) => { e.preventDefault(); const m = document.getElementById("main"); if (m) m.focus(); } }, "Skip to content"),
      h("nav", { class: "nav" },
        h("div", { class: "brand" }, lamp(), "Tallylamp"),
        ...[
          ["/", "home", "Browsers"],
          ["/agents", "agents", "Agents"],
          ["/seeds", "seeds", "Profile templates"],
          ["/security", "security", "Security"],
        ].map(([href, name, label]) => {
          const active = route().name === name;
          return h("a", {
            href,
            class: active ? "active" : "",
            // Without this the active page is signalled by background colour alone.
            "aria-current": active ? "page" : false,
            onClick: (e) => { e.preventDefault(); go(href); },
          }, label);
        }),
        h("div", { class: "spacer" }),
        searchButton(),
        themeButton(),
        h("button", { class: "link logout", onClick: logout }, "Log out"),
      ),
      // Errors were being written into a plain div, so a screen reader never heard one.
      h("main", { class: "main", id: "main", tabindex: "-1" },
        h("div", { class: "err flash", role: "alert", "aria-live": "assertive", "aria-atomic": "true" }, state.flash || ""),
        main),
    ),
  );
}

async function loginView() {
  const err = h("div", { class: "err" });
  const form = h("form", {
    onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        await api("/api/v1/login", { method: "POST", body: { secret: form.secret.value } });
        // An OAuth-only host sends the operator here mid-authorization; resume that flow
        // with a real navigation, because /oauth/authorize is server-rendered.
        const next = new URLSearchParams(location.search).get("next");
        if (next && next.startsWith("/oauth/authorize")) location.href = next;
        else go("/");
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
    h("input", {
      type: "text", name: "username", value: "tallylamp-admin",
      autocomplete: "username", hidden: "hidden", readonly: "readonly", "aria-hidden": "true", tabindex: "-1",
    }),
    h("label", { for: "secret" }, "Administrator secret"),
    h("input", {
      id: "secret", name: "secret", type: "password",
      autocomplete: "current-password", autofocus: "autofocus", required: "required",
    }),
    h("button", { class: "btn primary", type: "submit" }, "Sign in"),
    err,
  );
  app.replaceChildren(
    h("div", { class: "login" },
      h("div", { class: "login-box" },
        h("div", { class: "brand" }, lamp(), "Tallylamp"),
        h("h1", {}, "Sign in"),
        form,
      ),
    ),
  );
}

function matches(b, q) {
  if (!q) return true;
  const blob = JSON.stringify(b).toLowerCase();
  return blob.includes(q.toLowerCase());
}

function card(b) {
  const md = b.metadata || {};
  // create() falls back to metadata.project when no name is given (src/browsers.ts), so for a
  // whole class of agent-made browsers the project IS the title — printing both stacks the same
  // string twice. An empty string passes metadata validation too, hence truthiness, not `in`.
  const project = md.project && md.project !== b.name ? md.project : null;
  // The badge already says the status; this caption said "not running" over a browser that was
  // starting, and over one that had simply never produced a frame.
  const thumb = h("div", { class: "thumb" }, badge(b),
    b.status === "starting" ? "starting…" : b.status === "stopping" ? "stopping…" : "no live view");
  if (b.status === "running") {
    const img = h("img", { alt: "", loading: "lazy", decoding: "async" });
    img.src = `/api/v1/browsers/${b.id}/thumbnail?t=${Date.now()}`;
    // A swallowed error left a black rectangle that looked like a browser showing a black page.
    img.onerror = () => thumb.replaceChildren(badge(b), h("span", {}, "preview failed to load"));
    thumb.replaceChildren(img, badge(b));
  }
  return h("article", {
    class: "card",
    role: "listitem",
    // Right-click anywhere on the card. The menu key and Shift+F10 raise this same event from
    // whatever has focus, so the "⋯" button below inherits the behaviour by bubbling — no extra
    // tab stop per card.
    onContextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, browserMenu(b), `Actions for ${b.name}`); },
  },
    thumb,
    h("div", { class: "body" },
      // The project was a section heading above the card until the grid was flattened. With no
      // heading left to be filed under, it comes back here — the only other place it reaches the
      // DOM is the detail page, and a fleet card that cannot tell you whose project it is makes
      // you open it to find out. Full value in the title, because the line is clamped.
      project ? h("div", { class: "card-project", title: project }, project) : null,
      h("h3", {}, b.name),
      // Six identical grey lines was most of what made this card hard to scan. Owner and
      // reported source moved to the detail page; what stays is what tells you whether to click.
      h("div", { class: "meta" },
        md.purpose ? h("div", { class: "purpose" }, md.purpose) : null,
        h("div", { class: "mono url" }, b.url || "—"),
      ),
      sitePills(b),
      h("div", { class: "who" },
        b.control?.controllerType === "human" ? "Human has control"
          : b.control?.controllerType === "agent" ? "Agent has control"
          : "No controller",
      ),
      h("div", { class: "actions" },
        h("button", { class: "btn secondary", onClick: () => go(`/browsers/${b.id}`) }, "Watch"),
        h("button", { class: "btn", onClick: () => takeControl(b.id) }, "Take control"),
        // Touch has no right-click, and a mouse user has no way to guess the card has a menu.
        // Same items, anchored to the button instead of the pointer.
        h("button", {
          class: "btn more",
          "aria-label": `More actions for ${b.name}`,
          "aria-haspopup": "menu",
          onClick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, browserMenu(b), `Actions for ${b.name}`);
          },
        }, "⋯"),
      ),
    ),
  );
}

/**
 * Fleet order. A running browser is the only one with a live view to look at, so it goes first,
 * and a crashed one is a problem that outranks a browser somebody stopped on purpose.
 *
 * `status` is an untyped string on the server (BrowserRow in src/browsers.ts), so an
 * unrecognised value has to land somewhere deterministic: a bare lookup miss returns undefined,
 * and subtracting undefined returns NaN, which leaves the whole grid silently half-sorted.
 */
const STATUS_RANK = { running: 0, starting: 1, stopping: 2, crashed: 3, stopped: 4 };

/**
 * Rank only, no tiebreak. The API hands us created_at DESC and Array#sort is stable, so
 * newest-first survives inside each bucket for free — an alphabetical secondary would throw
 * that away and bury the browser you just made under whatever happens to be called "aaa".
 */
function byLiveFirst(a, b) {
  return (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99);
}

let browsersHost = null;
let requestsHost = null;
let fleetCountEl = null;

/**
 * The fleet limit caps *running* browsers — browsers.ts refuses ensureRunning once
 * runtimes.size hits it — so that is what the meter measures. Stopped browsers hold no slot.
 */
function fleetMeter() {
  const running = state.browsers.filter((b) => b.status === "running").length;
  const limit = state.status?.maxBrowsers;
  const stopped = state.browsers.length - running;
  const label = limit
    ? `${running} of ${limit} slots in use${stopped ? ` · ${stopped} stopped` : ""}`
    : `${running} running`;

  const wrap = h("div", { class: "meter-wrap" });
  if (limit) {
    // A count is a number you have to reason about; a row of slots is a shape you can read at
    // a glance, and it makes headroom visible without arithmetic.
    const slots = h("div", {
      class: "meter",
      role: "img",
      "aria-label": `${running} of ${limit} browser slots in use`,
    }, ...Array.from({ length: limit }, (_, i) =>
      h("span", { class: "slot" + (i < running ? " on" : "") })));
    wrap.append(slots);
  }
  wrap.append(h("span", { class: "meter-label" }, label));
  return wrap;
}

function freeSlots() {
  const limit = state.status?.maxBrowsers;
  if (!limit) return 0;
  const running = state.browsers.filter((b) => b.status === "running").length;
  return Math.max(0, limit - running);
}

/** Repaint only the results, so the filter input keeps focus and no refetch happens. */
/**
 * Requests waiting on the operator.
 *
 * At the very top of the fleet page, and rendered only when something is actually waiting.
 * Both halves are deliberate: a request expires on its own, so one buried below a grid of
 * cards expires unanswered, and a permanent empty "no requests" box on the one screen whose
 * job is fleet state would compete with the fleet for the same attention every single load.
 * Absence is the empty state here. The durable lending controls live on the browser itself,
 * next to the thing they affect.
 */
function requestsPanel() {
  const list = state.requests || [];
  if (!list.length) return null;
  return h("section", { class: "banner asks", "aria-label": "Borrow requests" },
    h("h2", { class: "asks-h" },
      list.length === 1 ? "1 agent is waiting on a browser" : `${list.length} agents are waiting on a browser`),
    // Said once for the panel, not repeated per row: three copies of the same warning is the
    // noise that stops any of them being read.
    h("p", { class: "sub" },
      "Granting hands over the live logins in that profile, not a copy of them. You can revoke it at any time, and ignoring a request is safe -- it expires by itself."),
    ...list.map(askRow),
  );
}

function askRow(r) {
  const actions = h("div", { class: "row" });
  const answer = (decision, btn, label) =>
    act(async () => {
      // Doherty: the click has to land visibly before the round trip does, or a slow answer
      // reads as a dropped one and gets clicked again.
      for (const b of actions.querySelectorAll("button")) b.disabled = true;
      btn.textContent = label;
      try {
        await api(`/api/v1/requests/${r.id}/answer`, { method: "POST", body: { decision } });
        await refresh();
        paintBrowsers();
        // Peak-end: say what happened. The row vanishing on its own leaves the operator
        // guessing which way it went.
        flash(
          decision === "grant"
            ? `Lent ${r.browserName} to ${r.requester_name || r.requester_id}. Revoke it from that browser's page.`
            : `Declined ${r.requester_name || r.requester_id}.`,
        );
      } catch (e) {
        for (const b of actions.querySelectorAll("button")) b.disabled = false;
        btn.textContent = decision === "grant" ? "Grant" : "Deny";
        throw e;
      }
    });

  const grant = h("button", { class: "btn secondary" }, "Grant");
  const deny = h("button", { class: "btn deny" }, "Deny");
  grant.addEventListener("click", () => answer("grant", grant, "Granting\u2026"));
  deny.addEventListener("click", () => answer("deny", deny, "Declining\u2026"));
  actions.append(grant, deny);

  return h("div", { class: "ask" },
    h("div", { class: "ask-what" },
      h("strong", {}, r.requester_name || r.requester_id),
      " wants ",
      h("a", { href: `/browsers/${r.browser_id}`, onClick: (e) => { e.preventDefault(); go(`/browsers/${r.browser_id}`); } }, r.browserName),
      h("div", { class: "sub" }, [r.reason ? `\u201c${r.reason}\u201d` : "No reason given", `asked ${ago(r.created_at)}`].join(" \u00b7 ")),
    ),
    actions,
  );
}

function paintBrowsers() {
  // Repainted on the same tick as the fleet, so an SSE event lands a new request in front of
  // the operator within a second or two rather than on the next full navigation.
  if (requestsHost) requestsHost.replaceChildren(...[requestsPanel()].filter(Boolean));
  if (!browsersHost) return;
  // These cards are about to be replaced; a menu anchored to one of them would outlive it.
  closeMenu();
  if (fleetCountEl) fleetCountEl.replaceChildren(fleetMeter());
  const q = state.filter;
  // .filter() already returns a copy, so this orders the render list and not state.browsers.
  const list = state.browsers.filter((b) => matches(b, q)).sort(byLiveFirst);
  const nodes = [];
  if (list.length > 0) {
    // One grid for the fleet, not one per project. A grid per project is a separate formatting
    // context each, so three browsers in three projects rendered as three rows of one card with
    // empty track to the right of every one, and the live browser sat wherever its project fell.
    // The project moved onto the card instead; this heading keeps the outline h1 > h2 > h3
    // intact now that the per-project ones are gone, and doubles as the count while filtering.
    nodes.push(h("h2", { class: "group-h" }, list.length === 1 ? "1 browser" : `${list.length} browsers`));
    nodes.push(
      h("div", { class: "grid", role: "list", "aria-label": "Browsers, running first" },
        ...list.map(card)),
    );
  }
  if (list.length === 0) {
    // Branch on the fleet, not the filtered list: "No browsers yet" while eight are running
    // is the worst possible thing for the one screen whose job is fleet state.
    nodes.push(
      h(
        "div",
        { class: "sub" },
        state.browsers.length === 0
          ? "No browsers yet. Create one, or let an agent call tallylamp_create_browser."
          : `Nothing matches “${q}”.`,
      ),
    );
  }
  // Remaining capacity, drawn rather than described. The first one is the affordance; the rest
  // are inert and fade, so the row reads as "and this much room left" instead of as more cards.
  // Not while filtering (the row would describe capacity the filter is hiding), and not on an
  // empty fleet, where the empty state already says the same thing.
  const free = state.filter || state.browsers.length === 0 ? 0 : freeSlots();
  if (free > 0) {
    const ghosts = [
      h("button", {
        class: "ghost ghost-new",
        onClick: () => act(createBrowser),
      }, h("span", { class: "ghost-plus", "aria-hidden": "true" }, "+"), h("span", {}, "New browser")),
      // Up to three more, so a small fleet shows its headroom exactly and a large one trails off.
      ...Array.from({ length: Math.min(free - 1, 3) }, (_, i) =>
        h("div", { class: "ghost", "aria-hidden": "true", style: `opacity:${0.55 - i * 0.15}` })),
    ];
    nodes.push(h("h2", { class: "group-h" }, free === 1 ? "1 slot free" : `${free} slots free`));
    nodes.push(h("div", { class: "grid" }, ...ghosts));
  }
  browsersHost.replaceChildren(...nodes);
}

async function homeView() {
  browsersHost = h("div", {});
  requestsHost = h("div", {});
  fleetCountEl = h("div", { class: "sub" }, fleetMeter());
  layout([
    h("div", { class: "top" },
      h("div", {},
        h("h1", {}, "Browsers"),
        fleetCountEl,
      ),
      h("div", { class: "row" },
        h("input", {
          "aria-label": "Filter browsers",
          placeholder: "Filter browsers…",
          value: state.filter,
          onInput: (e) => {
            state.filter = e.target.value;
            paintBrowsers();
          },
        }),
        h("button", { class: "btn primary", onClick: () => act(createBrowser) }, "New browser"),
      ),
    ),
    // Above the fleet, not below it. This is the only thing on the page with a deadline on it.
    requestsHost,
    browsersHost,
  ]);
  paintBrowsers();
}

/**
 * Who is holding this browser besides its owner, and whether it may be handed over without
 * anybody being asked.
 *
 * The toggle is the complicated half and it is not hidden, only explained: "lendable" means
 * this profile can go to a waiting agent on idleness alone, which is what makes a browser
 * recoverable when its owner crashes and also exactly what you would not want for a profile
 * holding a bank login. Stating the consequence next to the switch is cheaper than a
 * confirmation dialog and it is there before the click rather than after it.
 */
function lendingSection(b) {
  const loans = b.lentTo || [];
  const toggleId = `lendable-${b.id}`;
  return h("div", { class: "lending" },
    loans.length
      ? h("ul", { class: "loans" },
          ...loans.map((g) =>
            h("li", {},
              h("span", { class: "mono" }, g.granteeId),
              h("button", {
                class: "btn tiny danger",
                onClick: () => act(async () => {
                  await api(`/api/v1/browsers/${b.id}/grants/${g.granteeId}`, { method: "DELETE" });
                  flash(`Took ${b.name} back from ${g.granteeId}.`);
                  await refresh();
                  void render();
                }),
              }, "Revoke"),
            ),
          ),
        )
      : h("div", { class: "sub" }, "Not lent to anyone."),
    h("div", { class: "row lend-toggle" },
      h("input", {
        type: "checkbox",
        id: toggleId,
        checked: b.lendable ? "checked" : false,
        onChange: (e) =>
          act(async () => {
            const on = e.target.checked;
            try {
              await api(`/api/v1/browsers/${b.id}/lendable`, { method: "POST", body: { lendable: on } });
              flash(on ? `${b.name} can now be lent out when idle.` : `${b.name} will only be lent if you say so.`);
            } catch (err) {
              e.target.checked = !on; // put the switch back; the server did not move
              throw err;
            }
          }),
      }),
      h("label", { for: toggleId }, "Lend automatically when idle"),
    ),
    h("div", { class: "sub" },
      "Off by default. On, a waiting agent gets this browser after it has been idle for a couple of minutes, without asking you \u2014 which is what lets it be recovered if the owning agent crashes. The borrower gets the live logins in this profile, so leave it off for anything you would not hand over."),
  );
}

function siteAccessSection(b) {
  const sites = b.signedInSites || [];
  return h("div", { class: "site-access" },
    sites.length
      ? h("ul", { class: "site-list" },
          ...sites.map((site) => h("li", {},
            h("div", { class: "site-main" },
              h("strong", {}, site.name),
              h("span", { class: "mono" }, site.origin),
              h("span", { class: "sub" },
                site.state === "confirmed"
                  ? `${site.reportedBy?.type === "system" ? "Detected" : "Confirmed"} ${site.lastConfirmedAt ? ago(site.lastConfirmedAt) : "recently"}`
                  : site.state === "needs_sign_in"
                    ? "Sign-in needed"
                    : `Expected from a profile template${site.lastConfirmedAt ? ` · last confirmed ${ago(site.lastConfirmedAt)}` : ""}`,
              ),
            ),
            h("div", { class: "row site-actions" },
              site.state !== "confirmed"
                ? h("button", { class: "btn tiny", onClick: () => setSiteState(b, site, "confirmed") }, "Confirm")
                : h("button", { class: "btn tiny", onClick: () => setSiteState(b, site, "needs_sign_in") }, "Needs sign-in"),
              h("button", { class: "btn tiny danger", onClick: () => removeSite(b, site) }, "Remove"),
            ),
          )),
        )
      : h("div", { class: "sub" },
          "No sign-ins detected yet. Sites with visible sign-out controls are recorded automatically. If a site is missed, record it below."),
    h("button", { class: "btn site-add", onClick: () => addSite(b) }, "Record signed-in site"),
    h("div", { class: "sub" },
      "Detection uses visible sign-out controls, not cookies or tokens. It can miss sites or be wrong; you can correct the list. Sessions may expire."),
  );
}

/**
 * Live loopback tunnels: what this browser is allowed to reach on somebody's private
 * network, and whether anything is on the other end.
 *
 * Read-and-revoke only, deliberately. Creating one mints a token that belongs on the machine
 * being reached, and putting that in a web page would be the one place it should never be --
 * so the create path is the CLI, run there. What the operator needs here is the opposite:
 * to see that a hole exists at all, and to close it.
 */
function tunnelSection(tunnels) {
  const live = tunnels || [];
  if (!live.length) {
    return h("div", { class: "sub" },
      "No tunnels. This browser can reach the public internet only \u2014 private and loopback addresses are refused.");
  }
  return h("div", { class: "tunnels" },
    h("ul", { class: "loans" },
      ...live.map((t) =>
        h("li", {},
          h("span", { class: "mono" }, t.authority),
          h("span", { class: t.connected ? "ok" : "warn" }, t.connected ? "connected" : "not connected"),
          h("button", {
            class: "btn tiny danger",
            onClick: () => act(async () => {
              await api(`/api/v1/tunnels/${t.id}`, { method: "DELETE" });
              flash(`Closed the tunnel to ${t.authority}.`);
              await refresh();
              void render();
            }),
          }, "Close"),
        ),
      ),
    ),
    h("div", { class: "sub" },
      "While a tunnel is open, any page loaded in this browser can reach that address \u2014 that is what it is for. Close it when the job is done."),
  );
}

async function browserView(id, seq) {
  let data;
  try {
    data = await api(`/api/v1/browsers/${id}`);
  } catch (e) {
    if (seq !== undefined && seq !== renderSeq) return;
    layout(h("div", { class: "err" }, e.message));
    return;
  }
  // Second gate: this fetch is the slow one, and painting after it would both replace a newer
  // page and open a viewer socket for a browser the operator has left.
  if (seq !== undefined && seq !== renderSeq) return;
  const b = data.browser;
  const md = b.metadata || {};
  const human = b.control?.controllerType === "human";
  const agentHolds = b.control?.controllerType === "agent";
  // Served by /api/v1/status so the copy cannot drift from TALLYLAMP_HUMAN_LEASE_TTL_SEC.
  const leaseSeconds = state.status?.humanLeaseTtlSec ?? 90;
  document.title = `${b.name} · Tallylamp`;
  const stage = h("div", { class: "stage" });
  const sitesPanel = h("div", { id: "profile-sites", "data-browser-id": id }, siteAccessSection(b));
  sitesPanel.updateSites = (sites) => {
    if (JSON.stringify(sites) === JSON.stringify(b.signedInSites)) return;
    b.signedInSites = sites;
    sitesPanel.replaceChildren(siteAccessSection(b));
  };
  // A canvas, not an <img>. Swapping an <img>'s src decodes the JPEG on the main thread, which
  // is the same thread that has to forward this operator's mouse and key events; passing the
  // bytes to createImageBitmap instead moves the decode off it entirely. It also ends the
  // blob-URL churn, which was allocating and revoking a couple of megabytes a second.
  const img = h("canvas", {
    // In control mode the stage is a live surface the operator types into, so it takes focus
    // and announces itself as one. Watch mode is a picture.
    "aria-label": human ? `Live view of ${b.name}. Click to put your keyboard into this browser.` : `Live view of ${b.name}`,
    tabindex: human ? "0" : false,
    role: human ? "application" : "img",
  });
  const status = h("div", { class: "stage-status", role: "status" }, "Connecting to the live browser…");
  stage.append(
    // Bottom, not top. Now that the frame fills the stage at 1:1 this bar sits on live page
    // pixels, and page content is top-aligned far more often than it is bottom-aligned.
    h("div", { class: "bar" },
      h("div", { class: "bar-left" },
        h("span", { class: "mode" }, human ? "You have control" : "Watching · read only"),
        human
          // Escape releases the keyboard back to the dashboard, so the remote page needs its
          // own way to receive one.
          ? h("button", {
              class: "btn tiny",
              title: "Send an Escape keypress to the remote page",
              onClick: () => viewer && viewer.sendKey("Escape", "Escape"),
            }, "Send Esc")
          : null,
      ),
    ),
    status,
    img,
  );

  // Chrome's own tab strip is browser UI, and Page.startScreencast only ever captures page
  // content — so the tabs were not hidden by a layout bug, they were never in the stream at
  // all. The strip below is the dashboard's own, driven by the target list.
  const tabstrip = h("div", { class: "tabstrip", role: "tablist", "aria-label": "Tabs in this browser" });
  // An address bar, not a label. Chrome's own is browser UI and can never be in the stream, so
  // without this there is no way for the operator to go anywhere they were not already taken.
  const urlInput = h("input", {
    class: "mono urlinput",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-label": "Address",
    placeholder: human ? "Enter an address or a search" : "Take control to navigate",
    readonly: human ? false : true,
    value: b.url || "",
  });
  const navBtn = (paths, label) =>
    h("button", { class: "btn tiny navbtn", title: label, "aria-label": label, disabled: human ? false : true },
      icon(paths));
  const backBtn = navBtn(ICON_BACK, "Back");
  const fwdBtn = navBtn(ICON_FORWARD, "Forward");
  const reloadBtn = navBtn(ICON_RELOAD, "Reload");
  const fsBtn = h("button", {
    class: "btn tiny navbtn",
    title: "Fill the screen with this browser (Esc to leave)",
    "aria-label": "Toggle full screen",
  }, icon(ICON_FULLSCREEN));
  const newTabBtn = h("button", {
    class: "tab-new",
    title: "New tab",
    "aria-label": "New tab",
    disabled: human ? false : true,
  }, icon(ICON_PLUS));
  const stagewrap = h("div", { class: "stagewrap" },
    tabstrip,
    h("div", { class: "urlrow" }, backBtn, fwdBtn, reloadBtn, urlInput, fsBtn),
    stage,
  );
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stagewrap.requestFullscreen().catch(() => {});
  };
  layout([
    h("div", { class: "top" },
      h("div", {},
        h("h1", {}, b.name),
        // The "not self-reported" caveat was an abstract trust claim stranded in the header. It
        // belongs next to the rows it is actually about, which is where it now sits.
        h("div", { class: "sub" }, `created by ${principal(b.provenance.createdByType, b.owner.id)} via ${b.provenance.createdVia}`),
      ),
      h("div", { class: "row" },
        human
          ? h("button", { class: "btn ok", onClick: () => returnControl(id) }, "Return to agent")
          : h("button", { class: "btn human", onClick: () => takeControl(id) }, "Take control"),
        h("button", { class: "btn", disabled: b.status === "running", onClick: () => call(`/api/v1/browsers/${id}/start`) }, "Start"),
        h("button", { class: "btn", disabled: b.status === "stopped", onClick: () => call(`/api/v1/browsers/${id}/stop`) }, b.persistent ? "Stop & keep profile" : "Stop temporary browser"),
        h("button", { class: "btn", onClick: () => call(`/api/v1/browsers/${id}/restart`) }, "Restart"),
        h("button", { class: "btn danger", onClick: () => destroyBrowser(id, b.name) }, "Delete"),
      ),
    ),
    // Three short lines, not one dense block. The old banner was a 74-word paragraph that said
    // everything at once and so got read as nothing: what you can do, what the agent can do,
    // what happens to your logins, and how long you have, with no gap between them.
    b.status === "running" ? h("div", { class: human ? "banner control" : "banner watch" },
      ...(human
        ? [
            "You have control. The agent can still read this page, but every change it tries will fail until you press Return to agent.",
            "This is the agent's own browser, with its logins live. Nothing you do here signs it out.",
            // The lease was the fact nobody had: it is 90 seconds by default and this tab is
            // what renews it, so closing the tab hands the keyboard back on a timer the
            // operator had no way to know about.
            `Your turn lasts ${leaseSeconds} seconds, and this tab keeps renewing it. Close the tab and the agent has the keyboard back.`,
          ]
        : [
            "Watching only. Nothing you click or type reaches this browser.",
            // `human` was the only thing computed, so a browser with no controller at all fell
            // into this branch and was told an agent had it.
            agentHolds
              ? "The agent has control. Press Take control when you need the keyboard."
              : "Nothing has control right now. Press Take control when you need the keyboard.",
          ]
      ).map((line) => h("p", {}, line)),
    ) : null,
    h("div", { class: "detail" },
      stagewrap,
      h("aside", { class: "side" },
        h("div", { class: "sub" }, "Tallylamp records who created this browser. The rows marked “Reported” come from the client and are not verified."),
        h("dl", { class: "kv" },
          h("dt", {}, "Status"), h("dd", {}, b.status),
          h("dt", {}, "Controller"), h("dd", {}, b.control?.controllerType || "none"),
          h("dt", {}, "Profile"), h("dd", {}, b.persistent ? "saved automatically" : "temporary · may be deleted when idle"),
          h("dt", {}, "Project"), h("dd", {}, md.project || "—"),
          h("dt", {}, "Purpose"), h("dd", {}, md.purpose || "—"),
          h("dt", {}, "Task"), h("dd", {}, md.task || "—"),
          h("dt", {}, "Reported source"), h("dd", {}, md.source || "—"),
          h("dt", {}, "Reported client"), h("dd", {}, b.reportedClient ? `${b.reportedClient.name} ${b.reportedClient.version || ""}` : "—"),
          h("dt", {}, "Chrome"), h("dd", { class: "mono" }, b.chromeVersion || "—"),
          h("dt", {}, "Sandbox"), h("dd", { class: b.sandboxStatus === "sandboxed" ? "" : "warn" }, b.sandboxStatus || "unknown"),
          h("dt", {}, "GPU"), h("dd", {}, b.gpuStatus || "unknown"),
          h("dt", {}, "MCP attached"), h("dd", {}, String(b.mcpAttached)),
          h("dt", {}, "Watchers"), h("dd", {}, String(b.viewers ?? 0)),
        ),
        h("button", { class: "btn", onClick: () => editBrowser(b) }, "Edit profile"),
        h("h2", {}, "Signed-in sites"),
        sitesPanel,
        // On the browser itself, not on a settings page: these two controls are only ever
        // meaningful next to the thing they hand over.
        h("h2", {}, "Lending"),
        lendingSection(b),
        h("h2", {}, "Loopback tunnels"),
        tunnelSection(data.tunnels),
        // h2, not h3: the page went h1 straight to h3, so this section was unreachable by
        // heading navigation.
        h("h2", {}, "Agent tool calls"),
        (data.activity || []).length
          ? h("ul", { class: "timeline" },
              ...data.activity.map((a) => h("li", {}, `${a.at.slice(11, 19)}  ${a.kind}`)),
            )
          : h("div", { class: "sub" }, "No tool calls recorded for this browser yet."),
      ),
    ),
  ]);
  if (b.status !== "running") {
    stagewrap.replaceChildren(h("div", { class: "banner", role: "status" },
      b.persistent ? "Browser stopped. Your profile and metadata are saved. Press Start to reopen it." : "Browser stopped. This temporary profile may be deleted when idle."));
    return;
  }
  void connectViewer(id, human ? "control" : "watch", img, b.control?.leaseToken, status, {
    onActiveTab: (tab) => { b.url = tab?.url || ""; b.title = tab?.title || ""; },
    stage,
    tabstrip,
    urlInput,
    newTabBtn,
    backBtn,
    fwdBtn,
    reloadBtn,
  });
}

/**
 * Map a pointer event onto remote pixels. `object-fit: contain` letterboxes the frame, so the
 * drawn area is smaller than the element and offset inside it. Measuring against the element
 * rect put every click in the wrong place as soon as the remote aspect ratio stopped matching
 * the stage's.
 *
 * Two coordinate spaces, not one. `naturalWidth` is the JPEG Chrome sent, which it is free to
 * downscale; `deviceWidth` from the frame metadata is the CSS viewport, which is what
 * Input.dispatchMouseEvent wants. They are equal only while the screencast clamp happens to
 * match the window, so the final term converts between them rather than assuming.
 */
function framePoint(img, e, frame) {
  const r = img.getBoundingClientRect();
  // The canvas backing store is sized to the frame, so this is the frame's pixel size.
  const nw = img.width;
  const nh = img.height;
  if (!nw || !nh || !r.width || !r.height) return null;
  const scale = Math.min(r.width / nw, r.height / nh);
  const fx = (e.clientX - r.left - (r.width - nw * scale) / 2) / scale;
  const fy = (e.clientY - r.top - (r.height - nh * scale) / 2) / scale;
  // Outside the drawn frame is letterbox, not page. Sending it would click a coordinate the
  // remote page does not have.
  if (fx < 0 || fy < 0 || fx > nw || fy > nh) return null;
  const dw = (frame && frame.w) || nw;
  const dh = (frame && frame.h) || nh;
  return { x: Math.round((fx * dw) / nw), y: Math.round((fy * dh) / nh) };
}

const CDP_BUTTON = ["left", "middle", "right"];

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const mouseMods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/**
 * CDP needs a Windows virtual key code for every key. It must come from `e.code` — the
 * PHYSICAL key — and never from the character produced.
 *
 * The old code fell back to `key.toUpperCase().charCodeAt(0)`, which is right for A-Z and 0-9
 * and catastrophically wrong for everything else, because those code points collide with the
 * navigation block: "." is 46, which is VK_DELETE, so typing a period in an email field
 * deleted the character in front of the caret instead. "-" is 45 (VK_INSERT), "'" is 39
 * (VK_RIGHT), "," is 44 (VK_SNAPSHOT), "[" is 91 (VK_LWIN). Shifted digits were wrong too:
 * "@" gave 64 rather than Digit2's 50. An operator could not type an email address.
 */
const CODE_VKEY = {
  Backspace: 8, Tab: 9, NumpadEnter: 13, Enter: 13,
  ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  PrintScreen: 44, Insert: 45, Delete: 46,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  NumLock: 144, ScrollLock: 145,
  // The OEM block. Every one of these was previously sent as some other key entirely.
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
  IntlRo: 193, IntlYen: 255,
};

function vkeyFor(e) {
  const c = e.code || "";
  if (c in CODE_VKEY) return CODE_VKEY[c];
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
  if (/^Digit[0-9]$/.test(c)) return c.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(c)) return 96 + Number(c.slice(6));
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(c);
  if (fn) return 111 + Number(fn[1]);
  // No usable code: an IME, an on-screen keyboard, or a synthetic event. Only the two ranges
  // where character and virtual key genuinely coincide are safe to guess.
  const k = e.key || "";
  if (/^[a-zA-Z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  return undefined;
}

function keyMessage(e, up) {
  // Ctrl/Meta chords are commands, not text. Sending text with them made Ctrl+A type "a".
  const command = e.ctrlKey || e.metaKey;
  const text = command ? undefined : e.key === "Enter" ? "\r" : e.key.length === 1 ? e.key : undefined;
  return {
    type: "key",
    // Puppeteer's rule: a keypress that produces text is a keyDown, one that does not is a
    // rawKeyDown. Sending keyDown for both makes Chrome swallow the non-text ones.
    event: up ? "keyUp" : text ? "keyDown" : "rawKeyDown",
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: vkeyFor(e),
    location: e.location || undefined,
    isKeypad: e.location === 3 || undefined,
    modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    text: up ? undefined : text,
  };
}

/**
 * Open the screencast and, in control mode, wire input to it.
 *
 * Two things this has to get right that the first version did not. The stream can die — the
 * lease can expire, the browser can stop, the socket can drop — and the operator has to be
 * told, because a frozen last frame under a bar reading CONTROLLING is indistinguishable from
 * a live one. And keys must reach the remote page *only*: forwarding them from `window`
 * without preventDefault meant every keystroke also drove the dashboard, where Enter on a
 * focused Stop button killed the very session the operator had taken over to rescue.
 */
async function connectViewer(id, mode, img, leaseToken, status, ui) {
  let stopped = false;
  let ws = null;
  let beat = 0;
  let retry = 0;
  let attempt = 0;
  let live = false;
  // The CSS size of the frame Chrome is actually producing, from screencast metadata. Clicks
  // are mapped through this, never through the <img>'s decoded size, which lags a resize by a
  // whole decode and would silently scale every coordinate in the meantime.
  let frameSize = null;
  let tabs = [];
  let activeTargetId = null;
  let wantTargetId = null;

  // --- 1:1 sizing ---------------------------------------------------------------------
  // The stage asks Chrome for a content area its own size, so one remote CSS pixel is one
  // dashboard CSS pixel and object-fit has nothing left to scale. Everything here exists to
  // stop that request from oscillating: measuring the stage changes the layout that the stage
  // is measured in, which is a feedback loop with a live browser on the other end of it.
  let sentSize = null;
  let resizePending = false;
  let unstick = 0;
  let sizeDebounce = 0;
  let sendTimes = [];
  let sizingOff = mode !== "control";
  let observer = null;

  const sendJson = (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

  const measure = (force) => {
    if (sizingOff || !ui || !ui.stage) return;
    const r = ui.stage.getBoundingClientRect();
    const w = Math.round(r.width);
    const hh = Math.round(r.height);
    if (w < 320 || hh < 240) return;
    // A dead band wider than a scrollbar. Exact equality is unreachable: the rect is
    // fractional and the request is an integer.
    if (!force && sentSize && Math.abs(w - sentSize.w) < 8 && Math.abs(hh - sentSize.h) < 8) return;
    const now = Date.now();
    sendTimes = sendTimes.filter((t) => now - t < 3000);
    if (sendTimes.length >= 5) {
      // Something about this layout will not settle. Stop asking rather than resize a real
      // browser twice a second for the life of the page.
      sizingOff = true;
      return;
    }
    sendTimes.push(now);
    sentSize = { w, h: hh };
    resizePending = true;
    clearTimeout(unstick);
    unstick = setTimeout(() => { resizePending = false; }, 1500);
    sendJson({ type: "viewport", width: w, height: hh });
  };

  const scheduleMeasure = () => {
    clearTimeout(sizeDebounce);
    sizeDebounce = setTimeout(() => measure(false), 200);
  };

  // ResizeObserver on the stage, not a window resize listener: .main owns the page overflow,
  // so window resize does not fire when its scrollbar appears — which is exactly the event
  // that changes the stage's width.
  if (ui && ui.stage && typeof ResizeObserver === "function") {
    observer = new ResizeObserver(scheduleMeasure);
    observer.observe(ui.stage);
  }

  const renderTabs = () => {
    if (!ui || !ui.tabstrip) return;
    const kids = tabs.map((t) => {
      const on = t.targetId === activeTargetId;
      const label = t.title || t.url || "New tab";
      // Titles come from remote pages, so they are attacker-controlled: they go in as text
      // children and never through h()'s `html`.
      const name = h("span", { class: "tab-name" }, label);
      const wrap = h("div", {
        // A div, because the close control nests inside it and a button inside a button is
        // not valid HTML. That costs the keyboard affordances a button gave for free, so they
        // are put back by hand — and only in control mode, where the tab actually does
        // something. In watch mode it is a label, and `.tab.live` is what makes it look
        // otherwise, so watch tabs no longer advertise a click that goes nowhere.
        class: (on ? "tab on" : "tab") + (mode === "control" ? " live" : ""),
        role: "tab",
        "aria-selected": on ? "true" : "false",
        tabindex: mode === "control" ? (on ? "0" : "-1") : false,
        title: t.url || label,
      }, name);
      if (mode === "control") {
        wrap.onkeydown = (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          wrap.click();
        };
        wrap.onclick = () => {
          if (t.targetId === activeTargetId) return;
          wantTargetId = t.targetId;
          activeTargetId = t.targetId;
          renderTabs();
          sendJson({ type: "selectTab", targetId: t.targetId });
        };
        // Closing the last tab would take the window, and Chrome, with it.
        if (tabs.length > 1) {
          const x = h("button", { class: "tab-x", title: "Close tab", "aria-label": `Close ${label}` }, icon(ICON_CLOSE));
          x.onclick = (e) => {
            e.stopPropagation();
            sendJson({ type: "closeTab", targetId: t.targetId });
          };
          wrap.append(x);
        }
      }
      return wrap;
    });
    if (ui.newTabBtn) kids.push(ui.newTabBtn);
    ui.tabstrip.replaceChildren(...kids);
    const act = tabs.find((t) => t.targetId === activeTargetId);
    ui.onActiveTab?.(act);
    // Never overwrite an address the operator is part-way through typing.
    if (ui.urlInput && document.activeElement !== ui.urlInput) ui.urlInput.value = (act && act.url) || "";
  };

  /**
   * What an address bar does with what people actually type. A bare host becomes https; a
   * scheme we cannot open is rejected here rather than silently doing nothing, and the server
   * checks it again because that is where the security decision belongs.
   */
  const toUrl = (raw) => {
    const text = String(raw || "").trim();
    if (!text) return null;
    // "localhost:3000" and "example.com:8080" match the scheme pattern too, and passing them
    // through as schemes meant a host:port could never be typed — the digits after the colon
    // are the tell.
    const looksLikeHostPort = /^[a-zA-Z0-9.-]+:\d+(?:[/?#]|$)/.test(text);
    if (!looksLikeHostPort && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
    // No scheme. A host goes straight there; anything else is a search phrase.
    if (/^[^\s/?#]+\.[^\s/?#]+/.test(text) || /^localhost(?::\d+)?(?:[/?#]|$)/.test(text)) return "https://" + text;
    const engine = currentSearch();
    if (!engine.url) return null;
    return engine.url + encodeURIComponent(text);
  };

  let terminal = false;
  let noticeTimer = 0;
  let noticeText = "";
  /**
   * A transient message over the stage. It must never write over a terminal failure, because
   * that overlay carries the Reconnect button and there would be nothing left to press; and it
   * clears only its own text, because the 4s timer would otherwise wipe whatever had replaced
   * it in the meantime.
   */
  const notify = (text) => {
    if (terminal) return;
    noticeText = text;
    setStatus(text, "err");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (!terminal && live && noticeText === text) setStatus("");
    }, 4000);
  };
  const setStatus = (text, kind) => {
    status.hidden = !text;
    status.className = "stage-status" + (kind ? " " + kind : "");
    status.replaceChildren(...(text ? [text] : []));
  };

  const fail = (text, retryable) => {
    live = false;
    // A non-retryable failure is terminal until the operator acts. Without this the very next
    // screencast frame cleared the overlay: releasing the lease restarts the stream server
    // side, so "your control lease expired" was painted and erased within a frame.
    if (!retryable) terminal = true;
    img.classList.add("stale");
    const kids = [h("div", {}, text)];
    if (retryable) {
      kids.push(h("button", { class: "btn", onClick: () => { attempt = 0; terminal = false; void open(); } }, "Reconnect"));
    }
    status.hidden = false;
    status.className = "stage-status err";
    status.replaceChildren(h("div", { class: "stage-status-inner" }, ...kids));
  };

  // --- painting ------------------------------------------------------------------------
  // Frames arrive whenever the network delivers them, which is not when the screen is ready to
  // show one. Holding the newest and painting it on the next animation frame means at most one
  // swap per repaint, and a burst that arrives late shows its newest frame rather than
  // replaying every stale one behind it.
  let nextFrame = null;
  let decoding = false;
  // desynchronized lets the browser skip a compositing hop for a surface that is only ever
  // fully repainted; alpha:false lets it skip blending a layer that is never transparent.
  const ctx = img.getContext("2d", { alpha: false, desynchronized: true });

  const paint = () => {
    if (decoding || !nextFrame) return;
    const buf = nextFrame;
    nextFrame = null;
    decoding = true;
    // The frames are jpeg, except the sharper still that arrives when the page settles, which
    // is webp. createImageBitmap sniffs the container, so neither needs declaring.
    createImageBitmap(new Blob([buf]))
      .then((bitmap) => {
        decoding = false;
        if (stopped) { bitmap.close(); return; }
        if (img.width !== bitmap.width || img.height !== bitmap.height) {
          img.width = bitmap.width;
          img.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        // Explicit: an ImageBitmap holds decoded pixels, and at 15fps waiting for the collector
        // is megabytes of garbage a second.
        bitmap.close();
        // A frame that arrived mid-decode is still waiting.
        if (nextFrame) requestAnimationFrame(paint);
      })
      .catch(() => {
        decoding = false;
      });
  };

  const showFrame = (buf) => {
    // Latest wins. A burst that arrives late shows its newest frame rather than replaying
    // every stale one behind it.
    nextFrame = buf;
    if (!terminal) {
      img.classList.remove("stale");
      live = true;
      setStatus("");
    }
    if (!decoding) requestAnimationFrame(paint);
  };

  const schedule = () => {
    if (stopped || attempt >= 6) {
      if (!stopped) fail("Lost the live view and could not get it back.", true);
      return;
    }
    // Exponential backoff with jitter, so a restarting browser is not hammered.
    const wait = Math.min(1000 * 2 ** attempt, 15000) * (0.5 + Math.random());
    attempt += 1;
    retry = setTimeout(() => void open(), wait);
  };

  const open = async () => {
    if (stopped) return;
    clearTimeout(retry);
    setStatus(attempt ? "Reconnecting to the live browser…" : "Connecting to the live browser…");
    let ticket;
    try {
      // Tickets are single use and expire in a minute, so every reconnect mints a new one.
      ({ ticket } = await api(`/api/v1/browsers/${id}/viewer-ticket`, { method: "POST", body: { mode } }));
    } catch (e) {
      if (stopped) return;
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        fail(`Cannot open the viewer: ${e.message}`, false);
        return;
      }
      schedule();
      return;
    }
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/v1/browsers/${id}/view?ticket=${encodeURIComponent(ticket)}`);

    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (ev) => {
      // Pictures arrive as binary and control messages as JSON. Base64 in JSON cost a third
      // more bytes on the wire and made this thread parse a 190 KB string fifteen times a
      // second, which is most of what "glitchy" was.
      if (typeof ev.data !== "string") {
        showFrame(ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // a frame we cannot read is not worth tearing the viewer down for
      }
      if (msg.type === "frameMeta") {
        // The encoded frame can be smaller than the remote viewport, so this is the size clicks
        // are mapped through. It arrives only when it changes.
        frameSize = { w: msg.width, h: msg.height };
        return;
      }
      if (msg.type === "hello") {
        if (msg.content && msg.content.width) frameSize = { w: msg.content.width, h: msg.content.height };
        return;
      }
      if (msg.type === "tabs") {
        tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
        // The server is authoritative: a tab we optimistically selected may have been closed
        // while the socket was down.
        activeTargetId = msg.activeTargetId || null;
        if (wantTargetId && !tabs.some((t) => t.targetId === wantTargetId)) wantTargetId = null;
        renderTabs();
        return;
      }
      if (msg.type === "viewport") {
        // The size Chrome actually granted, which may be smaller than asked for if the request
        // hit the screen. Record it so we letterbox honestly instead of pretending.
        sentSize = { w: msg.width, h: msg.height };
        resizePending = false;
        clearTimeout(unstick);
        return;
      }
      if (msg.type === "notice") {
        notify(String(msg.message || ""));
        return;
      }
      if (msg.type === "cursor") {
        // Without this the pointer stays an arrow over every link, and a click that lands
        // nowhere is indistinguishable from a click that landed on the wrong pixel.
        img.style.cursor = msg.cursor || "default";
        return;
      }
      // The server says "lease expired" here and the old client dropped it on the floor, so
      // the bar kept claiming CONTROLLING while the agent had already resumed.
      if (msg.type === "error") {
        fail(msg.message === "lease expired"
          ? "Your turn ran out and the agent has the browser again. Take control to carry on."
          : `The live view reported: ${msg.message}`, false);
      }
    });

    ws.addEventListener("open", () => {
      // A socket that opens but never delivers a frame used to burn the whole retry budget in
      // about 45 seconds, because only a frame reset the counter.
      attempt = 0;
      if (mode !== "control") return;
      // Order is load-bearing and TCP guarantees it on one socket. The heartbeat binds this
      // socket to the lease and nothing else is accepted until it lands; the server rebuilds
      // its target and screencast size from scratch on every socket, so both have to be
      // restated or a reconnect silently reverts them.
      sendJson({ type: "heartbeat", leaseToken });
      sentSize = null;
      sendTimes = [];
      measure(true);
      if (wantTargetId) sendJson({ type: "selectTab", targetId: wantTargetId });
    });

    ws.addEventListener("close", (ev) => {
      clearInterval(beat);
      if (stopped) return;
      if (ev.code === 1000) return; // a clean close is us navigating away
      if (live) setStatus("The live view dropped. Reconnecting…");
      img.classList.add("stale");
      live = false;
      schedule();
    });

    ws.addEventListener("error", () => { /* close fires next and owns the retry */ });

    clearInterval(beat);
    // Watch mode has nothing to renew -- the server ignores a heartbeat that is not binding a
    // lease -- and it used to be the thing that kept a forgotten tab's browser alive forever.
    // A hidden tab is not a human watching, whatever the page inside is doing: a looping
    // video, a spinner or a polling SPA all produce frames with nobody in front of them, so
    // what the page is up to can never answer this. Visibility can.
    if (mode === "control") {
      beat = setInterval(() => {
        if (ws && ws.readyState === 1 && document.visibilityState === "visible") {
          ws.send(JSON.stringify({ type: "heartbeat", leaseToken }));
        }
      }, 15000);
    }

    if (mode !== "control") return;

    const send = sendJson;
    // A click dropped during a resize is recoverable. A click mapped against the size the
    // window used to be is not: it lands somewhere else on a live page.
    const at = (e) => (resizePending ? null : framePoint(img, e, frameSize));

    if (ui) {
      if (ui.urlInput) {
        ui.urlInput.onkeydown = (e) => {
          // The stage forwards keys to the remote page. This input must keep its own.
          e.stopPropagation();
          if (e.key === "Escape") { ui.urlInput.blur(); return; }
          if (e.key !== "Enter") return;
          const url = toUrl(ui.urlInput.value);
          if (!url) {
            notify(
              currentSearch().url
                ? "That is not an address."
                : "That is not an address, and search is off. Turn it on in the sidebar.",
            );
            return;
          }
          send({ type: "navigate", url });
          ui.urlInput.blur();
        };
        ui.urlInput.onfocus = () => ui.urlInput.select();
      }
      if (ui.backBtn) ui.backBtn.onclick = () => send({ type: "historyGo", delta: -1 });
      if (ui.fwdBtn) ui.fwdBtn.onclick = () => send({ type: "historyGo", delta: 1 });
      if (ui.reloadBtn) ui.reloadBtn.onclick = () => send({ type: "reload" });
      if (ui.newTabBtn) ui.newTabBtn.onclick = () => send({ type: "newTab" });
    }

    img.onmousemove = (e) => { const p = at(e); if (p) send({ type: "mouse", event: "mouseMoved", ...p }); };
    img.onmousedown = (e) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      img.focus();
      send({ type: "mouse", event: "mousePressed", button: CDP_BUTTON[e.button] || "left", clickCount: e.detail || 1, modifiers: mouseMods(e), ...p });
    };
    img.onmouseup = (e) => {
      const p = at(e);
      if (!p) return;
      send({ type: "mouse", event: "mouseReleased", button: CDP_BUTTON[e.button] || "left", clickCount: e.detail || 1, modifiers: mouseMods(e), ...p });
    };
    // Right-click belongs to the remote page, not to the dashboard's context menu.
    img.oncontextmenu = (e) => e.preventDefault();
    // The server has handled `scroll` all along; nothing was sending it, so an operator could
    // not reach an Allow button below the fold on the consent screen they took over for.
    img.onwheel = (e) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      send({ type: "scroll", ...p, deltaX: e.deltaX, deltaY: e.deltaY });
    };
  };

  const onKeyDown = (e) => {
    // Escape is the way out. Forwarding it and every other key from `window` is what let a
    // keystroke meant for the remote page activate a dashboard button instead.
    if (e.key === "Escape") { img.blur(); return; }
    // Paste is the one chord we must NOT swallow. preventDefault here would stop the browser
    // ever producing the `paste` event that carries the clipboard, and forwarding the
    // keystroke on its own is useless: the remote Chrome has its own empty clipboard.
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    e.preventDefault();
    e.stopPropagation();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(keyMessage(e, false)));
  };
  const onKeyUp = (e) => {
    if (e.key === "Escape") return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    e.preventDefault();
    e.stopPropagation();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(keyMessage(e, true)));
  };

  /**
   * Paste. The remote Chrome has its own clipboard and it is empty, so forwarding Cmd+V would
   * paste nothing. The text comes off the local clipboard here and is typed into whatever has
   * focus over there.
   *
   * Read from the event rather than `navigator.clipboard.readText()`: the async clipboard API
   * needs a secure context, so it is simply absent when the dashboard is served over plain
   * http on anything but localhost, and it prompts for a permission this does not need.
   */
  const onPaste = (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    if (!ws || ws.readyState !== 1) return;
    // Matches the server's cap. Truncating silently would be worse than saying so.
    const capped = text.length > 16384 ? text.slice(0, 16384) : text;
    ws.send(JSON.stringify({ type: "paste", text: capped }));
    if (capped.length < text.length) notify(`Pasted the first ${capped.length} characters.`);
  };

  if (mode === "control") {
    // Scoped to the stage, so keys only leave the dashboard when the operator has deliberately
    // put focus on the browser they are driving.
    img.addEventListener("keydown", onKeyDown);
    img.addEventListener("keyup", onKeyUp);
    img.addEventListener("paste", onPaste);
  }

  // Hidden tabs get their timers throttled to about once a minute, so coming back to the tab
  // could otherwise sit up to a minute short of the next beat with a 90-second lease running
  // down. Beat immediately on the way back in: if the lease is still alive this renews it, and
  // if it lapsed while you were away the server says so and the bar explains it.
  const onVisible = () => {
    if (stopped || mode !== "control") return;
    if (document.visibilityState !== "visible") return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "heartbeat", leaseToken }));
  };
  document.addEventListener("visibilitychange", onVisible);

  viewer = {
    cancel() {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(retry);
      clearTimeout(unstick);
      clearTimeout(noticeTimer);
      clearTimeout(sizeDebounce);
      nextFrame = null;
      clearInterval(beat);
      if (observer) observer.disconnect();
      img.removeEventListener("keydown", onKeyDown);
      img.removeEventListener("keyup", onKeyUp);
      img.removeEventListener("paste", onPaste);
      try { ws && ws.close(1000, "navigated away"); } catch { /* already gone */ }
    },
    /** Send one key to the remote page that the stage itself reserves. */
    sendKey(key, code) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "key", event: "keyDown", key, code }));
        ws.send(JSON.stringify({ type: "key", event: "keyUp", key, code }));
      }
    },
  };

  await open();
}

async function agentsView() {
  layout([
    h("div", { class: "top" },
      h("div", {}, h("h1", {}, "Agents"), h("div", { class: "sub" }, "Agents and OAuth connectors that can drive browsers here. You see a token once, when you create or rotate it, because the server keeps only its SHA-256 hash. Revoking stops the agent at its next request and kills its token for good. Re-enabling brings the row back but not the token: a plain agent then needs a rotate, and a connector has to authorize again.")),
      h("button", { class: "btn primary", onClick: createAgent }, "New agent"),
    ),
    h("table", { class: "table" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col" }, "Name"),
        h("th", { scope: "col" }, "Kind"),
        h("th", { scope: "col" }, "Id"),
        h("th", { scope: "col" }, "Max"),
        h("th", { scope: "col" }, "Status"),
        h("th", { scope: "col" }, "Last seen"),
        // An unlabelled column reads as nothing at all in a screen reader's table summary.
        h("th", { scope: "col" }, "Actions"),
      )),
      h("tbody", {},
        state.agents.length === 0
          ? h("tr", {}, h("td", { colspan: "7", class: "sub" }, "No agents yet. Create one to give an MCP client a token."))
          : null,
        ...state.agents.map((a) => h("tr", {},
          h("td", {}, a.name),
          h("td", {}, a.labels?.kind === "connector" ? `connector · ${a.labels.client_host || "?"}` : "agent"),
          h("td", { class: "mono" }, a.id),
          h("td", {}, String(a.maxBrowsers)),
          h("td", {}, a.enabled ? "active" : "revoked"),
          h("td", { class: "mono" }, a.lastSeenAt || "—"),
          h("td", {},
            // A connector has no dashboard token to rotate; its credentials come from the grant.
            a.labels?.kind === "connector" ? null : h("button", { class: "btn", onClick: () => rotate(a.id) }, "Rotate"),
            " ",
            // Revoke cuts a live agent off. It sat next to Rotate in the same grey, and the two
            // words even start alike.
            // "Enable" read as an undo for Revoke. It is not: the token is gone for good.
            h("button", { class: a.enabled ? "btn danger" : "btn", onClick: () => toggleAgent(a) }, a.enabled ? "Revoke" : "Re-enable"),
          ),
        )),
      ),
    ),
  ]);
}

async function seedsView() {
  layout([
    h("div", { class: "top" },
      h("div", {}, h("h1", {}, "Profile templates"), h("div", { class: "sub" }, "A template is a frozen copy of a stopped browser profile. New ephemeral browsers can inherit all of its logins, but copied sessions are only expected until the destination site accepts them.")),
    ),
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Recorded sites"), h("th", {}, "Created"), h("th", {}, "Actions"))),
      h("tbody", {},
        state.seeds.length === 0
          ? h("tr", {}, h("td", { colspan: "4", class: "sub" }, "No profile templates yet. Stop a browser, then choose Save as profile template from its menu."))
          : null,
        ...state.seeds.map((s) => h("tr", {},
          h("td", {}, s.name, h("div", { class: "mono sub" }, s.id)),
          h("td", {}, sitePills(s) || h("span", { class: "sub" }, "None recorded")),
          h("td", { title: s.created_at }, ago(s.created_at)),
          h("td", {}, h("button", {
            class: "btn",
            "aria-label": `Create ephemeral browser from ${s.name}`,
            onClick: () => createFromTemplate(s),
          }, "Create browser")),
        )),
      ),
    ),
  ]);
}

async function createFromTemplate(template) {
  const answers = await askFor("New browser from template", [
    {
      name: "name",
      label: "Browser name",
      value: `${template.name} session`,
      hint: "This copy is ephemeral. Deleting it does not change the template.",
    },
  ], "Create browser");
  if (!answers) return;
  await act(async () => {
    const created = await api("/api/v1/browsers", {
      method: "POST",
      body: {
        name: answers.name,
        persistent: false,
        seedId: template.id,
        metadata: { source: "dashboard", purpose: `Ephemeral copy of ${template.name}` },
      },
    });
    flash(`${answers.name} created. Its recorded sessions are expected until checked.`);
    await refresh();
    go(`/browsers/${created.browser.id}`);
  });
}

async function securityView() {
  // refresh() uses allSettled, so a failed /status leaves state.status null while every other
  // view still renders. Falling through to the falsy branches printed "Private network:
  // blocked" and "OAuth connectors: turned off" as fact, from no data at all. On the one page
  // an operator opens to check a containment property before trusting it with a bank login,
  // an unknown must never render as the safe answer.
  if (!state.status) {
    layout([
      h("h1", {}, "Security state"),
      h("div", { class: "err" }, "The server did not return its security state, so none of these settings can be shown. Reload, or check the server logs."),
    ]);
    return;
  }
  const s = state.status;
  // Three states, not two: on, off, and we do not know.
  const tri = (v, on, off) => (v === undefined || v === null
    ? h("dd", { class: "warn" }, "unknown")
    : h("dd", { class: v ? "warn" : "" }, v ? on : off));
  layout([
    h("h1", {}, "Security state"),
    h("dl", { class: "kv" },
      h("dt", {}, "Sandbox policy"), h("dd", {}, s.sandbox ?? "unknown"),
      h("dt", {}, "GPU"), h("dd", {}, s.gpu ?? "unknown"),
      // "ALLOWED"/"blocked" were not a matched pair; the warn class already carries the alarm.
      h("dt", {}, "Private network"), tri(s.allowPrivateNetwork, "allowed", "blocked"),
      h("dt", {}, "Display"),
      s.xvfb === undefined ? h("dd", { class: "warn" }, "unknown") : h("dd", {}, s.xvfb ? "virtual (Xvfb)" : "host display"),
      h("dt", {}, "OAuth connectors"),
      s.oauth === undefined ? h("dd", { class: "warn" }, "unknown") : h("dd", {}, s.oauth ? "accepted" : "refused"),
      h("dt", {}, "Fleet"), h("dd", {}, s.running === undefined ? "unknown" : `${s.running}/${s.maxBrowsers}`),
    ),
    // The old text here said the viewer "listens on loopback only". It does not: viewer.ts
    // attaches its upgrade handler to the same http server that index.ts binds to config.host,
    // which defaults to 0.0.0.0. Only Chrome's debugging port is pinned to 127.0.0.1
    // (chrome.ts, --remote-debugging-address). What actually guards the viewer is the ticket.
    h("h2", {}, "What holds this together"),
    h("p", {}, "Chrome's debugging port listens on 127.0.0.1, so nothing outside this container can drive it directly. The viewer socket is different. It is served on the same public origin as this page. What guards it is the ticket, and each ticket works once, for one browser, for sixty seconds."),
    h("p", {}, "Chrome starts from an allowlisted environment, so ADMIN_SECRET and agent tokens are not in the process it runs as. Outbound traffic goes through a proxy that resolves DNS first, then refuses private, link-local and metadata addresses. Every takeover is written to the audit log, and a forced one records who was displaced."),
    h("p", {}, "None of this limits what an agent does once it is already inside a session you logged in."),
  ]);
}

async function createBrowser() {
  const answers = await askFor("New browser", [
    { name: "name", label: "Name", placeholder: "Leave blank and one will be generated", hint: "How it appears in the fleet." },
    { name: "project", label: "Project", placeholder: "Optional", hint: "Shown on the card, and the filter box matches it." },
    { name: "purpose", label: "What is it for?", placeholder: "Optional", maxLength: 200, hint: "The next person to look at this fleet will thank you." },
  ], "Create browser");
  if (!answers) return;
  const { name, project, purpose } = answers;
  await act(async () => {
    await api("/api/v1/browsers", {
      method: "POST",
      body: {
        name: name || undefined,
        persistent: true,
        metadata: {
          source: "dashboard",
          ...(project ? { project } : {}),
          ...(purpose ? { purpose } : {}),
        },
      },
    });
    await refresh();
    void render();
  });
}

async function editBrowser(b) {
  const md = b.metadata || {};
  const answers = await askFor("Edit profile", [
    { name: "name", label: "Profile name", value: b.name, hint: "Shown to people and agents. The stable browser id does not change." },
    { name: "project", label: "Project", value: md.project || "", placeholder: "Optional" },
    { name: "purpose", label: "What is it for?", value: md.purpose || "", placeholder: "Optional", maxLength: 200 },
    { name: "task", label: "Task", value: md.task || "", placeholder: "Optional", maxLength: 200 },
  ], "Save changes");
  if (!answers) return;
  await act(async () => {
    const metadata = { ...md };
    if (answers.project) metadata.project = answers.project;
    else delete metadata.project;
    if (answers.purpose) metadata.purpose = answers.purpose;
    else delete metadata.purpose;
    if (answers.task) metadata.task = answers.task;
    else delete metadata.task;
    await api(`/api/v1/browsers/${b.id}`, {
      method: "PATCH",
      body: { name: answers.name, metadata },
    });
    flash(`Saved ${answers.name}.`);
    await refresh();
    void render();
  });
}

function currentOrigin(b) {
  try {
    const url = new URL(b.url || "");
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

async function addSite(b) {
  const origin = currentOrigin(b);
  const answers = await askFor("Record signed-in site", [
    {
      name: "origin",
      label: "Website",
      value: origin,
      placeholder: "mobbin.com",
      hint: "Only record a site after you can see that this profile is signed in.",
    },
    { name: "name", label: "Service name", value: origin ? new URL(origin).hostname.replace(/^www\./, "") : "", placeholder: "Optional — defaults to the hostname" },
  ], "Record site");
  if (!answers) return;
  await act(async () => {
    const result = await api(`/api/v1/browsers/${b.id}/sites`, {
      method: "POST",
      body: { origin: answers.origin, name: answers.name || undefined, state: "confirmed" },
    });
    flash(`${result.site.name} recorded. Agents can now find this profile by ${new URL(result.site.origin).hostname}.`);
    await refresh();
    void render();
  });
}

async function setSiteState(b, site, stateName) {
  await act(async () => {
    await api(`/api/v1/browsers/${b.id}/sites`, {
      method: "POST",
      body: { origin: site.origin, name: site.name, state: stateName },
    });
    flash(stateName === "confirmed" ? `${site.name} confirmed.` : `${site.name} marked as needing sign-in.`);
    await refresh();
    void render();
  });
}

async function removeSite(b, site) {
  await act(async () => {
    await api(`/api/v1/browsers/${b.id}/sites/${site.id}`, { method: "DELETE" });
    flash(`${site.name} removed from the profile inventory. Its website session was not changed.`);
    await refresh();
    void render();
  });
}

async function saveProfileTemplate(b) {
  const answers = await askFor("Save profile template", [
    {
      name: "name",
      label: "Template name",
      value: b.name,
      hint: "The template copies the whole profile and every login inside it.",
    },
  ], "Save template");
  if (!answers) return;
  await act(async () => {
    await api("/api/v1/seeds", { method: "POST", body: { browserId: b.id, name: answers.name } });
    flash(`Saved ${answers.name} as a profile template. Copied sessions are only expected until checked.`);
    await refresh();
    void render();
  });
}

async function createAgent() {
  const answers = await askFor("New agent", [
    { name: "name", label: "Name", value: "Development Agent", hint: "Shown wherever this agent's browsers appear." },
  ], "Create agent");
  const name = answers && answers.name;
  if (!name) return;
  await act(async () => {
    const created = await api("/api/v1/agents", { method: "POST", body: { name } });
    await refresh();
    void render();
    revealToken(`Token for ${name}`, created.token, {
      command: `claude mcp add --transport http tallylamp ${location.origin}/mcp --header "Authorization: Bearer ${created.token}"`,
    });
  });
}

async function rotate(id) {
  await act(async () => {
    const r = await api(`/api/v1/agents/${id}/rotate`, { method: "POST" });
    revealToken("New token", r.token, { note: "The previous token stopped working the moment this one was issued. Anything still using it is disconnected until you paste this one in." });
  });
}

async function toggleAgent(a) {
  if (
    a.enabled &&
    !confirm(`Revoke ${a.name}?\n\nIts token stops working immediately and anything using it is disconnected. You can enable it again, but the same token will not come back.`)
  ) return;
  await act(async () => {
    await api(`/api/v1/agents/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } });
    await refresh();
    void render();
  });
}

async function takeControl(id) {
  await act(async () => {
    // This always sent force:true, which silently cuts off whoever is holding the lease. Taking
    // it from an agent is the point of the button; taking it from another person is not.
    let held = null;
    try {
      held = (await api(`/api/v1/browsers/${id}`)).browser.control;
    } catch { /* let the POST below report the real failure */ }
    if (
      held?.controllerType === "human" &&
      held.controllerId &&
      held.controllerId !== state.me?.id &&
      !confirm("Someone else is controlling this browser right now. Taking it will cut them off part-way through whatever they are doing.\n\nTake control anyway?")
    ) return;
    await api(`/api/v1/browsers/${id}/control`, { method: "POST", body: { force: true } });
    // Always go to the viewer. The lease is short and only the detail page's socket heartbeat
    // renews it, so "take control" from the grid used to hand back a browser after 90 seconds
    // without the operator touching anything or being told.
    go(`/browsers/${id}`);
  });
}

async function returnControl(id) {
  await act(async () => {
    await api(`/api/v1/browsers/${id}/control`, { method: "DELETE" });
    go(`/browsers/${id}`);
  });
}

async function call(path) {
  await act(async () => {
    await api(path, { method: "POST" });
    await refresh();
    void render();
  });
}

async function destroyBrowser(id, name) {
  // Name the browser, and say what actually goes: browsers.ts removes the profile directory AND
  // the download directory, which the old wording never mentioned.
  if (!confirm(`Delete "${name}"?\n\nIts profile and its downloaded files are removed, and its saved logins go with them. You will have to sign in to those sites again. This cannot be undone.`)) return;
  await act(async () => {
    await api(`/api/v1/browsers/${id}`, { method: "DELETE" });
    go("/");
  });
}

async function logout() {
  // A failing logout used to throw into nothing and leave the operator on a page that still
  // looked signed in. Clear locally either way — the cookie is the server's to invalidate.
  try {
    await api("/api/v1/logout", { method: "POST" });
  } catch (e) {
    flash(`Could not reach the server to sign out: ${e.message}`);
  }
  state.me = null;
  go("/login");
}

async function refresh() {
  try {
    state.me = (await api("/api/v1/me")).principal;
  } catch (e) {
    // Only "not authenticated" means log out. Anything else is a broken request, and
    // sending the operator to the password box mid-incident loses their place.
    if (e.status === 401 || e.status === 403) {
      state.me = null;
      return false;
    }
    flash(`Cannot reach Tallylamp: ${e.message}`);
    return true;
  }
  // These are independent: one failing view must not blank the others or force a logout.
  const [status, browsers, agents, seeds, requests] = await Promise.allSettled([
    api("/api/v1/status"),
    api("/api/v1/browsers"),
    state.me?.type === "admin" ? api("/api/v1/agents") : Promise.resolve({ agents: [] }),
    state.me?.type === "admin" ? api("/api/v1/seeds") : Promise.resolve({ seeds: [] }),
    api("/api/v1/requests"),
  ]);
  if (status.status === "fulfilled") state.status = status.value;
  if (browsers.status === "fulfilled") state.browsers = browsers.value.browsers;
  if (agents.status === "fulfilled") state.agents = agents.value.agents;
  if (seeds.status === "fulfilled") state.seeds = seeds.value.seeds;
  if (requests.status === "fulfilled") state.requests = requests.value.requests;
  const failed = [
    ["status", status], ["browsers", browsers], ["agents", agents], ["seeds", seeds],
  ].filter(([, r]) => r.status === "rejected");
  if (failed.length) flash(`Could not load ${failed.map(([n]) => n).join(", ")}: ${failed[0][1].reason.message}`);
  return true;
}

let busyTimer = 0;

/** Show a progress bar only if the work outlasts the ~400ms people notice. */
function busy(on) {
  clearTimeout(busyTimer);
  if (on) {
    busyTimer = setTimeout(() => document.body.classList.add("busy"), 150);
  } else {
    document.body.classList.remove("busy");
  }
}

const TITLES = { home: "Browsers", agents: "Agents", seeds: "Profile templates", security: "Security state", login: "Sign in" };

let renderSeq = 0;

async function render() {
  // A slow browserView used to paint its detail page over whatever route the operator had since
  // navigated to — and then open a viewer socket for a browser they had already left.
  const seq = ++renderSeq;
  teardownViewer();
  closeMenu();
  state.flash = "";
  const r = route();
  // Every route used to read "Tallylamp", so a row of pinned tabs was indistinguishable and
  // browser history was useless.
  document.title = r.name === "browser" ? "Browser · Tallylamp" : `${TITLES[r.name] || "Tallylamp"} · Tallylamp`;
  if (r.name === "login") return loginView();
  busy(true);
  let ok;
  try {
    ok = await refresh();
  } finally {
    busy(false);
  }
  if (seq !== renderSeq) return; // the operator navigated while refresh() was in flight
  if (!ok) return loginView();
  startEvents(); // we are authenticated by here, which is what /api/v1/events requires
  if (r.name === "browser") return browserView(r.id, seq);
  if (r.name === "agents") return agentsView();
  if (r.name === "seeds") return seedsView();
  if (r.name === "security") return securityView();
  return homeView();
}

window.addEventListener("popstate", () => void render());
void render();

// /api/v1/events is admin-guarded. This used to run at module load, which on a cold visit is
// the login screen, so it 401'd and gave up — and nothing on the dashboard was live for the rest
// of the session. Started after authentication instead, and only once.
let eventsStarted = false;
function startEvents() {
  if (eventsStarted || !window.EventSource) return;
  eventsStarted = true;
  let timer = 0;
  let backoff = 1000;
  const listen = () => {
    let es;
    try {
      es = new EventSource("/api/v1/events");
    } catch {
      return;
    }
    es.onopen = () => { backoff = 1000; };
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh().then(() => {
          // Repaint the cards, not the page. This used to call homeView(), which rebuilds the
          // whole layout — so an operator typing in the filter lost focus to <body> and had the
          // caret sent back to the start, roughly every time any agent touched any browser.
          if (route().name === "home") paintBrowsers();
          const sitesPanel = document.getElementById("profile-sites");
          const current = sitesPanel && state.browsers.find(b => b.id === sitesPanel.dataset.browserId);
          if (current) sitesPanel.updateSites(current.signedInSites || []);
        });
      }, 1500);
    };
    es.onerror = () => {
      // EventSource retries by itself only while the connection is merely dropped. A closed
      // stream stays closed, and the fleet then silently stops updating.
      if (es.readyState !== EventSource.CLOSED) return;
      setTimeout(listen, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  };
  listen();
}
