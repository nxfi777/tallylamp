const app = document.getElementById("app");

const state = {
  me: null,
  browsers: [],
  agents: [],
  seeds: [],
  status: null,
  filter: "",
  events: [],
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message || data?.error || res.statusText);
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

function lampClass(b) {
  if (b.control?.controllerType === "human") return "human";
  if (b.status === "running") return "";
  return "idle";
}

function badge(b) {
  if (b.control?.controllerType === "human") return h("span", { class: "badge human" }, "HUMAN");
  if (b.status === "running") return h("span", { class: "badge live" }, "LIVE");
  return h("span", { class: "badge idle" }, (b.status || "stopped").toUpperCase());
}

function layout(main) {
  app.replaceChildren(
    h("div", { class: "app" },
      h("nav", { class: "nav" },
        h("div", { class: "brand" }, h("span", { class: "lamp" }), "Tallylamp"),
        h("a", { href: "/", class: route().name === "home" ? "active" : "", onClick: (e) => { e.preventDefault(); go("/"); } }, "Browsers"),
        h("a", { href: "/agents", class: route().name === "agents" ? "active" : "", onClick: (e) => { e.preventDefault(); go("/agents"); } }, "Agents"),
        h("a", { href: "/seeds", class: route().name === "seeds" ? "active" : "", onClick: (e) => { e.preventDefault(); go("/seeds"); } }, "Seeds"),
        h("a", { href: "/security", class: route().name === "security" ? "active" : "", onClick: (e) => { e.preventDefault(); go("/security"); } }, "Security"),
        h("div", { class: "spacer" }),
        h("button", { class: "link logout", onClick: logout }, "Log out"),
      ),
      h("main", { class: "main" }, main),
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
        go("/");
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
    h("input", { name: "secret", type: "password", placeholder: "Administrator secret", autocomplete: "current-password" }),
    h("button", { class: "btn primary", type: "submit" }, "Enter"),
    err,
  );
  app.replaceChildren(
    h("div", { class: "login" },
      h("div", { class: "login-box" },
        h("div", { class: "brand" }, h("span", { class: "lamp" }), "Tallylamp"),
        h("h1", {}, "Watch the browsers. Take over when needed."),
        h("div", { class: "sub" }, "This deployment’s administrator secret is the dashboard credential. It is never stored in the browser."),
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
  const thumb = h("div", { class: "thumb" }, badge(b), "no frame");
  if (b.status === "running") {
    const img = h("img", { alt: b.name });
    img.src = `/api/v1/browsers/${b.id}/thumbnail?t=${Date.now()}`;
    img.onerror = () => {};
    thumb.replaceChildren(img, badge(b));
  }
  return h("article", { class: "card" },
    thumb,
    h("div", { class: "body" },
      h("h3", {}, b.name),
      h("div", { class: "meta" },
        h("div", {}, `${b.provenance.createdByType} · ${b.owner.id}`),
        md.source ? h("div", {}, `reported source: ${md.source}`) : null,
        md.project ? h("div", {}, md.project) : null,
        md.purpose ? h("div", {}, md.purpose) : null,
        h("div", { class: "mono" }, b.url || "—"),
        h("div", {}, b.control?.controllerType === "human" ? "Human has control" : b.control?.controllerType === "agent" ? "Agent has control" : "No controller"),
      ),
      h("div", { class: "actions" },
        h("button", { class: "btn", onClick: () => go(`/browsers/${b.id}`) }, "Watch"),
        h("button", { class: "btn human", onClick: () => takeControl(b.id) }, "Take control"),
      ),
    ),
  );
}

function groupBrowsers(list) {
  const groups = new Map();
  for (const b of list) {
    const g = b.metadata?.project || "Unlabelled";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(b);
  }
  return groups;
}

async function homeView() {
  const q = state.filter;
  const list = state.browsers.filter((b) => matches(b, q));
  const groups = groupBrowsers(list);
  const sections = [];
  for (const [name, items] of groups) {
    sections.push(h("div", { class: "group-h" }, name));
    sections.push(h("div", { class: "grid" }, ...items.map(card)));
  }
  layout([
    h("div", { class: "top" },
      h("div", {},
        h("h1", {}, "Browsers"),
        h("div", { class: "sub" }, `${state.browsers.filter((b) => b.status === "running").length} live · ${state.browsers.length} total · fleet ${state.status?.running ?? 0}/${state.status?.maxBrowsers ?? "?"}`),
      ),
      h("div", { class: "row" },
        h("input", { placeholder: "Filter name, agent, project, purpose…", value: q, onInput: (e) => { state.filter = e.target.value; void render(); } }),
        h("button", { class: "btn primary", onClick: createBrowser }, "New browser"),
      ),
    ),
    ...sections,
    list.length === 0 ? h("div", { class: "sub" }, "No browsers yet. Create one, or let an agent call tallylamp_create_browser.") : null,
  ]);
}

async function browserView(id) {
  let data;
  try {
    data = await api(`/api/v1/browsers/${id}`);
  } catch (e) {
    layout(h("div", { class: "err" }, e.message));
    return;
  }
  const b = data.browser;
  const md = b.metadata || {};
  const human = b.control?.controllerType === "human";
  const stage = h("div", { class: "stage" });
  const img = h("img", { alt: "live browser" });
  stage.append(
    h("div", { class: "bar" },
      h("span", {}, human ? "CONTROLLING" : "WATCHING · input blocked"),
      h("span", { class: "mono" }, b.url || ""),
    ),
    img,
  );
  layout([
    h("div", { class: "top" },
      h("div", {},
        h("h1", {}, b.name),
        h("div", { class: "sub" }, `trusted creator: ${b.provenance.createdByType} ${b.owner.id} · via ${b.provenance.createdVia}`),
      ),
      h("div", { class: "row" },
        human
          ? h("button", { class: "btn ok", onClick: () => returnControl(id) }, "Return to agent")
          : h("button", { class: "btn human", onClick: () => takeControl(id, true) }, "Take control"),
        h("button", { class: "btn", onClick: () => call(`/api/v1/browsers/${id}/start`) }, "Start"),
        h("button", { class: "btn", onClick: () => call(`/api/v1/browsers/${id}/stop`) }, "Stop"),
        h("button", { class: "btn", onClick: () => call(`/api/v1/browsers/${id}/restart`) }, "Restart"),
        h("button", { class: "btn danger", onClick: () => destroyBrowser(id) }, "Delete"),
      ),
    ),
    h("div", { class: human ? "banner control" : "banner watch" },
      human
        ? "You have the control lease. Agent mutating tools are rejected until you return control. Same Chrome, same profile, same page."
        : "Watch mode. Mouse, keyboard and scroll are discarded server-side. The agent keeps the browser.",
    ),
    h("div", { class: "detail" },
      stage,
      h("aside", { class: "side" },
        h("dl", { class: "kv" },
          h("dt", {}, "Status"), h("dd", {}, b.status),
          h("dt", {}, "Controller"), h("dd", {}, b.control?.controllerType || "none"),
          h("dt", {}, "Persistent"), h("dd", {}, b.persistent ? "yes" : "ephemeral"),
          h("dt", {}, "Project"), h("dd", {}, md.project || "—"),
          h("dt", {}, "Purpose"), h("dd", {}, md.purpose || "—"),
          h("dt", {}, "Task"), h("dd", {}, md.task || "—"),
          h("dt", {}, "Reported source"), h("dd", {}, md.source || "—"),
          h("dt", {}, "Reported client"), h("dd", {}, b.reportedClient ? `${b.reportedClient.name} ${b.reportedClient.version || ""}` : "—"),
          h("dt", {}, "Chrome"), h("dd", { class: "mono" }, b.chromeVersion || "—"),
          h("dt", {}, "Sandbox"), h("dd", { class: b.sandboxStatus === "sandboxed" ? "" : "warn" }, b.sandboxStatus || "unknown"),
          h("dt", {}, "GPU"), h("dd", {}, b.gpuStatus || "unknown"),
          h("dt", {}, "MCP attached"), h("dd", {}, String(b.mcpAttached)),
        ),
        h("h3", {}, "Activity"),
        h("ul", { class: "timeline" },
          ...(data.activity || []).map((a) => h("li", {}, `${a.at.slice(11, 19)}  ${a.kind}`)),
        ),
      ),
    ),
  ]);
  void connectViewer(id, human ? "control" : "watch", img, b.control?.leaseToken);
}

async function connectViewer(id, mode, img, leaseToken) {
  try {
    const { ticket } = await api(`/api/v1/browsers/${id}/viewer-ticket`, { method: "POST", body: { mode } });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/browsers/${id}/view?ticket=${encodeURIComponent(ticket)}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "frame") img.src = `data:image/jpeg;base64,${msg.data}`;
    };
    if (mode === "control") {
      const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
      setInterval(() => send({ type: "heartbeat", leaseToken }), 15000);
      img.style.cursor = "crosshair";
      img.onmousemove = (e) => {
        const r = img.getBoundingClientRect();
        send({ type: "mouse", event: "mouseMoved", x: (e.clientX - r.left) * (img.naturalWidth / r.width || 1), y: (e.clientY - r.top) * (img.naturalHeight / r.height || 1) });
      };
      img.onmousedown = (e) => {
        const r = img.getBoundingClientRect();
        send({ type: "mouse", event: "mousePressed", button: "left", x: (e.clientX - r.left) * (img.naturalWidth / r.width || 1), y: (e.clientY - r.top) * (img.naturalHeight / r.height || 1) });
      };
      img.onmouseup = (e) => {
        const r = img.getBoundingClientRect();
        send({ type: "mouse", event: "mouseReleased", button: "left", x: (e.clientX - r.left) * (img.naturalWidth / r.width || 1), y: (e.clientY - r.top) * (img.naturalHeight / r.height || 1) });
      };
      window.onkeydown = (e) => {
        send({ type: "key", event: "keyDown", key: e.key, code: e.code, text: e.key.length === 1 ? e.key : undefined });
      };
      window.onkeyup = (e) => {
        send({ type: "key", event: "keyUp", key: e.key, code: e.code });
      };
    }
  } catch (e) {
    img.alt = e.message;
  }
}

async function agentsView() {
  layout([
    h("div", { class: "top" },
      h("div", {}, h("h1", {}, "Agents"), h("div", { class: "sub" }, "Registered principals. Tokens are shown once at creation or rotation.")),
      h("button", { class: "btn primary", onClick: createAgent }, "New agent"),
    ),
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Id"), h("th", {}, "Max"), h("th", {}, "Enabled"), h("th", {}, "Last seen"), h("th", {}, ""))),
      h("tbody", {},
        ...state.agents.map((a) => h("tr", {},
          h("td", {}, a.name),
          h("td", { class: "mono" }, a.id),
          h("td", {}, String(a.maxBrowsers)),
          h("td", {}, a.enabled ? "yes" : "revoked"),
          h("td", { class: "mono" }, a.lastSeenAt || "—"),
          h("td", {},
            h("button", { class: "btn", onClick: () => rotate(a.id) }, "Rotate"),
            " ",
            h("button", { class: "btn", onClick: () => toggleAgent(a) }, a.enabled ? "Revoke" : "Enable"),
          ),
        )),
      ),
    ),
  ]);
}

async function seedsView() {
  layout([
    h("div", { class: "top" },
      h("div", {}, h("h1", {}, "Seed profiles"), h("div", { class: "sub" }, "Stop a browser, then snapshot it. New browsers can clone the snapshot. Some sites invalidate cloned sessions.")),
    ),
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Id"), h("th", {}, "Created"))),
      h("tbody", {},
        ...state.seeds.map((s) => h("tr", {}, h("td", {}, s.name), h("td", { class: "mono" }, s.id), h("td", {}, s.created_at))),
      ),
    ),
  ]);
}

async function securityView() {
  const s = state.status || {};
  layout([
    h("h1", {}, "Security state"),
    h("dl", { class: "kv" },
      h("dt", {}, "Sandbox policy"), h("dd", {}, s.sandbox),
      h("dt", {}, "GPU"), h("dd", {}, s.gpu),
      h("dt", {}, "Private network"), h("dd", { class: s.allowPrivateNetwork ? "warn" : "" }, s.allowPrivateNetwork ? "ALLOWED" : "blocked"),
      h("dt", {}, "Xvfb"), h("dd", {}, s.xvfb ? "on" : "off"),
      h("dt", {}, "OAuth discovery"), h("dd", {}, s.oauth ? "advertised" : "off"),
      h("dt", {}, "Fleet"), h("dd", {}, `${s.running}/${s.maxBrowsers}`),
    ),
    h("p", { class: "sub" }, "CDP and viewer backends bind loopback only. Viewer tickets are short-lived and single-use. Browser processes receive a sanitized environment without ADMIN_SECRET or agent tokens."),
  ]);
}

async function createBrowser() {
  const name = prompt("Browser name (optional)") || undefined;
  const purpose = prompt("Purpose (optional metadata)") || undefined;
  await api("/api/v1/browsers", {
    method: "POST",
    body: { name, persistent: true, metadata: purpose ? { purpose, source: "dashboard" } : { source: "dashboard" } },
  });
  await refresh();
  void render();
}

async function createAgent() {
  const name = prompt("Agent name", "Development Agent");
  if (!name) return;
  const created = await api("/api/v1/agents", { method: "POST", body: { name } });
  alert(`Token (shown once):\n${created.token}\n\nclaude mcp add --transport http tallylamp ${location.origin}/mcp --header "Authorization: Bearer ${created.token}"`);
  await refresh();
  void render();
}

async function rotate(id) {
  const r = await api(`/api/v1/agents/${id}/rotate`, { method: "POST" });
  alert(`New token (shown once):\n${r.token}`);
}

async function toggleAgent(a) {
  await api(`/api/v1/agents/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } });
  await refresh();
  void render();
}

async function takeControl(id, stay) {
  await api(`/api/v1/browsers/${id}/control`, { method: "POST", body: { force: true } });
  if (stay || location.pathname.startsWith("/browsers/")) go(`/browsers/${id}`);
  else { await refresh(); void render(); }
}

async function returnControl(id) {
  await api(`/api/v1/browsers/${id}/control`, { method: "DELETE" });
  go(`/browsers/${id}`);
}

async function call(path) {
  await api(path, { method: "POST" });
  await refresh();
  void render();
}

async function destroyBrowser(id) {
  if (!confirm("Delete this browser and its authenticated profile?")) return;
  await api(`/api/v1/browsers/${id}`, { method: "DELETE" });
  go("/");
}

async function logout() {
  await api("/api/v1/logout", { method: "POST" });
  state.me = null;
  go("/login");
}

async function refresh() {
  try {
    state.me = (await api("/api/v1/me")).principal;
    state.status = await api("/api/v1/status");
    state.browsers = (await api("/api/v1/browsers")).browsers;
    if (state.me?.type === "admin") {
      state.agents = (await api("/api/v1/agents")).agents;
      state.seeds = (await api("/api/v1/seeds")).seeds;
    }
    return true;
  } catch {
    state.me = null;
    return false;
  }
}

async function render() {
  const r = route();
  if (r.name === "login") return loginView();
  const ok = state.me || await refresh();
  if (!ok) return loginView();
  if (r.name === "browser") return browserView(r.id);
  if (r.name === "agents") return agentsView();
  if (r.name === "seeds") return seedsView();
  if (r.name === "security") return securityView();
  return homeView();
}

window.addEventListener("popstate", () => void render());
void render();

if (window.EventSource) {
  try {
    const es = new EventSource("/api/v1/events");
    es.onmessage = () => { void refresh().then(() => { if (route().name === "home") void render(); }); };
  } catch { /* ignore */ }
}
