// The guest page. It talks to /guest/api/v1 and to one viewer socket, and to nothing else:
// no dashboard code, no admin API. The link token arrives in the URL fragment, is sent once to
// be exchanged for an HttpOnly cookie, and is dropped from the address bar before anything else.

const API = "/guest/api/v1";
const $ = (id) => document.getElementById(id);

const el = {
  name: $("name"), state: $("state"), take: $("take"), give: $("give"), leave: $("leave"),
  tools: $("tools"), back: $("back"), fwd: $("fwd"), reload: $("reload"), url: $("url"),
  newtab: $("newtab"), tabs: $("tabs"), stage: $("stage"), overlay: $("overlay"),
  overlayText: $("overlay-text"), notice: $("notice"), foot: $("foot"),
  welcome: $("welcome"), open: $("open"),
};

const ENDED = "This access has ended. Ask the person who shared this browser for a new link.";

let view = null;
let viewer = null;
let finished = false;
let busy = false;
let poll;

// ---------------------------------------------------------------------------------------------
// API

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* an empty body is fine */ }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Display

let noticeTimer;
function notify(message) {
  clearTimeout(noticeTimer);
  el.notice.textContent = message;
  el.notice.hidden = !message;
  if (message) noticeTimer = setTimeout(() => { el.notice.hidden = true; }, 8000);
}

function overlay(message) {
  el.overlayText.textContent = message || "";
  el.overlay.hidden = !message;
}

function end(message) {
  finished = true;
  clearInterval(poll);
  if (viewer) viewer.stop();
  viewer = null;
  view = null;
  for (const b of [el.take, el.give, el.leave]) b.hidden = true;
  el.tools.hidden = true;
  el.tabs.hidden = true;
  el.stage.hidden = true;
  el.state.textContent = "";
  el.state.classList.remove("mine");
  overlay(message);
}

function render(next) {
  view = next;
  if (!view || finished) return;
  const holder = view.control.holder;
  const canControl = view.access.modes.includes("control");
  const cooldown = view.access.controlCooldownSec || 0;
  el.name.textContent = view.name;
  document.title = `${view.name} - shared browser`;
  const says = {
    you: "You are in control. Click the page, then type.",
    agent: "The agent is using this browser.",
    nobody: "Nobody is using this browser right now.",
    operator: "The owner is in control.",
    guest: "Someone else is in control.",
  };
  el.state.textContent = view.status === "running" ? says[holder] || "" : "The browser is starting…";
  el.state.classList.toggle("mine", holder === "you");
  el.take.hidden = !canControl || holder === "you";
  el.take.disabled = busy || holder === "operator" || holder === "guest" || cooldown > 0;
  el.take.textContent = cooldown > 0 ? `Take control (in ${cooldown}s)` : "Take control";
  el.give.hidden = holder !== "you";
  el.give.disabled = busy;
  el.leave.hidden = false;

  const controlling = holder === "you" && viewer && viewer.mode === "control";
  const nav = view.access.navigation;
  el.tools.hidden = !controlling;
  el.url.hidden = nav === "none";
  el.newtab.hidden = nav === "none";
  el.tabs.hidden = !controlling || nav === "none";
  el.foot.textContent = `Shared with ${view.access.label}. This access ends ${new Date(view.access.expiresAt).toLocaleString()}.`;
}

async function refresh() {
  if (finished) return;
  try {
    const out = await api("/browser");
    render(out.browser);
    // Lost control without our socket noticing yet (it will close with 4003 too).
    if (viewer && viewer.mode === "control" && out.browser.control.holder !== "you") connect("watch");
    if (!viewer && out.browser.status === "running") connect("watch");
  } catch (e) {
    if (e.status === 401) end(ENDED);
  }
}

// ---------------------------------------------------------------------------------------------
// Viewer

const CODE_VKEY = {
  Backspace: 8, Tab: 9, NumpadEnter: 13, Enter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17,
  ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
};

function vkeyFor(e) {
  const c = e.code || "";
  if (c in CODE_VKEY) return CODE_VKEY[c];
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
  if (/^Digit[0-9]$/.test(c)) return c.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(c)) return 96 + Number(c.slice(6));
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(c);
  if (fn) return 111 + Number(fn[1]);
  const k = e.key || "";
  if (/^[a-zA-Z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  return undefined;
}

const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

function keyMessage(e, up) {
  const command = e.ctrlKey || e.metaKey;
  const text = command ? undefined : e.key === "Enter" ? "\r" : e.key.length === 1 ? e.key : undefined;
  return {
    type: "key",
    event: up ? "keyUp" : text ? "keyDown" : "rawKeyDown",
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: vkeyFor(e),
    location: e.location || undefined,
    isKeypad: e.location === 3 || undefined,
    modifiers: mods(e),
    text: up ? undefined : text,
  };
}

const BUTTON = ["left", "middle", "right"];

/** Map a pointer event on the letterboxed canvas to a point in the remote page. */
function framePoint(canvas, e, frame) {
  const r = canvas.getBoundingClientRect();
  const nw = canvas.width;
  const nh = canvas.height;
  if (!nw || !nh || !r.width || !r.height) return null;
  const scale = Math.min(r.width / nw, r.height / nh);
  const fx = (e.clientX - r.left - (r.width - nw * scale) / 2) / scale;
  const fy = (e.clientY - r.top - (r.height - nh * scale) / 2) / scale;
  if (fx < 0 || fy < 0 || fx > nw || fy > nh) return null;
  const dw = (frame && frame.w) || nw;
  const dh = (frame && frame.h) || nh;
  return { x: Math.round((fx * dw) / nw), y: Math.round((fy * dh) / nh) };
}

function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[^\s/]+\.[^\s]+$/.test(t)) return `https://${t}`;
  return null;
}

function openViewer(mode, leaseToken) {
  const canvas = el.stage;
  const ctx = canvas.getContext("2d");
  let ws = null;
  let stopped = false;
  let attempt = 0;
  let retry;
  let beat;
  let frame = null;
  let nextFrame = null;
  let decoding = false;
  let tabs = [];
  let activeTargetId = null;

  const sendJson = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  const paint = () => {
    if (decoding || !nextFrame || stopped) return;
    const buf = nextFrame;
    nextFrame = null;
    decoding = true;
    createImageBitmap(new Blob([buf]))
      .then((bitmap) => {
        decoding = false;
        if (stopped) { bitmap.close(); return; }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        overlay("");
        canvas.classList.remove("stale");
        if (nextFrame) requestAnimationFrame(paint);
      })
      .catch(() => { decoding = false; });
  };

  const renderTabs = () => {
    el.tabs.replaceChildren();
    for (const t of tabs) {
      const wrap = document.createElement("div");
      wrap.className = "tab";
      wrap.setAttribute("role", "tab");
      wrap.setAttribute("aria-selected", String(t.targetId === activeTargetId));
      const pick = document.createElement("button");
      pick.className = "pick";
      pick.type = "button";
      pick.textContent = t.title || t.url || "New tab";
      pick.title = t.url || "";
      pick.onclick = () => sendJson({ type: "selectTab", targetId: t.targetId });
      const shut = document.createElement("button");
      shut.className = "shut";
      shut.type = "button";
      shut.textContent = "×";
      shut.setAttribute("aria-label", `Close ${t.title || "tab"}`);
      shut.onclick = () => sendJson({ type: "closeTab", targetId: t.targetId });
      wrap.append(pick, shut);
      el.tabs.append(wrap);
    }
    const active = tabs.find((t) => t.targetId === activeTargetId);
    if (active && document.activeElement !== el.url) el.url.value = active.url === "about:blank" ? "" : active.url;
  };

  const schedule = () => {
    if (stopped) return;
    if (attempt >= 6) {
      overlay("Lost the live view. Reload this page to try again.");
      return;
    }
    const wait = Math.min(1000 * 2 ** attempt, 15000) * (0.5 + Math.random());
    attempt += 1;
    retry = setTimeout(() => void open(), wait);
  };

  const open = async () => {
    if (stopped) return;
    let ticket;
    let browserId;
    try {
      ({ ticket, browserId } = await api("/viewer-ticket", { method: "POST", body: { mode } }));
    } catch (e) {
      if (stopped) return;
      if (e.status === 401) { end(ENDED); return; }
      if (e.status === 403 && mode === "control") { void refresh(); connect("watch"); return; }
      schedule();
      return;
    }
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/v1/browsers/${encodeURIComponent(browserId)}/view?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") {
        nextFrame = ev.data;
        if (!decoding) requestAnimationFrame(paint);
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "frameMeta") { frame = { w: msg.width, h: msg.height }; return; }
      if (msg.type === "hello") {
        attempt = 0;
        if (msg.content && msg.content.width) frame = { w: msg.content.width, h: msg.content.height };
        return;
      }
      if (msg.type === "tabs") {
        tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
        activeTargetId = msg.activeTargetId || null;
        renderTabs();
        return;
      }
      if (msg.type === "notice") { notify(String(msg.message || "")); return; }
      if (msg.type === "cursor") { canvas.style.cursor = String(msg.cursor || "default"); return; }
      if (msg.type === "error") {
        if (msg.message === "guest access ended") {
          end(ENDED);
        } else if (mode === "control") {
          notify("Your turn ended, so control went back to the browser's owner or agent.");
          void refresh();
          connect("watch");
        }
      }
    });
    ws.addEventListener("open", () => {
      if (mode === "control") sendJson({ type: "heartbeat", leaseToken });
    });
    ws.addEventListener("close", (ev) => {
      clearInterval(beat);
      if (stopped) return;
      if (ev.code === 4001) { end(ENDED); return; }
      if (ev.code === 4004) { end("The page you were shown has been closed. Ask the person who shared this browser if you still need it."); return; }
      if (ev.code === 4003) {
        notify("Your turn ended, so control went back to the browser's owner or agent.");
        void refresh();
        connect("watch");
        return;
      }
      canvas.classList.add("stale");
      overlay("The live view dropped. Reconnecting…");
      schedule();
    });
    if (mode === "control") {
      clearInterval(beat);
      beat = setInterval(() => {
        if (document.visibilityState === "visible") sendJson({ type: "heartbeat", leaseToken });
      }, 15000);
    }
  };

  const onVisible = () => {
    if (mode === "control" && document.visibilityState === "visible") sendJson({ type: "heartbeat", leaseToken });
  };
  document.addEventListener("visibilitychange", onVisible);

  // Input, control mode only. Keys go to the remote page only while the stage has focus.
  const at = (e) => framePoint(canvas, e, frame);
  const handlers = {
    mousemove: (e) => { const p = at(e); if (p) sendJson({ type: "mouse", event: "mouseMoved", ...p }); },
    mousedown: (e) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      canvas.focus();
      sendJson({ type: "mouse", event: "mousePressed", button: BUTTON[e.button] || "left", clickCount: e.detail || 1, modifiers: mods(e), ...p });
    },
    mouseup: (e) => {
      const p = at(e);
      if (p) sendJson({ type: "mouse", event: "mouseReleased", button: BUTTON[e.button] || "left", clickCount: e.detail || 1, modifiers: mods(e), ...p });
    },
    contextmenu: (e) => e.preventDefault(),
    wheel: (e) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      sendJson({ type: "scroll", ...p, deltaX: e.deltaX, deltaY: e.deltaY });
    },
    keydown: (e) => {
      if (e.key === "Escape") { canvas.blur(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return; // let the paste event fire
      e.preventDefault();
      sendJson(keyMessage(e, false));
    },
    keyup: (e) => {
      if (e.key === "Escape") return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
      e.preventDefault();
      sendJson(keyMessage(e, true));
    },
    paste: (e) => {
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const capped = text.length > 16384 ? text.slice(0, 16384) : text;
      sendJson({ type: "paste", text: capped });
      if (capped.length < text.length) notify(`Pasted the first ${capped.length} characters.`);
    },
  };
  if (mode === "control") {
    for (const [name, fn] of Object.entries(handlers)) canvas.addEventListener(name, fn, name === "wheel" ? { passive: false } : undefined);
    canvas.classList.add("control");
    el.back.onclick = () => sendJson({ type: "historyGo", delta: -1 });
    el.fwd.onclick = () => sendJson({ type: "historyGo", delta: 1 });
    el.reload.onclick = () => sendJson({ type: "reload" });
    el.newtab.onclick = () => sendJson({ type: "newTab" });
    el.url.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      const url = toUrl(el.url.value);
      if (!url) { notify("That is not a web address."); return; }
      sendJson({ type: "navigate", url });
      el.url.blur();
    };
  }

  void open();

  return {
    mode,
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisible);
      for (const [name, fn] of Object.entries(handlers)) canvas.removeEventListener(name, fn);
      canvas.classList.remove("control");
      canvas.style.cursor = "";
      // 1000 tells the server this was on purpose. For a control socket that also hands the
      // lease back, which is what leaving should do.
      if (ws && ws.readyState <= 1) ws.close(1000);
    },
  };
}

function connect(mode) {
  if (finished) return;
  if (viewer) viewer.stop();
  const lease = mode === "control" && view ? view.control.leaseToken : null;
  if (mode === "control" && !lease) mode = "watch";
  viewer = openViewer(mode, lease);
  el.stage.hidden = false;
  render(view);
  if (mode === "control") el.stage.focus();
}

// ---------------------------------------------------------------------------------------------
// Actions

async function act(fn) {
  if (busy) return;
  busy = true;
  render(view);
  try {
    await fn();
  } catch (e) {
    if (e.status === 401) end(ENDED);
    else notify(e.message);
  } finally {
    busy = false;
    render(view);
  }
}

el.take.onclick = () => act(async () => {
  const out = await api("/control", { method: "POST", body: {} });
  render(out.browser);
  connect("control");
});

el.give.onclick = () => act(async () => {
  if (viewer) viewer.stop();
  viewer = null;
  const out = await api("/control", { method: "DELETE" });
  render(out.browser);
  connect("watch");
});

el.leave.onclick = () => act(async () => {
  if (!confirm("Leave this browser? Your link stops working, and you will need a new one to come back.")) return;
  if (viewer) viewer.stop();
  viewer = null;
  if (view && view.control.holder === "you") await api("/control", { method: "DELETE" }).catch(() => undefined);
  await api("/session", { method: "DELETE" }).catch(() => undefined);
  end("You have left. You can close this tab.");
});

// ---------------------------------------------------------------------------------------------
// Start

async function start(browser) {
  el.welcome.hidden = true;
  el.stage.hidden = false;
  render(browser);
  if (browser.status !== "running") {
    overlay("Starting the browser…");
    render((await api("/start", { method: "POST", body: {} })).browser);
  }
  connect(view && view.control.holder === "you" ? "control" : "watch");
  poll = setInterval(refresh, 10000);
}

function fail(e) {
  end(e.status === 401
    ? "This link has already been used, has ended, or is not valid. Ask the person who shared this browser for a new one."
    : `Could not open this browser: ${e.message}`);
}

async function boot() {
  // Take the token and get it out of the address bar and the history entry before anything
  // else runs. It is sent once, in a POST body, and never stored.
  const token = location.hash.length > 1 ? location.hash.slice(1) : "";
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (!token) {
    try {
      await start((await api("/browser")).browser);
    } catch (e) {
      fail(e);
    }
    return;
  }
  // The link works once, so it waits for a person to press the button. Mail and chat scanners
  // that open links to vet them would otherwise spend it before the guest ever saw the page.
  el.stage.hidden = true;
  overlay("");
  el.state.textContent = "";
  el.welcome.hidden = false;
  el.open.focus();
  el.open.onclick = async () => {
    el.open.disabled = true;
    try {
      await start((await api("/session", { method: "POST", body: { token } })).browser);
    } catch (e) {
      // Already opened in this browser earlier: the cookie from then still works.
      try {
        await start((await api("/browser")).browser);
      } catch {
        el.welcome.hidden = true;
        el.stage.hidden = false;
        fail(e);
      }
    }
  };
}

void boot();
