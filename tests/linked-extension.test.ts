import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
// @ts-expect-error plain JS shipped in the extension
import { extensionFrameIn, extensionUrl, guard, onServer, siteOf, withinSite } from "../extension/guard.js";
// @ts-expect-error plain JS shipped in the extension
import { normalizeServer } from "../extension/address.js";

type Frame = Record<string, unknown>;
type Activity = { kind: string; n: number; key?: string; where?: string };
type State = {
  link: string; releaseAt: number | null; error: string | null; notice: string | null; noticeKind: string | null; noticeTabId: number | null;
  shared: Array<{ tabId: number; since: number; activity: Activity[] }>;
};
const workerSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const tabIds = [11, 22, 33];

/** Run the shipped worker with virtual time; no browser, network, or real timers. */
async function worker(session: { releaseAt?: number } = {}) {
  let now = 100_000;
  let timerId = 0;
  const timers = new Map<number, { at: number; period: number; fn: () => unknown }>();
  const schedule = (fn: () => unknown, delay: number, period = 0) => {
    const id = ++timerId;
    timers.set(id, { at: now + delay, period, fn });
    return id;
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const detached: number[] = [];
  const debuggerCalls: Array<{ tabId: number; method: string }> = [];
  const publications = { storage: 0, badge: 0, panel: 0 };
  const badge = { text: "", color: "", title: "" };
  const panelOpened: number[] = [];
  let command: ((method: string) => Promise<unknown>) | undefined;
  let shortcut: (command: string, tab: Frame) => void = () => {};
  let detachedByChrome: (source: { tabId: number }, reason: string) => void = () => {};
  let detach: (() => Promise<void>) | undefined;
  let updated: (tabId: number, change: Frame, tab: Frame) => void;
  let receive: (msg: Frame, sender: unknown, reply: (value: unknown) => void) => unknown;
  const storedSession: Record<string, unknown> = {
    shared: tabIds.map((tabId) => ({ tabId, sites: null, byAgent: false })), ...session,
  };
  const noopEvent = { addListener: () => {} };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: Socket[] = [];
    readyState = Socket.CONNECTING;
    holdClose = false;
    sent: Frame[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) { Socket.instances.push(this); }
    send(raw: string) {
      assert.equal(this.readyState, Socket.OPEN, "frames must use an open socket");
      this.sent.push(JSON.parse(raw));
    }
    close() {
      if (this.readyState >= Socket.CLOSING) return;
      if (this.holdClose) { this.readyState = Socket.CLOSING; return; }
      this.finishClose();
    }
    finishClose() {
      this.readyState = Socket.CLOSED;
      this.onclose?.({ reason: "" });
    }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    message(msg: Frame) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    welcome() { this.open(); this.message({ event: "welcome" }); }
    dnsFailure() { this.onerror?.(); this.close(); }
  }
  const chrome = {
    action: {
      setBadgeText({ text }: { text: string }) { publications.badge++; badge.text = text; },
      setBadgeBackgroundColor({ color }: { color: string }) { publications.badge++; badge.color = color; },
      setTitle({ title }: { title: string }) { publications.badge++; badge.title = title; },
      setPopup: async () => {},
    },
    commands: { onCommand: { addListener: (fn: typeof shortcut) => { shortcut = fn; } } },
    storage: {
      local: {
        get: async () => ({ conn: { server: "https://tallylamp.example", token: "test-token", browserId: "browser", browserName: "Test browser" } }),
        set: async () => {}, remove: async () => {},
      },
      session: { get: async () => storedSession, set: async (value: object) => { publications.storage++; Object.assign(storedSession, value); } },
    },
    runtime: {
      id: "extension-id", sendMessage: async () => { publications.panel++; },
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } }, onStartup: noopEvent,
    },
    debugger: {
      sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
        debuggerCalls.push({ tabId, method });
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: `TARGET${tabId}`, url: `https://example.test/${tabId}`, title: `Tab ${tabId}` } };
        return command ? command(method) : {};
      },
      detach: async ({ tabId }: { tabId: number }) => { detached.push(tabId); await detach?.(); },
      onEvent: noopEvent, onDetach: { addListener: (fn: typeof detachedByChrome) => { detachedByChrome = fn; } },
    },
    tabs: { onRemoved: noopEvent, onUpdated: { addListener: (fn: typeof updated) => { updated = fn; } }, ungroup: async () => {} },
    alarms: { create() {}, onAlarm: noopEvent },
    sidePanel: { setPanelBehavior: async () => {}, open: async ({ tabId }: { tabId: number }) => { panelOpened.push(tabId); } },
  };
  vm.runInNewContext(workerSource, {
    chrome, navigator: { userAgent: "Chrome/140.0.0.0" }, WebSocket: Socket, URL,
    Date: { now: () => now },
    setTimeout: (fn: () => unknown, ms: number) => schedule(fn, ms),
    setInterval: (fn: () => unknown, ms: number) => schedule(fn, ms, ms),
    clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id),
    extensionFrameIn, extensionUrl, guard, onServer, siteOf, withinSite, normalizeServer,
  }, { filename: "extension/background.js" });
  const state = () => new Promise<State>((resolve) => {
    receive({ type: "getState" }, {}, (value) => resolve(JSON.parse(JSON.stringify(value)).state));
  });
  await state();
  return {
    sockets: Socket.instances, detached, debuggerCalls, state, storedSession, flush, publications, badge, panelOpened,
    shortcut: (name: string, tab: Frame) => shortcut(name, tab),
    detachByChrome: (tabId: number, reason: string) => detachedByChrome({ tabId }, reason),
    update: (tabId: number, change: Frame, tab: Frame) => updated(tabId, change, tab),
    action: (type: string) => new Promise<unknown>(resolve => receive({ type }, {}, resolve)),
    setDetach: (callback: typeof detach) => { detach = callback; },
    setCommand: (callback: typeof command) => { command = callback; },
    advance: async (ms: number) => {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.period) timer.at += timer.period;
        else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

describe("Tallylamp Link worker connection recovery", () => {
  it("revokes all shares before any pending debugger detach completes", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    let finish!: () => void;
    const pendingDetach = new Promise<void>(resolve => { finish = resolve; });
    ext.setDetach(() => pendingDetach);
    const stopped = ext.action("stopAll");
    try {
      await ext.flush();
      assert.deepEqual(ext.detached, tabIds, "independent Chrome detaches start together");
      assert.deepEqual((await ext.state()).shared, [], "agent permissions end immediately");
    } finally { finish(); await stopped; }
  });

  it("publishes a metadata burst once without rewriting share permissions or badges", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    await ext.flush();
    const before = { ...ext.publications };
    for (let i = 0; i < 100; i++) ext.update(11, { title: `Title ${i}` }, { url: "https://example.test/11", title: `Title ${i}` });
    await ext.flush();
    assert.equal(ext.publications.storage, before.storage);
    assert.equal(ext.publications.badge, before.badge);
    assert.equal(ext.publications.panel, before.panel + 1);
    const state = await ext.state() as State & { shared: Array<{ tabId: number; title: string }> };
    assert.equal(state.shared.find(t => t.tabId === 11)!.title, "Title 99");
  });

  it("restores all three shared tabs after a DNS failure without sharing again", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    ext.sockets[0].dnsFailure();
    assert.equal((await ext.state()).link, "offline");
    await ext.advance(1_000);
    ext.sockets[1].dnsFailure();
    await ext.advance(2_000);
    ext.sockets[2].welcome();
    assert.equal((await ext.state()).link, "online");
    assert.deepEqual((await ext.state()).shared.map((tab) => tab.tabId), tabIds);
    assert.deepEqual((ext.sockets[2].sent[0].tabs as Array<{ tabId: number }>).map((tab) => tab.tabId), tabIds);
    assert.deepEqual(ext.detached, []);
  });

  it("times out a socket stuck establishing its connection", async () => {
    const ext = await worker();
    ext.sockets[0].holdClose = true;
    await ext.advance(10_000);
    assert.equal((await ext.state()).link, "offline");
    await ext.advance(1_000);
    assert.equal(ext.sockets.length, 2);
  });

  it("times out an open socket that never receives welcome", async () => {
    const ext = await worker();
    ext.sockets[0].open();
    await ext.advance(10_000);
    assert.equal((await ext.state()).link, "offline");
    await ext.advance(1_000);
    assert.equal(ext.sockets.length, 2);
  });

  it("recovers from a DNS error before Chrome delivers the close event", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    ext.sockets[0].holdClose = true;
    ext.sockets[0].onerror?.();
    assert.equal((await ext.state()).link, "offline");
    await ext.advance(1_000);
    assert.equal(ext.sockets.length, 2);
    ext.sockets[1].welcome();
    ext.sockets[0].finishClose();
    assert.equal((await ext.state()).link, "online");
    assert.equal((await ext.state()).releaseAt, null);
  });

  it("detects missing pong while the browser still reports the socket open", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    await ext.advance(20_000);
    assert.equal(ext.sockets[0].sent.at(-1)?.event, "ping");
    await ext.advance(10_000);
    assert.equal((await ext.state()).link, "offline");
    assert.deepEqual(ext.detached, []);
    await ext.advance(1_000);
    assert.equal(ext.sockets.length, 2);
    ext.sockets[1].welcome();
    assert.equal((await ext.state()).releaseAt, null);
  });

  it("keeps a responsive connection online without detaching shared tabs", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    for (let i = 0; i < 6; i++) {
      await ext.advance(20_000);
      ext.sockets[0].message({ event: "pong" });
    }
    assert.equal((await ext.state()).link, "online");
    assert.equal(ext.sockets.length, 1);
    assert.deepEqual(ext.detached, []);
  });

  it("ignores late open, welcome, and command events from the replaced socket", async () => {
    const ext = await worker();
    const stale = ext.sockets[0];
    const lateOpen = stale.onopen!;
    const lateMessage = stale.onmessage!;
    stale.dnsFailure();
    await ext.advance(1_000);
    const oldFrames = stale.sent.length;
    lateOpen();
    lateMessage({ data: JSON.stringify({ event: "welcome" }) });
    lateMessage({ data: JSON.stringify({ id: 51, method: "cdp", params: { tabId: 11, method: "Page.enable" } }) });
    await ext.flush();
    assert.equal(stale.sent.length, oldFrames);
    assert.equal((await ext.state()).link, "offline");
    assert.equal(ext.debuggerCalls.filter((call) => call.method === "Page.enable").length, 0);
  });

  it("never sends an old connection's asynchronous command reply to the new connection", async () => {
    const ext = await worker();
    let resolveCommand: (value: unknown) => void = () => {};
    ext.setCommand(() => new Promise((resolve) => { resolveCommand = resolve; }));
    ext.sockets[0].welcome();
    ext.sockets[0].message({ id: 71, method: "cdp", params: { tabId: 11, method: "Page.enable" } });
    await ext.flush();
    ext.sockets[0].dnsFailure();
    await ext.advance(1_000);
    ext.sockets[1].welcome();
    resolveCommand({ enabled: true });
    await ext.flush();
    assert.equal(ext.sockets[1].sent.some((frame) => frame.id === 71), false);
  });

  it("keeps the original offline deadline when the worker restarts", async () => {
    const ext = await worker({ releaseAt: 120_000 });
    assert.equal((await ext.state()).releaseAt, 120_000);
    await ext.advance(20_000);
    assert.deepEqual(ext.detached, tabIds);
    assert.equal((await ext.state()).shared.length, 0);
  });

  it("hands back tabs before reconnecting if the saved offline deadline already passed", async () => {
    const ext = await worker({ releaseAt: 99_999 });
    assert.deepEqual(ext.detached, tabIds);
    ext.sockets[0].open();
    assert.deepEqual(ext.sockets[0].sent[0].tabs, []);
  });
});

describe("Tallylamp Link worker, what the panel is told", () => {
  it("keeps what was done in a shared tab as kinds and counts, never the words typed", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    await ext.flush();
    const cdp = (id: number, method: string, params: Frame) => ext.sockets[0].message({ id, method: "cdp", params: { tabId: 11, method, params } });
    cdp(1, "Page.navigate", { url: "https://mail.example.test/inbox?secret=1" });
    cdp(2, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    cdp(3, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, clickCount: 1 });
    cdp(4, "Input.insertText", { text: "hunter2" });
    cdp(5, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" });
    cdp(6, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", text: "\r" });
    cdp(7, "Page.captureScreenshot", {});
    cdp(8, "Runtime.evaluate", { expression: "1" });
    await ext.flush();
    const before = ext.publications.panel;
    await ext.advance(500);
    assert.equal(ext.publications.panel, before + 1, "a burst of input repaints the panel once");
    const state = await ext.state();
    const activity = state.shared.find((t) => t.tabId === 11)!.activity;
    assert.deepEqual(activity.map((a) => [a.kind, a.n]), [["key", 1], ["type", 8], ["click", 1], ["open", 1]]);
    assert.equal(activity[0].key, "Enter");
    assert.equal(activity[3].where, "mail.example.test/inbox", "no query string");
    assert.doesNotMatch(JSON.stringify(state), /hunter2|secret/);
  });

  it("shows the shared count in red, and ! in amber while those tabs are about to be handed back", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    await ext.flush();
    assert.deepEqual([ext.badge.text, ext.badge.color], ["3", "#dc2626"]);
    ext.sockets[0].dnsFailure();
    await ext.flush();
    assert.deepEqual([ext.badge.text, ext.badge.color], ["!", "#b45309"]);
    assert.match(ext.badge.title, /can't reach tallylamp\.example/);
    await ext.advance(60_000);
    assert.equal(ext.badge.text, "");
    assert.equal((await ext.state()).noticeKind, "unreachable");
  });

  it("toggles sharing from the keyboard and opens the panel when it cannot share", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    await ext.flush();
    ext.shortcut("toggle-share", { id: 22, url: "https://example.test/22" });
    await ext.flush();
    assert.deepEqual((await ext.state()).shared.map((t) => t.tabId), [11, 33]);
    ext.shortcut("toggle-share", { id: 44, url: "chrome://settings" });
    await ext.flush();
    assert.deepEqual(ext.panelOpened, [44], "a page Chrome keeps to itself opens the panel, which says why");
  });

  it("says which tab a handback was about, so the panel can offer the way back", async () => {
    const ext = await worker();
    ext.sockets[0].welcome();
    ext.detachByChrome(22, "canceled_by_user");
    await ext.flush();
    const state = await ext.state();
    assert.equal(state.noticeKind, "cancel");
    assert.equal(state.noticeTabId, 22);
    assert.ok(state.shared.every((t) => Number.isFinite(t.since)));
  });
});

describe("Tallylamp Link panel connection status", () => {
  it("carries the dashboard's orb files unchanged", () => {
    for (const file of ["orbs.js", "thinking-orbs.js", "thinking-orbs.LICENSE"]) {
      const theirs = readFileSync(new URL(`../dashboard/vendor/${file}`, import.meta.url), "utf8");
      const ours = readFileSync(new URL(`../extension/vendor/${file}`, import.meta.url), "utf8");
      assert.equal(ours, theirs, `extension/vendor/${file} has drifted from dashboard/vendor/${file}; copy it across`);
    }
  });

  it("updates only the clock text and suspends its timer while hidden", () => {
    const source = readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("let timed = [];"), source.indexOf('document.addEventListener("visibilitychange"'));
    let now = 1000;
    const timers = new Map<number, () => void>();
    const document = { visibilityState: "visible" };
    const api = vm.runInNewContext(`${code}; ({ clock, updateTimers })`, {
      document, Date: { now: () => now }, h: () => ({ textContent: "" }),
      setInterval: (fn: () => void) => { timers.set(1, fn); return 1; }, clearInterval: (id: number) => timers.delete(id),
    }) as { clock: (show: (now: number) => [string, boolean]) => { textContent: string }; updateTimers: () => void };
    const countdown = api.clock((t) => [`${Math.max(0, Math.ceil((4000 - t) / 1000))}s`, t < 4000]);
    api.updateTimers();
    assert.equal(countdown.textContent, "3s");
    now = 2000; timers.get(1)!();
    assert.equal(countdown.textContent, "2s");
    document.visibilityState = "hidden"; api.updateTimers();
    assert.equal(timers.size, 0);
    now = 4000; document.visibilityState = "visible"; api.updateTimers();
    assert.equal(countdown.textContent, "0s");
    assert.equal(timers.size, 0, "an elapsed deadline must not loop forever");
  });

  it("shows reconnecting for an attached tab until the server is online", async () => {
    class Element {
      children: Array<Element | string> = [];
      className = "";
      setAttribute() {}
      addEventListener() {}
      append(child: Element | string) { this.children.push(child); }
      replaceChildren(...children: Array<Element | string>) { this.children = children; }
      get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
      set textContent(text: string) { this.children = [text]; }
    }
    const source = readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
    const render = async (demo: string) => {
      const app = new Element();
      await vm.runInNewContext(`(async () => { ${source}\n })()`, {
        document: { getElementById: () => app, createElement: () => new Element(), activeElement: null, addEventListener() {} },
        location: { search: `?demo=${demo}` }, URLSearchParams, onServer, siteOf, normalizeServer, orb: () => new Element(),
        clearInterval: () => {}, setInterval: () => 1,
      });
      return app.textContent;
    };
    const connecting = await render("shared-connecting");
    assert.match(connecting, /Reconnecting\./);
    assert.match(connecting, /once the connection returns/);
    assert.doesNotMatch(connecting, /Shared\. |Your agent can see and control/);
    assert.match(connecting, /Stop sharing this tab/);
    assert.match(await render("shared-here"), /Shared\. /);
  });

  it("renders every fixture in words, with no undefined or null showing", async () => {
    const source = readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8");
    const demos = /States: ([^.]+)\./.exec(source)![1].replace(/\s*\/\/\s*/g, " ").split(/,\s*/).map((d) => d.trim());
    assert.ok(demos.length >= 16, demos.join(" "));
    class Element {
      children: Array<Element | string> = [];
      className = "";
      setAttribute() {}
      addEventListener() {}
      append(child: Element | string) { this.children.push(child); }
      replaceChildren(...children: Array<Element | string>) { this.children = children; }
      get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
      set textContent(text: string) { this.children = [text]; }
    }
    const texts: Record<string, string> = {};
    for (const demo of demos) {
      const app = new Element();
      await vm.runInNewContext(`(async () => { ${source.replace(/^import .*;\n/gm, "")}\n })()`, {
        document: { getElementById: () => app, createElement: () => new Element(), activeElement: null, addEventListener() {} },
        location: { search: `?demo=${demo}` }, URLSearchParams, onServer, siteOf, normalizeServer, orb: () => new Element(),
        clearInterval: () => {}, setInterval: () => 1,
      });
      texts[demo] = app.textContent;
      assert.doesNotMatch(texts[demo], /undefined|null|NaN|\[object/, demo);
    }
    assert.match(texts.pairing, /KXQ7-M2PD|K.*X.*Q.*7/);
    assert.match(texts.linked, /Linked to tallylamp\.example\.com/);
    assert.match(texts.offline, /handed back in 4\ds/);
    assert.match(texts["other-extension"], /Reload and share/);
    assert.doesNotMatch(texts["other-extension"], /Share this tab/, "one way forward, not two");
    assert.match(texts.unshareable, /Share one of these instead/);
    assert.match(texts["notice-left"], /Go to the tab/);
  });
});
