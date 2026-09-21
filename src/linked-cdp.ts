import http from "node:http";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import type { ChromeRuntime } from "./chrome.js";
import { log } from "./log.js";

/**
 * A loopback CDP endpoint in front of a linked browser.
 *
 * Everything in this process that drives a browser -- the chrome-devtools-mcp bridge, the
 * viewer, thumbnails, the page poll -- asks for nothing more than an HTTP CDP URL. So a
 * linked browser is made to look like one. The shim listens on 127.0.0.1, answers
 * /json/version and /json/list, and speaks browser-level CDP on its socket. Behind it is
 * the extension, which can only do `chrome.debugger.sendCommand` on tabs a person has
 * shared, so the browser-level half of the protocol has to be invented here.
 *
 * What is invented, and why:
 *
 *  - Puppeteer does not attach to pages at the root. It asks for `tab` targets, attaches to
 *    those, and auto-attaches again on the tab session to reach the page. chrome.debugger
 *    has no tab target, so each shared tab gets a synthetic one ("tab-<tabId>") wrapped
 *    round the REAL page target. The page's targetId is real because the main frame's id is
 *    the same string and Puppeteer joins the two.
 *  - Top-level session ids are synthetic and per client. The extension holds one debugger
 *    attachment per tab however many clients are looking at it, so two clients cannot both
 *    own "the" session. Child sessions (OOPIFs, workers) keep their real ids and are shared.
 *  - A target is only ever announced once the extension has already attached to it.
 *    Puppeteer's connect() blocks until every announced target is attached or filtered, so
 *    announcing a tab that then refuses the debugger (chrome://, the Web Store) would hang
 *    every client forever.
 */

export type TargetInfo = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
  canAccessOpener?: boolean;
};

export type LinkedTab = { tabId: number; info: TargetInfo };

/**
 * What the shim needs from the far end. An interface rather than the socket class so a test
 * can stand a scripted peer in for the extension.
 *
 * Emits: "shared" (tab), "updated" (tab), "unshared" (tabId, reason),
 * "cdp" (tabId, sessionId | undefined, method, params), "close".
 */
export interface LinkPeer extends EventEmitter {
  readonly product: string;
  readonly userAgent: string;
  tabs(): ReadonlyMap<number, LinkedTab>;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

type CdpRequest = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
type Session = { tabId: number; level: "tab" | "page"; parent?: string };
type ChildAttach = { envelope?: string; params: Record<string, unknown> };

const tabTargetId = (tabId: number) => `tab-${tabId}`;

/** Refusals carry a sentence, because the agent reads them and has to decide what to do next. */
class Refused extends Error {}

/**
 * TALLYLAMP_LINK_TRACE=1 logs every CDP method crossing the shim. When a client hangs in
 * connect() the question is always "which message is it waiting for", and this answers it.
 */
const trace = process.env.TALLYLAMP_LINK_TRACE === "1"
  ? (dir: string, msg: Record<string, unknown>) =>
      log.info(`link-cdp ${dir}`, { id: msg.id, method: msg.method, sessionId: msg.sessionId, error: (msg.error as { message?: string } | undefined)?.message, target: ((msg.params as any)?.targetInfo as TargetInfo | undefined)?.type })
  : undefined;

/** One CDP client socket: the bridge child, a viewer, a thumbnail grab. */
class Front {
  discover = false;
  wantsTabs = false;
  autoAttach: "off" | "tabs" | "pages" = "off";
  readonly sessions = new Map<string, Session>();

  constructor(private readonly ws: WebSocket) {}

  send(msg: Record<string, unknown>): void {
    trace?.("->", msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  open(tabId: number, level: Session["level"], parent?: string): string {
    const id = randomBytes(16).toString("hex").toUpperCase();
    this.sessions.set(id, { tabId, level, parent });
    return id;
  }

  find(tabId: number, level: Session["level"]): string | undefined {
    for (const [id, s] of this.sessions) if (s.tabId === tabId && s.level === level) return id;
    return undefined;
  }

  pageSessions(tabId: number): string[] {
    return [...this.sessions].filter(([, s]) => s.tabId === tabId && s.level === "page").map(([id]) => id);
  }
}

export function startLinkedRuntime(peer: LinkPeer): Promise<{ runtime: ChromeRuntime; close: () => Promise<void> }> {
  const fronts = new Set<Front>();
  // Real child session id -> the tab whose debugger attachment it lives under.
  const childTab = new Map<string, number>();
  // What a client that auto-attaches late has missed. Chrome replays existing children to
  // each session that asks; one shared attachment cannot, so the replay is done from here.
  const children = new Map<number, Map<string, ChildAttach>>();
  const autoAttached = new Set<number>();
  // Domains a client switched on, per tab. The extension holds ONE debugger attachment per tab
  // however many clients are looking at it, so nothing Chrome does when a client's socket dies
  // turns these off again: the attachment is still there and the domain is still enabled. Left
  // alone, a tab whose agent finished an hour ago keeps pushing Network and Page events up the
  // link for nobody, and a left-behind Fetch.enable holds every request in that tab waiting on
  // a handler that has gone. Undone when the LAST client leaves, never before -- while one is
  // still attached the events are its events.
  const enabled = new Map<number, Set<string>>();
  let closed = false;
  let wsUrl = "";

  const pageInfo = (tab: LinkedTab): TargetInfo => ({ canAccessOpener: false, ...tab.info, type: "page", attached: true });
  const tabInfo = (tab: LinkedTab): TargetInfo => ({
    targetId: tabTargetId(tab.tabId),
    type: "tab",
    title: tab.info.title,
    url: tab.info.url,
    attached: true,
    canAccessOpener: false,
    browserContextId: tab.info.browserContextId,
  });

  /** Remember what a client turns on, so the last one out can turn it off again. */
  const note = (tabId: number, method: string): void => {
    const [domain, verb] = method.split(".");
    if (verb === "enable") {
      let on = enabled.get(tabId);
      if (!on) enabled.set(tabId, (on = new Set()));
      on.add(domain);
    } else if (verb === "disable") {
      enabled.get(tabId)?.delete(domain);
    }
  };

  const byTarget = (targetId: unknown): LinkedTab | undefined => {
    for (const tab of peer.tabs().values()) {
      if (tab.info.targetId === targetId || tabTargetId(tab.tabId) === targetId) return tab;
    }
    return undefined;
  };

  const needTab = (targetId: unknown): LinkedTab => {
    const tab = targetId === undefined ? peer.tabs().values().next().value : byTarget(targetId);
    if (!tab) {
      throw new Refused(
        targetId === undefined
          ? "no tab is shared with Tallylamp; ask the person at this browser to share one from the extension"
          : "that tab is not shared with Tallylamp",
      );
    }
    return tab;
  };

  const announce = (front: Front, tab: LinkedTab): void => {
    if (front.discover) {
      if (front.wantsTabs) front.send({ method: "Target.targetCreated", params: { targetInfo: tabInfo(tab) } });
      front.send({ method: "Target.targetCreated", params: { targetInfo: pageInfo(tab) } });
    }
    attachRoot(front, tab);
  };

  const attachRoot = (front: Front, tab: LinkedTab): void => {
    if (front.autoAttach === "off") return;
    const level = front.autoAttach === "tabs" ? "tab" : "page";
    if (front.find(tab.tabId, level)) return;
    const sessionId = front.open(tab.tabId, level);
    front.send({
      method: "Target.attachedToTarget",
      params: { sessionId, targetInfo: level === "tab" ? tabInfo(tab) : pageInfo(tab), waitingForDebugger: false },
    });
  };

  const onShared = (tab: LinkedTab) => fronts.forEach((f) => announce(f, tab));

  const onUpdated = (tab: LinkedTab) => {
    for (const f of fronts) {
      if (!f.discover) continue;
      if (f.wantsTabs) f.send({ method: "Target.targetInfoChanged", params: { targetInfo: tabInfo(tab) } });
      f.send({ method: "Target.targetInfoChanged", params: { targetInfo: pageInfo(tab) } });
    }
  };

  const onUnshared = (tabId: number, _reason: string, info?: TargetInfo) => {
    for (const [sid, t] of childTab) if (t === tabId) childTab.delete(sid);
    children.delete(tabId);
    autoAttached.delete(tabId);
    enabled.delete(tabId);
    for (const f of fronts) {
      // Pages before tabs: a page session hangs off its tab session, and Puppeteer walks the
      // same order when it tears a target down.
      for (const level of ["page", "tab"] as const) {
        for (const [sid, s] of [...f.sessions]) {
          if (s.tabId !== tabId || s.level !== level) continue;
          f.sessions.delete(sid);
          const targetId = level === "tab" ? tabTargetId(tabId) : info?.targetId;
          f.send({ method: "Target.detachedFromTarget", params: { sessionId: sid, targetId }, ...(s.parent ? { sessionId: s.parent } : {}) });
        }
      }
      if (!f.discover) continue;
      if (info) f.send({ method: "Target.targetDestroyed", params: { targetId: info.targetId } });
      if (f.wantsTabs) f.send({ method: "Target.targetDestroyed", params: { targetId: tabTargetId(tabId) } });
    }
  };

  const onCdp = (tabId: number, sessionId: string | undefined, method: string, params: Record<string, unknown>) => {
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      childTab.set(params.sessionId, tabId);
      let known = children.get(tabId);
      if (!known) children.set(tabId, (known = new Map()));
      known.set(params.sessionId, { envelope: sessionId, params });
    } else if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      childTab.delete(params.sessionId);
      children.get(tabId)?.delete(params.sessionId);
    }
    for (const f of fronts) {
      const pages = f.pageSessions(tabId);
      if (!pages.length) continue;
      // A child session's events belong to the tab, not to any one synthetic session, so a
      // client holding two sessions on the tab still hears them once.
      if (sessionId) f.send({ method, params, sessionId });
      else for (const sid of pages) f.send({ method, params, sessionId: sid });
    }
  };

  peer.on("shared", onShared);
  peer.on("updated", onUpdated);
  peer.on("unshared", onUnshared);
  peer.on("cdp", onCdp);

  async function root(front: Front, msg: CdpRequest): Promise<unknown> {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "Browser.getVersion":
        return { protocolVersion: "1.3", product: peer.product, revision: "", userAgent: peer.userAgent, jsVersion: "" };
      case "Browser.setDownloadBehavior":
        return {};
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.setDiscoverTargets":
        front.discover = p.discover !== false;
        // Chrome leaves `tab` targets out unless a filter asks for them, and the viewer's
        // page picker would trip over a type it has never seen.
        front.wantsTabs = JSON.stringify(p.filter ?? "").includes('"tab"');
        if (front.discover) {
          for (const tab of peer.tabs().values()) {
            if (front.wantsTabs) front.send({ method: "Target.targetCreated", params: { targetInfo: tabInfo(tab) } });
            front.send({ method: "Target.targetCreated", params: { targetInfo: pageInfo(tab) } });
          }
        }
        return {};
      case "Target.setAutoAttach":
        front.autoAttach = p.autoAttach === false ? "off" : JSON.stringify(p.filter ?? "").includes('"tab"') || front.wantsTabs ? "tabs" : "pages";
        for (const tab of peer.tabs().values()) attachRoot(front, tab);
        return {};
      case "Target.getTargets":
        return { targetInfos: [...peer.tabs().values()].map(pageInfo) };
      case "Target.getTargetInfo":
        return { targetInfo: pageInfo(needTab(p.targetId)) };
      case "Target.attachToTarget": {
        const tab = needTab(p.targetId);
        const sessionId = front.open(tab.tabId, "page");
        // The event first: Puppeteer builds its session object from the event and looks it
        // up by the id in the reply.
        front.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: pageInfo(tab), waitingForDebugger: false } });
        return { sessionId };
      }
      case "Target.detachFromTarget":
        return detach(front, String(p.sessionId ?? ""));
      case "Target.createTarget": {
        const made = (await peer.call("tabs.create", { url: typeof p.url === "string" ? p.url : "about:blank" })) as { tabId: number };
        const tab = peer.tabs().get(made.tabId);
        if (!tab) throw new Refused("the new tab closed before it could be shared");
        return { targetId: tab.info.targetId };
      }
      case "Target.closeTarget":
        await peer.call("tabs.close", { tabId: needTab(p.targetId).tabId });
        return { success: true };
      case "Target.activateTarget":
        await peer.call("tabs.activate", { tabId: needTab(p.targetId).tabId });
        return {};
      default:
        return browserLevel(msg, needTab(undefined));
    }
  }

  /**
   * chrome.debugger exposes no Browser domain at all, and the three things below are the
   * ones a client actually reaches for. Closing, crashing or resizing is refused rather than
   * faked: this is a person's own window, not one launched for the agent.
   */
  async function browserLevel(msg: CdpRequest, tab: LinkedTab): Promise<unknown> {
    const p = msg.params ?? {};
    if (msg.method === "Browser.getWindowForTarget") return peer.call("window.get", { tabId: byTarget(p.targetId)?.tabId ?? tab.tabId });
    if (msg.method === "Browser.getWindowBounds") return peer.call("window.get", { windowId: p.windowId });
    if (msg.method.startsWith("Browser.") || msg.method === "Target.createBrowserContext" || msg.method === "Target.disposeBrowserContext") {
      throw new Refused(`${msg.method} is not available on a linked browser; it is a person's own window. Use emulate to change the viewport.`);
    }
    const result = await peer.call("cdp", { tabId: tab.tabId, method: msg.method, params: p });
    note(tab.tabId, msg.method);
    return result;
  }

  function detach(front: Front, sessionId: string): Record<string, never> {
    const s = front.sessions.get(sessionId);
    if (!s) throw new Refused("no session with that id");
    front.sessions.delete(sessionId);
    const tab = peer.tabs().get(s.tabId);
    const targetId = s.level === "tab" ? tabTargetId(s.tabId) : tab?.info.targetId;
    front.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId }, ...(s.parent ? { sessionId: s.parent } : {}) });
    return {};
  }

  async function inSession(front: Front, msg: CdpRequest, sessionId: string): Promise<unknown> {
    const p = msg.params ?? {};
    const s = front.sessions.get(sessionId);
    if (!s) {
      const tabId = childTab.get(sessionId);
      if (tabId === undefined || !front.pageSessions(tabId).length) throw new Refused("no session with that id");
      return peer.call("cdp", { tabId, sessionId, method: msg.method, params: p });
    }
    const tab = peer.tabs().get(s.tabId);
    if (!tab) throw new Refused("that tab is no longer shared");
    if (s.level === "tab") {
      // The synthetic tab has exactly one job: hand over the page underneath it.
      if (msg.method === "Target.setAutoAttach" && p.autoAttach !== false && !front.pageSessions(s.tabId).some((id) => front.sessions.get(id)?.parent === sessionId)) {
        const page = front.open(s.tabId, "page", sessionId);
        front.send({
          method: "Target.attachedToTarget",
          params: { sessionId: page, targetInfo: pageInfo(tab), waitingForDebugger: false },
          sessionId,
        });
      }
      return {};
    }
    if (msg.method.startsWith("Browser.")) return browserLevel(msg, tab);
    if (msg.method === "Target.detachFromTarget" && typeof p.sessionId === "string" && front.sessions.has(p.sessionId)) {
      return detach(front, p.sessionId);
    }
    if (msg.method === "Target.setAutoAttach" && p.autoAttach !== false && autoAttached.has(s.tabId)) {
      for (const c of children.get(s.tabId)?.values() ?? []) {
        front.send({ method: "Target.attachedToTarget", params: { ...c.params, waitingForDebugger: false }, sessionId: c.envelope ?? sessionId });
      }
      return {};
    }
    const result = await peer.call("cdp", { tabId: s.tabId, method: msg.method, params: p });
    note(s.tabId, msg.method);
    if (msg.method === "Target.setAutoAttach") {
      if (p.autoAttach === false) autoAttached.delete(s.tabId);
      else autoAttached.add(s.tabId);
    }
    return result;
  }

  /**
   * The last client has gone. Put the tabs back the way they were found: turn off every domain
   * a client turned on, and stop auto-attaching to new children. Best effort and unawaited --
   * the usual reason a socket closed is that the far end is already gone, and anything that
   * fails here is something the next client switches on again for itself. Stopping the browser
   * does not come through here: that hands every tab back, and the domains go with the
   * debugger attachment.
   */
  const quiesce = (): void => {
    if (closed || fronts.size) return;
    const send = (tabId: number, method: string, params: Record<string, unknown> = {}) =>
      void peer.call("cdp", { tabId, method, params }).catch(() => undefined);
    for (const [tabId, domains] of enabled) for (const domain of domains) send(tabId, `${domain}.disable`);
    enabled.clear();
    for (const tabId of autoAttached) {
      send(tabId, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    }
    autoAttached.clear();
  };

  const server = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.url === "/json/version") {
      return json({ Browser: peer.product, "Protocol-Version": "1.3", "User-Agent": peer.userAgent, webSocketDebuggerUrl: wsUrl });
    }
    if (req.url === "/json/list" || req.url === "/json") {
      // No per-page socket URL, on purpose. The site detector dials those to probe for a
      // login, and quietly inspecting somebody's own tabs is not something they agreed to by
      // sharing one with an agent.
      return json([...peer.tabs().values()].map((t) => ({ id: t.info.targetId, type: "page", url: t.info.url, title: t.info.title })));
    }
    res.statusCode = 404;
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const front = new Front(ws);
      fronts.add(front);
      const gone = () => {
        fronts.delete(front);
        quiesce();
      };
      ws.on("close", gone);
      ws.on("error", gone);
      ws.on("message", (raw) => {
        let msg: CdpRequest;
        try {
          msg = JSON.parse(String(raw)) as CdpRequest;
        } catch {
          return;
        }
        if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
        trace?.("<-", msg as unknown as Record<string, unknown>);
        const reply = msg.sessionId ? { id: msg.id, sessionId: msg.sessionId } : { id: msg.id };
        (msg.sessionId ? inSession(front, msg, msg.sessionId) : root(front, msg)).then(
          (result) => front.send({ ...reply, result: result ?? {} }),
          (e: Error) => front.send({ ...reply, error: { code: e instanceof Refused ? -32000 : -32603, message: e.message } }),
        );
      });
    });
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    peer.off("shared", onShared);
    peer.off("updated", onUpdated);
    peer.off("unshared", onUnshared);
    peer.off("cdp", onCdp);
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
      setTimeout(r, 500).unref();
    });
  };
  peer.once("close", () => void close());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      wsUrl = `ws://127.0.0.1:${port}/devtools/browser/linked`;
      log.info("linked browser endpoint up", { port, tabs: peer.tabs().size });
      const runtime: ChromeRuntime = {
        display: null,
        cdpPort: port,
        cdpUrl: `http://127.0.0.1:${port}`,
        // There is no process. Liveness is the link: once it drops, this reads as exited, so
        // anything that still holds the runtime stops trusting it.
        chrome: {
          pid: undefined,
          get exitCode() {
            return closed ? 0 : null;
          },
          unref() {},
          kill() {
            return false;
          },
        } as unknown as ChromeRuntime["chrome"],
        sandboxStatus: "unknown",
        gpuStatus: "unknown",
        profileDir: "",
        downloadDir: "",
        screen: { width: 0, height: 0 },
      };
      resolve({ runtime, close });
    });
  });
}
