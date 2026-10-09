import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
// @ts-expect-error plain JS shipped in the extension
import { extensionFrameIn, extensionUrl, guard, onServer, siteOf, withinSite } from "../extension/guard.js";
// @ts-expect-error plain JS shipped in the extension
import { normalizeServer } from "../extension/address.js";

type Frame = Record<string, unknown>;
type State = { link: string; releaseAt: number | null; shared: Array<{ tabId: number }> };
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
  let command: ((method: string) => Promise<unknown>) | undefined;
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
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {}, setPopup: async () => {} },
    storage: {
      local: {
        get: async () => ({ conn: { server: "https://tallylamp.example", token: "test-token", browserId: "browser", browserName: "Test browser" } }),
        set: async () => {}, remove: async () => {},
      },
      session: { get: async () => storedSession, set: async (value: object) => { Object.assign(storedSession, value); } },
    },
    runtime: {
      id: "extension-id", sendMessage: async () => {},
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } }, onStartup: noopEvent,
    },
    debugger: {
      sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
        debuggerCalls.push({ tabId, method });
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: `TARGET${tabId}`, url: `https://example.test/${tabId}`, title: `Tab ${tabId}` } };
        return command ? command(method) : {};
      },
      detach: async ({ tabId }: { tabId: number }) => { detached.push(tabId); },
      onEvent: noopEvent, onDetach: noopEvent,
    },
    tabs: { onRemoved: noopEvent, onUpdated: noopEvent, ungroup: async () => {} },
    alarms: { create() {}, onAlarm: noopEvent },
    sidePanel: { setPanelBehavior: async () => {} },
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
    sockets: Socket.instances, detached, debuggerCalls, state, storedSession, flush,
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

describe("Tallylamp Link panel connection status", () => {
  it("shows reconnecting for an attached tab until the server is online", async () => {
    class Element {
      children: Array<Element | string> = [];
      className = "";
      setAttribute() {}
      addEventListener() {}
      append(child: Element | string) { this.children.push(child); }
      replaceChildren(...children: Array<Element | string>) { this.children = children; }
      get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
    }
    const source = readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
    const render = async (demo: string) => {
      const app = new Element();
      await vm.runInNewContext(`(async () => { ${source}\n })()`, {
        document: { getElementById: () => app, createElement: () => new Element(), activeElement: null },
        location: { search: `?demo=${demo}` }, URLSearchParams, onServer, siteOf,
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
});
