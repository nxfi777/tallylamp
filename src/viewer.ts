import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { sha256 } from "./auth.js";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { CdpClient } from "./cdp.js";
import type { BrowserManager } from "./browsers.js";
import { log } from "./log.js";
import { hub } from "./events.js";
import { parseSize } from "./chrome.js";
import { onUpgrade } from "./upgrades.js";

export function issueViewerTicket(browserId: string, sessionId: string, mode: "watch" | "control"): string {
  const token = randomBytes(24).toString("base64url");
  const id = randomBytes(8).toString("hex");
  const expires = new Date(Date.now() + config.viewerTicketTtlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO viewer_tickets(id, browser_id, session_id, token_hash, mode, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, browserId, sessionId, sha256(token), mode, nowIso(), expires);
  return token;
}

export function consumeViewerTicket(token: string, browserId: string): { mode: "watch" | "control"; sessionId: string } {
  const row = getDb()
    .prepare(`SELECT id, browser_id, session_id, mode, expires_at, used FROM viewer_tickets WHERE token_hash = ?`)
    .get(sha256(token)) as
    | { id: string; browser_id: string; session_id: string; mode: "watch" | "control"; expires_at: string; used: number }
    | undefined;
  if (!row) throw new Error("invalid viewer ticket");
  if (row.browser_id !== browserId) throw new Error("ticket is for a different browser");
  if (row.used) throw new Error("ticket already used");
  if (Date.parse(row.expires_at) < Date.now()) throw new Error("ticket expired");
  getDb().prepare(`UPDATE viewer_tickets SET used = 1 WHERE id = ?`).run(row.id);
  return { mode: row.mode, sessionId: row.session_id };
}

export function attachViewerUpgrade(server: import("node:http").Server, browsers: BrowserManager): WebSocketServer {
  // ws defaults maxPayload to 100 MiB. A viewer only ever sends small control JSON, and
  // JSON.parse of a 90 MiB frame cost the process 367 MB in testing.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  onUpgrade(server, (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = url.pathname.match(/^\/api\/v1\/browsers\/([^/]+)\/view$/);
    // Not a viewer path: leave it to the other handlers. The router closes what nobody
    // claims, so declining here cannot leak the socket.
    if (!m) return false;
    // Guard only the handshake window; cleared once the upgrade succeeds so a quiet page
    // does not get its viewer torn down.
    const netSocket = socket as import("node:net").Socket;
    netSocket.setTimeout(15_000, () => socket.destroy());
    const browserId = m[1];
    const token = url.searchParams.get("ticket") ?? "";
    try {
      const ticket = consumeViewerTicket(token, browserId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        netSocket.setTimeout(0);
        void runViewer(ws, req, browsers, browserId, ticket.mode);
      });
    } catch (e) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log.warn("viewer upgrade rejected", { error: (e as Error).message });
    }
    return true;
  });
  return wss;
}

type TargetRow = { targetId: string; type: string; subtype?: string; title?: string; url?: string };

/** A page the human may be shown. Prerenders and devtools:// pages are not tabs. */
function isTab(t: TargetRow): boolean {
  return t.type === "page" && !t.subtype && !String(t.url ?? "").startsWith("devtools://");
}

/**
 * Coerce a client-supplied dimension. JSON.stringify turns NaN and Infinity into null, and
 * Chrome's int32 deserializer rejects those into a rejected promise; a zero reaching
 * startScreencast's maxWidth blanks the stage until the socket is rebuilt.
 */
function clampDim(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), Math.max(min, max));
}

/**
 * The only cursor values allowed out to the dashboard. A computed cursor can be
 * `url("https://attacker/x.png"), pointer`, and the dashboard assigns it to a style property —
 * so an unfiltered value would make the operator's browser fetch a URL of the remote page's
 * choosing, from the dashboard's origin, on hover. Keywords only.
 */
const CURSORS = new Set([
  "auto", "default", "none", "context-menu", "help", "pointer", "progress", "wait", "cell",
  "crosshair", "text", "vertical-text", "alias", "copy", "move", "no-drop", "not-allowed",
  "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize",
  "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize",
  "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out",
]);

export function safeCursor(raw: unknown): string {
  if (typeof raw !== "string") return "default";
  // `url(...), pointer` — the keyword fallback is always last, and it is the only part we want.
  const last = raw.split(",").pop()!.trim().toLowerCase();
  return CURSORS.has(last) ? last : "default";
}

/**
 * A human taking control has the same reach as clicking a link on the page they are already
 * driving, and every http(s) request Chrome makes goes through the egress proxy, which is
 * where the SSRF policy lives. What an address bar would add that clicking cannot is the
 * non-proxied schemes: `file:` reads the container's disk, `javascript:` runs in the current
 * page's origin, `chrome:` and `devtools:` reach browser internals. Those are the escalation,
 * so the scheme is the thing to check.
 */
export function safeNavigationUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 4096) return null;
  if (text === "about:blank") return text;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.toString();
}

/**
 * The most text a paste may carry. The socket's frame cap is 64 KiB and JSON escaping can
 * more than double a string of quotes or newlines, so the limit sits well under it: a paste
 * that overflowed the frame would kill the socket rather than fail visibly.
 */
const PASTE_MAX = 16 * 1024;

/**
 * How the stream degrades when the link cannot keep up. Rungs are ordered best first, and the
 * scale is applied to the encoded frame only — the window keeps the size the operator's stage
 * asked for, so the layout and the aspect ratio never move; only the number of pixels sent
 * does. Measured on a photo-heavy page at 15fps: rung 0 is about 2.2 MB/s and rung 3 about
 * 0.7 MB/s, which is the difference between a stream that judders and one that does not.
 *
 * Resolution is dropped before quality because resolution buys far more: halving the width
 * halved the bitrate, while q70 to q55 saved only about 18%.
 */
const RUNGS = [
  { scale: 1, quality: 70 },
  { scale: 1, quality: 55 },
  { scale: 0.7, quality: 60 },
  { scale: 0.7, quality: 45 },
  { scale: 0.5, quality: 45 },
];
/** Never change rung more often than this. A rung change restarts the screencast, which hitches. */
const RUNG_HOLD_MS = 4000;

/**
 * Clean a pasted string before it is typed into the remote page. Carriage returns go because
 * a CRLF paste would otherwise land as two newlines in a textarea, and the C0 controls go
 * because they are not characters anyone meant to paste. Tab and newline stay: both are real
 * content in a form.
 */
export function cleanPaste(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!text) return null;
  return text.length > PASTE_MAX ? text.slice(0, PASTE_MAX) : text;
}

/**
 * A start page for about:blank. Chrome's own blank tab is a white void, which tells an
 * operator who has just taken over a browser nothing at all — not which browser it is, not
 * that there is now an address bar above it, not how to give the keyboard back.
 *
 * It is injected rather than served: Chrome runs behind the egress proxy with the loopback
 * bypass deliberately removed (chrome.ts), so it cannot reach Tallylamp's own origin, and a
 * data: URL would put a page of base64 in the address bar. The document is removed again when
 * control returns to the agent, so an agent never evaluates against a page it did not expect.
 */
function startPageScript(name: string, project: string, purpose: string): string {
  const html = `<div id="tallylamp-start">
  <div class="tl-card">
    <div class="tl-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <path d="M14.29 3.44a7.4 9 0 0 1 0 17.12"/><path d="M9.71 3.44a7.4 9 0 0 0 0 17.12"/>
        <circle cx="12" cy="12" r="3.3" fill="currentColor" stroke="none"/>
      </svg>
    </div>
    <h1></h1>
    <p class="tl-sub"></p>
    <ul class="tl-tips">
      <li><b>Type an address or a search</b> in the bar above.</li>
      <li>Click the page before you type. That is what puts your keyboard into this browser.</li>
      <li><kbd>Esc</kbd> takes your keyboard back. To send an Esc to the page instead, use <b>Send Esc</b>.</li>
      <li>Paste works. Your clipboard is typed into whatever has focus here.</li>
      <li><b>Return to agent</b> hands the browser back. Closing this tab does the same, on a timer.</li>
    </ul>
  </div>
</div>`;
  const css = `*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  display:grid;place-items:center;padding:2rem;color:#3c3a38;background:#faf9f7}
#tallylamp-start{width:min(560px,100%)}
.tl-card{background:#fff;border:1px solid #e6e3df;border-radius:14px;padding:1.9rem 2rem;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -18px rgba(0,0,0,.35)}
.tl-mark{width:34px;height:34px;color:#d97757;margin-bottom:1rem}
.tl-mark svg{width:100%;height:100%;display:block}
h1{margin:0;font-size:1.35rem;font-weight:600;letter-spacing:-0.01em;color:#22201e}
.tl-sub{margin:.35rem 0 0;color:#6b6660;font-size:.9rem}
.tl-tips{list-style:none;margin:1.5rem 0 0;padding:1.2rem 0 0;border-top:1px solid #efece8;
  display:grid;gap:.6rem;font-size:.875rem;color:#5c5854}
.tl-tips b{color:#22201e;font-weight:600}
kbd{font:inherit;font-size:.8em;border:1px solid #dcd8d3;border-bottom-width:2px;border-radius:5px;
  padding:.05em .4em;background:#f7f5f2;color:#3c3a38}
@media (prefers-color-scheme: dark){
  body{color:#c8c4bf;background:#191818}
  .tl-card{background:#211f1e;border-color:#333130;box-shadow:0 12px 32px -18px rgba(0,0,0,.8)}
  h1{color:#f2efec}.tl-sub{color:#8d8781}.tl-tips{border-top-color:#2e2c2b;color:#a8a29c}
  .tl-tips b{color:#f2efec}
  kbd{background:#2a2827;border-color:#3d3a38;color:#c8c4bf}
}`;
  // Text goes in through textContent, never markup: the browser name and its metadata are
  // operator-supplied strings.
  return `(function () {
  try {
    if (document.getElementById("tallylamp-start")) return "present";
    // An about:blank opened by a page inherits that page's origin and may already hold its
    // content. Only a genuinely empty, unopened document is ours to dress.
    if (window.opener) return "skipped-opener";
    if (document.body.childNodes.length || document.head.childNodes.length) return "skipped-nonempty";
    document.title = ${JSON.stringify(name)};
    var st = document.createElement("style");
    st.id = "tallylamp-start-style";
    st.textContent = ${JSON.stringify(css)};
    document.head.appendChild(st);
    var host = document.createElement("div");
    host.innerHTML = ${JSON.stringify(html)};
    var root = host.firstElementChild;
    root.querySelector("h1").textContent = ${JSON.stringify(name)};
    root.querySelector(".tl-sub").textContent = ${JSON.stringify(purpose || project || "Ready when you are.")};
    document.body.appendChild(root);
    return "injected";
  } catch (e) { return "failed"; }
})()`;
}

const REMOVE_START_PAGE = `(function () {
  var a = document.getElementById("tallylamp-start");
  var b = document.getElementById("tallylamp-start-style");
  if (a) a.remove();
  if (b) b.remove();
  // The title element too, removed rather than emptied: a pristine about:blank has no <title>
  // at all, and leaving one behind is a difference an agent could read back afterwards.
  if (a || b) {
    var t = document.querySelector("title");
    if (t) t.remove();
  }
  return "removed";
})()`;

/**
 * Read the CSS cursor under a point, in an isolated world so the page never sees the probe.
 * Descends into same-origin frames; a cross-origin subframe (a challenge widget, most often)
 * reports the frame element's own cursor, because its DOM lives in another process.
 */
const CURSOR_PROBE = `(function(x, y) {
  let doc = document, cx = x, cy = y, el = null;
  for (let depth = 0; depth < 4; depth++) {
    const hit = doc.elementFromPoint(cx, cy);
    if (!hit) break;
    el = hit;
    if (hit.tagName !== "IFRAME" && hit.tagName !== "FRAME") break;
    let inner = null;
    try { inner = hit.contentDocument; } catch { inner = null; }
    if (!inner) break;
    const r = hit.getBoundingClientRect();
    doc = inner; cx = cx - r.left; cy = cy - r.top;
  }
  if (!el) return "default";
  const c = getComputedStyle(el).cursor || "default";
  return c.length > 200 ? "default" : c;
})`;

async function runViewer(
  ws: WebSocket,
  _req: IncomingMessage,
  browsers: BrowserManager,
  browserId: string,
  mode: "watch" | "control",
) {
  let cdp: CdpClient | null = null;
  // The CDP session string for the tab being streamed. Distinct from a screencast frame's
  // numeric ack id, which the old code also called `sessionId` four lines apart.
  let pageSession: string | undefined;
  let windowId: number | undefined;
  // The window we actually resized. Never cleared by a tab switch: the switch invalidates the
  // *cache* of which window the current tab is in, but the window we owe a restore to is still
  // that one — and a tab in a second window would otherwise strand the first one resized.
  let resizedWindowId: number | undefined;
  let contentsSizeOk = true;
  // Bumped on every attach. A frame or a deferred send carrying a stale epoch is dropped, so
  // the tab you switched away from cannot paint over the one you switched to.
  let epoch = 0;
  const timers = new Set<NodeJS.Timeout>();
  const targets = new Map<string, TargetRow>();
  let activeTargetId: string | undefined;
  // Which human lease this socket was opened under. Checked on every mutating message so a
  // second admin taking the browser cuts the first one's socket off, as the UI already claims.
  let boundLease: string | null = null;
  // What we last asked Chrome to make the content area. Also the screencast clamp: leave the
  // clamp behind and every click is scaled by the ratio, silently.
  let content = { ...config.viewerSize };
  let want: { w: number; h: number } | null = null;
  let sizeTimer: NodeJS.Timeout | undefined;
  let lastApplyAt = 0;
  let lastGrowAt = 0;
  let switching = false;
  // Which targets carry the injected start page. A boolean was not enough: switching tabs left
  // a copy behind on every tab it had ever dressed, and only the last one was ever cleaned.
  const startPageTargets = new Set<string>();
  // Targets already sent to Target.closeTarget. `targets` is only pruned when Chrome answers,
  // so without this two closes in one batch both see two tabs and shut the browser down.
  const closing = new Set<string>();
  let tabTimer: NodeJS.Timeout | undefined;
  let tabTokens = 10;
  let tabLast = Date.now();
  let cursorWorld: number | undefined;
  let cursorBusy = false;
  let lastCursorAt = 0;
  let lastCursor = "";
  let released: ((ev: unknown) => void) | undefined;
  // Resolved once Chrome is known to be up: screenSize() falls back to the configured window
  // size for a browser with no runtime, and reading it before cdpWs() — which is what starts
  // Chrome — pinned the resize ceiling to 1280x800 instead of the real X screen.
  let screen = { ...config.viewerSize };
  let attachedViewer = false;
  let closed = false;
  let ready = false;
  /** Liveness probe. Declared here so teardown can stop it from anywhere in setup. */
  let pinger: NodeJS.Timeout | undefined;
  const inbox: Array<{ type: string; [k: string]: unknown }> = [];
  let handle: ((msg: { type: string; [k: string]: unknown }) => void) | null = null;

  const noop = () => undefined;
  const track = (t: NodeJS.Timeout): NodeJS.Timeout => {
    t.unref?.();
    timers.add(t);
    return t;
  };
  const send = (payload: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  // Assigned once setup gets far enough to have injected anything. teardown() runs before
  // those closures exist, so it reaches them through this.
  let cleanupPage: (() => Promise<void>) | null = null;

  /** Idempotent, and safe to run at any point in setup — including before it finished. */
  const teardown = (code?: number): void => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clearInterval(pinger);
    if (released) {
      hub.off(`browser:${browserId}`, released);
      released = undefined;
    }
    if (attachedViewer) {
      attachedViewer = false;
      browsers.detachViewer(browserId);
    }
    // 1000 is the dashboard closing this socket on purpose: the operator left the detail view
    // for the fleet list, or navigated away entirely. 1001 is the browser doing it for an
    // unload that never got to run our handler. Either way the human is gone, so hand the
    // browser back now rather than making the agent sit out the rest of the lease. Every other
    // code -- a dropped link, a slept laptop, a killed tab -- is transient and reconnects, so
    // those are left to the lease TTL, which is the thing that already resolves them.
    if (mode === "control" && boundLease && (code === 1000 || code === 1001)) {
      const cur = browsers.controlState(browserId);
      if (cur.controllerType === "human" && cur.leaseToken === boundLease) {
        log.info("viewer left; handing control back", { browserId, code });
        browsers.releaseControl(browserId);
      }
    }
    const sid = pageSession;
    epoch += 1;
    void (async () => {
      // Before the session goes. Losing the socket is not the same as handing control back,
      // and only the hand-back path used to clean up — so closing the dashboard tab left
      // Tallylamp's own copy sitting in the agent's browser until something navigated.
      if (cleanupPage) await cleanupPage().catch(noop);
      pageSession = undefined;
      if (sid) {
        await cdp?.send("Page.stopScreencast", {}, sid).catch(noop);
        await cdp?.send("Target.detachFromTarget", { sessionId: sid }).catch(noop);
      }
      await cdp?.close();
    })();
  };

  // Registered BEFORE the first await, all three of them. The dashboard sends its heartbeat,
  // its viewport request and its tab selection synchronously in the socket's `open` handler,
  // and ws does not buffer: a frame that arrives with no "message" listener is discarded. With
  // the listeners installed after setup, the lease binding never happened (so every later
  // action was refused as "lease expired") and the 1:1 resize request was simply lost. Close
  // had the same shape: a socket that dropped during setup leaked its viewer count, its hub
  // listener and its CDP connection for the life of the process.
  ws.on("message", (raw) => {
    if (closed) return;
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!ready) {
      // Bounded: a client that floods before setup finishes must not grow the process.
      if (inbox.length < 64) inbox.push(msg);
      return;
    }
    handle?.(msg);
  });
  ws.on("error", noop); // 'close' fires next and owns the teardown
  ws.on("close", (code: number) => teardown(code));

  // TCP will not tell us the far end is gone: a slept laptop or a hard-killed tab leaves a
  // half-open socket that never fires 'close', so the viewer count stayed at 1 for the life of
  // the process and the browser kept the long attached TTL with nobody watching. Asking is the
  // only way to find out. Two unanswered pings and the socket is terminated, which fires
  // 'close' and lets the normal teardown run.
  let awaitingPong = false;
  ws.on("pong", () => {
    awaitingPong = false;
  });
  pinger = setInterval(() => {
    if (awaitingPong) {
      log.info("viewer socket stopped answering; terminating", { browserId });
      ws.terminate();
      return;
    }
    awaitingPong = true;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }, config.viewerPingMs);
  // A stray probe must never be the reason a test process refuses to exit.
  pinger.unref?.();

  try {
    const wsUrl = await browsers.cdpWs(browserId);
    if (closed) return;
    screen = browsers.screenSize(browserId);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();
    if (closed) {
      await cdp.close();
      return;
    }

    // Kept only as the belt-and-braces ceiling for a socket that has stopped draining entirely.
    // With one frame in flight the app-level queue is a single frame, so this should never be
    // reached; it exists so a wedged connection still cannot grow the process.
    const highWater = config.viewerHighWaterBytes;
    const minFrameMs = mode === "control" ? config.viewerControlMinFrameMs : config.viewerWatchMinFrameMs;
    const baseQuality = mode === "control" ? config.viewerControlQuality : config.viewerWatchQuality;
    const everyNth = mode === "control" ? 1 : config.viewerWatchEveryNthFrame;
    const congested = config.viewerCongestedBytes;
    let lastSentAt = 0;
    // Watch mode is a picture and already runs at half rate; only control adapts, because only
    // control is a surface someone is trying to work on.
    let rung = 0;
    let rungChangedAt = 0;
    let tight = 0;
    let easy = 0;
    let sentMeta = { w: 0, h: 0 };
    /** Smoothed time to write one frame to the socket. The congestion signal. */
    let drainEwma = 0;
    let settleTimer: NodeJS.Timeout | undefined;
    let refined = false;
    /** Set false the first time webp is refused, so an older Chromium falls back once. */
    let webpOk = true;
    let lastFrameBytes = 0;
    /** Frames superseded before they could be sent. Only useful as a diagnostic. */
    let dropped = 0;
    /** When an input was last dispatched, so the next frame can report the round trip. */
    let lastInputAt = 0;

    /**
     * Frame delivery. Chrome will not emit the next screencast frame until the previous one is
     * acked, so the ack is not really an acknowledgement — it is the request for the next
     * picture, and when it is sent is what sets both the frame rate and the freshness.
     *
     * The previous version got this backwards in two ways. It scheduled a timer per frame and,
     * when it fired, sent the bytes it had captured earlier while still withholding the ack —
     * so it put a stale picture on the wire and simultaneously forbade Chrome from making a
     * fresh one. And because Chrome allows three unacked frames, three of those timers could
     * be outstanding at once: measured, the picture was routinely ~130 ms old before it
     * reached the socket, on top of a 2 MiB socket queue that is ~950 ms of video at rung 0.
     *
     * The discipline now: hold at most one undelivered frame and let a newer one replace it,
     * write one frame at a time, and pay every ack — the sent one and the superseded ones —
     * only once that write has completed. Superseded bytes are dropped rather than sent. That
     * makes the socket's own drain the pacer, so Chrome produces exactly as fast as the link
     * can carry, and whatever is on the wire is always the newest frame that existed.
     *
     * `ackId` is the frame's numeric id and `frameSession` the CDP session it came from. Acks
     * go back on that session, not on whatever is attached by the time the write finishes —
     * during a tab switch those differ.
     */
    type Frame = { buf: Buffer; w: number; h: number; ackId?: number; session: string; epoch: number };
    let pending: Frame | null = null;
    let writing = false;
    let flushTimer: NodeJS.Timeout | undefined;
    /** Acks owed to Chrome for frames we dropped. Paid on the same cycle as the sent one, so
     *  Chrome's three-frame window throttles it to our drain rate instead of running free. */
    const owed: Array<{ id: number; session: string }> = [];

    const ackFrame = (id: number | undefined, session: string): void => {
      if (id === undefined) return;
      void cdp?.send("Page.screencastFrameAck", { sessionId: id }, session).catch(noop);
    };

    const payOwed = (): void => {
      while (owed.length) {
        const o = owed.pop()!;
        ackFrame(o.id, o.session);
      }
    };

    const flush = (): void => {
      if (flushTimer) {
        timers.delete(flushTimer);
        flushTimer = undefined;
      }
      if (writing || !pending || ws.readyState !== ws.OPEN) return;
      const wait = minFrameMs - (Date.now() - lastSentAt);
      if (wait > 0) {
        flushTimer = track(setTimeout(flush, wait));
        return;
      }
      const f = pending;
      pending = null;
      if (f.epoch !== epoch || f.session !== pageSession) {
        // The tab changed under us. Still owe Chrome the ack, or its window never reopens.
        ackFrame(f.ackId, f.session);
        payOwed();
        return;
      }
      writing = true;
      lastSentAt = Date.now();
      const startedAt = lastSentAt;
      // The number that actually describes what an operator feels, and the one nothing here
      // used to record: how long after a click or a keystroke the first frame carrying its
      // consequence reaches the wire. Frames-per-second and bytes-per-second say nothing
      // about it.
      if (lastInputAt) {
        log.debug("viewer input to frame", {
          browserId,
          ms: startedAt - lastInputAt,
          rung,
          dropped,
          drainMs: Math.round(drainEwma),
          bytes: lastFrameBytes,
        });
        lastInputAt = 0;
      }
      // The frame's own size, sent only when it changes rather than on every frame. The client
      // maps clicks through it, so it has to be right, but it moves only on a resize.
      if (f.w !== sentMeta.w || f.h !== sentMeta.h) {
        sentMeta = { w: f.w, h: f.h };
        send({ type: "frameMeta", width: f.w, height: f.h });
      }
      // Binary, not base64 in JSON. Base64 is a flat third more bytes and makes the client
      // JSON.parse a 190 KB string fifteen times a second.
      ws.send(f.buf, { binary: true }, () => {
        writing = false;
        // How long that frame took to drain is the honest congestion signal: it is measured on
        // every frame, it is in time rather than bytes so it does not change meaning as the
        // picture gets smaller, and unlike bufferedAmount it cannot go blind while congested.
        sampleDrain(Date.now() - startedAt, f.buf.length);
        ackFrame(f.ackId, f.session);
        payOwed();
        flush();
      });
    };

    /**
     * Send one high-quality still once the page stops changing.
     *
     * The capture is damage-driven, so "no screencast frame for a moment" is an exact, free
     * signal that the page has settled — and a settled page is the only time anyone reads the
     * text on it. Nobody reads while scrolling, so the moving picture can afford to be coarse
     * as long as the still one that follows is sharp. This is the old thin-client trick of
     * building to a better image once the motion stops.
     *
     * WebP because it is both smaller and better here: measured against the same page,
     * webp q90 came in under jpeg q70 while looking considerably better. It costs roughly
     * 16 ms more to encode per frame, which is why it is spent once per settle and never on
     * the stream itself. Chrome's screencast enum still advertises only jpeg and png, but
     * captureScreenshot accepts webp; the fallback covers builds where it does not.
     */
    const refine = async (): Promise<void> => {
      if (mode !== "control" || refined || !cdp || !pageSession) return;
      if (writing || pending) return;
      const sid = pageSession;
      const my = epoch;
      refined = true;
      try {
        let shot: { data?: string } | undefined;
        if (webpOk) {
          shot = (await cdp.send("Page.captureScreenshot", { format: "webp", quality: 90 }, sid).catch(() => {
            webpOk = false;
            return undefined;
          })) as { data?: string } | undefined;
        }
        if (!shot?.data) {
          shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }, sid)) as { data?: string };
        }
        if (!shot?.data || my !== epoch || pageSession !== sid || ws.readyState !== ws.OPEN) return;
        // Straight out, not through the pump: it is not a screencast frame, it owes Chrome no
        // ack, and it must not be superseded by the stream it is improving on.
        ws.send(Buffer.from(shot.data, "base64"), { binary: true });
      } catch (e) {
        log.debug("viewer refine failed", { error: (e as Error).message });
      }
    };

    const armSettle = (): void => {
      refined = false;
      if (settleTimer) {
        clearTimeout(settleTimer);
        timers.delete(settleTimer);
      }
      settleTimer = track(
        setTimeout(() => {
          timers.delete(settleTimer!);
          settleTimer = undefined;
          void refine();
        }, 260),
      );
    };

    const pump = (
      data: string,
      metadata: unknown,
      ackId: number | undefined,
      frameSession: string,
      myEpoch: number,
    ): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (myEpoch !== epoch || frameSession !== pageSession) return;
      const md = metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
      // A newer frame makes the one we are holding worthless. Drop its bytes, but remember the
      // ack: skipping it would consume one of Chrome's three slots permanently.
      if (pending) {
        if (pending.ackId !== undefined) owed.push({ id: pending.ackId, session: pending.session });
        dropped += 1;
      }
      armSettle();
      pending = {
        buf: Buffer.from(data, "base64"),
        w: Math.round(md?.deviceWidth ?? content.width),
        h: Math.round(md?.deviceHeight ?? content.height),
        ackId,
        session: frameSession,
        epoch: myEpoch,
      };
      flush();
    };

    /**
     * Shed bitrate before the picture starts stuttering. The signal is how long a frame takes
     * to drain, compared with the frame interval we are trying to hold: if a single frame
     * cannot be written in the time between frames, no amount of pacing will make the stream
     * smooth and the only remedy is fewer bytes.
     *
     * Asymmetric on purpose, as delay-based congestion control has been since GCC: step down
     * quickly on evidence, climb back slowly, so one slow moment does not visibly degrade the
     * picture and one quiet moment does not immediately undo the protection.
     */
    const sampleDrain = (drainMs: number, bytes: number): void => {
      if (mode !== "control") return;
      // Smoothed, or a single scheduling hiccup reads as congestion.
      drainEwma = drainEwma === 0 ? drainMs : drainEwma * 0.7 + drainMs * 0.3;
      lastFrameBytes = bytes;
      if (drainEwma > minFrameMs * 1.3) {
        tight += 1;
        easy = 0;
      } else if (drainEwma < minFrameMs * 0.5) {
        easy += 1;
        tight = 0;
      }
      if (Date.now() - rungChangedAt < RUNG_HOLD_MS) return;
      if (tight >= 3 && rung < RUNGS.length - 1) stepRung(rung + 1);
      else if (easy >= 30 && rung > 0) stepRung(rung - 1);
    };

    const stepRung = (next: number): void => {
      const before = RUNGS[rung]!;
      const after = RUNGS[next]!;
      rung = next;
      rungChangedAt = Date.now();
      tight = 0;
      easy = 0;
      drainEwma = 0;
      const sid = pageSession;
      if (!sid) return;
      log.debug("viewer stream rung", { browserId, rung, ...after, drainEwma: Math.round(drainEwma) });
      // A geometry change re-creates the capture surface and blanks the stage for a beat; a
      // quality-only change does not. The ladder is ordered so most steps are quality-only.
      void startCast(sid, before.scale !== after.scale).catch((e) =>
        log.warn("viewer rung change failed", { error: (e as Error).message }),
      );
    };

    /**
     * `geometryChanged` is informational: Chrome re-creates the capture surface either way, but
     * only a size change is visible as a blank beat, and knowing which is which is what makes
     * the quality-only rungs worth having.
     */
    const startCast = async (sid: string, geometryChanged = true): Promise<void> => {
      const r = mode === "control" ? RUNGS[rung]! : { scale: 1, quality: baseQuality };
      void geometryChanged;
      // A hard ceiling as well as the rung, so a very large stage does not start out at a
      // bitrate no link would carry and only find its level after several step-downs.
      const ceiling = Math.min(content.width, config.viewerMaxEncodedWidth);
      const width = Math.max(320, Math.round(Math.min(content.width * r.scale, ceiling)));
      const height = Math.max(240, Math.round(content.height * (width / content.width)));
      await cdp!.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: mode === "control" ? r.quality : baseQuality,
          everyNthFrame: everyNth,
          maxWidth: width,
          maxHeight: height,
        },
        sid,
      );
    };

    /**
     * Page.startScreencast only emits on a compositor update, so a page that is not
     * repainting (an error page, a finished render) leaves the viewer blank — sometimes for
     * tens of seconds. Push one screenshot right away so the viewer paints on connect.
     */
    const primeFrame = async (sid: string, myEpoch: number): Promise<void> => {
      try {
        const shot = (await cdp!.send("Page.captureScreenshot", { format: "jpeg", quality: baseQuality }, sid)) as { data: string };
        if (shot?.data && myEpoch === epoch && ws.readyState === ws.OPEN) {
          // Stamped with the size we believe the content to be, so the client never has to map
          // a click against a frame whose dimensions it cannot know. Same binary path as every
          // other frame, so the client has one way of receiving a picture.
          sentMeta = { w: content.width, h: content.height };
          send({ type: "frameMeta", width: content.width, height: content.height });
          ws.send(Buffer.from(shot.data, "base64"), { binary: true });
        }
      } catch (e) {
        log.warn("viewer initial frame failed", { error: (e as Error).message });
      }
    };

    const projectTabs = (): Array<{ targetId: string; title: string; url: string }> =>
      [...targets.values()]
        .filter(isTab)
        .slice(0, 50)
        .map((t) => ({
          targetId: t.targetId,
          title: String(t.title ?? "").slice(0, 120),
          url: String(t.url ?? "").slice(0, 200),
        }));

    // targetInfoChanged fires on every document.title write, so a loading page would otherwise
    // push a tab list per keystroke of a progressive title.
    const pushTabs = (): void => {
      if (tabTimer) return;
      tabTimer = track(
        setTimeout(() => {
          timers.delete(tabTimer!);
          tabTimer = undefined;
          send({ type: "tabs", tabs: projectTabs(), activeTargetId });
        }, 150),
      );
    };

    /** Does this socket currently hold the human lease it bound itself to? */
    const holdsLease = (): boolean => {
      if (mode !== "control" || !boundLease) return false;
      const lease = browsers.controlState(browserId);
      return lease.controllerType === "human" && lease.leaseToken === boundLease;
    };

    /**
     * Dress an empty tab, and only an empty tab. Anything the agent navigated to owns its own
     * document. Control mode only: the agent cannot evaluate against the page while a human
     * holds the lease (evaluate_script is a mutating tool), so this is never something an
     * agent trips over mid-action, and it is undone when control goes back.
     */
    const showStartPage = async (sid: string, targetId: string, url: string | undefined): Promise<void> => {
      // The mode is fixed for the life of the socket; the lease is not. Without this an
      // expired lease still let a refollow or a reconnect write into the agent's page.
      if (!holdsLease() || url !== "about:blank") return;
      let name = browserId;
      let project = "";
      let purpose = "";
      try {
        const row = browsers.row(browserId);
        const md = JSON.parse(row.metadata_json || "{}") as { project?: string; purpose?: string };
        name = row.name || browserId;
        project = String(md.project ?? "");
        purpose = String(md.purpose ?? "");
      } catch {
        /* a browser with no row still deserves a start page */
      }
      try {
        await cdp!.send(
          "Runtime.evaluate",
          { expression: startPageScript(name, project, purpose), returnByValue: true },
          sid,
        );
        startPageTargets.add(targetId);
        // The document only paints on a compositor update, and an about:blank tab has nothing
        // else coming, so push the frame ourselves.
        await primeFrame(sid, epoch);
      } catch (e) {
        log.warn("viewer start page failed", { error: (e as Error).message });
      }
    };

    /**
     * Dress the tab we are on, if it is still blank and not already dressed. Called when the
     * lease binds, not from attach(): attach() runs during socket setup, before any message —
     * including the heartbeat that binds the lease — has been read, so gating the injection on
     * the lease meant the tab you actually land on was never dressed.
     */
    const dressActiveTab = async (): Promise<void> => {
      if (!pageSession || !activeTargetId || startPageTargets.has(activeTargetId)) return;
      await showStartPage(pageSession, activeTargetId, targets.get(activeTargetId)?.url);
    };

    /**
     * Strip the start page from one tab. Idempotent and safe on a tab that has since navigated
     * — the removal script simply finds nothing — so it is always worth attempting rather than
     * tracking whether a navigation actually committed.
     */
    const hideStartPage = async (sid: string | undefined, targetId: string | undefined): Promise<void> => {
      if (!cdp || !sid || !targetId || !startPageTargets.has(targetId)) return;
      startPageTargets.delete(targetId);
      await cdp
        .send("Runtime.evaluate", { expression: REMOVE_START_PAGE, returnByValue: true }, sid)
        .catch(noop);
    };

    /** Attach to a page target and make it the streamed one. Used for connect and for switching. */
    const attach = async (targetId: string): Promise<void> => {
      epoch += 1;
      const my = epoch;
      const previous = pageSession;
      const previousTargetId = activeTargetId;
      if (previous) {
        // Before the session goes: it is the only handle we have on that tab's document.
        await hideStartPage(previous, previousTargetId);
        await cdp!.send("Page.stopScreencast", {}, previous).catch(noop);
        await cdp!.send("Target.detachFromTarget", { sessionId: previous }).catch(noop);
      }
      pageSession = undefined;
      activeTargetId = undefined;
      let sid: string;
      try {
        ({ sessionId: sid } = (await cdp!.send("Target.attachToTarget", { targetId, flatten: true })) as {
          sessionId: string;
        });
      } catch (e) {
        // The old session is already gone, so failing here would leave the viewer with no
        // session at all and no frames forever. Fall back to any other tab we know of.
        log.warn("viewer attach failed", { targetId, error: (e as Error).message });
        if (my !== epoch) return;
        const fallback = projectTabs().find((t) => t.targetId !== targetId && t.targetId !== previousTargetId);
        pushTabs();
        if (fallback) await attach(fallback.targetId);
        return;
      }
      if (my !== epoch) {
        void cdp!.send("Target.detachFromTarget", { sessionId: sid }).catch(noop);
        return;
      }
      pageSession = sid;
      activeTargetId = targetId;
      // The cached windowId belongs to the old session. `resizedWindowId` deliberately does not
      // move: it is the window we owe a restore to.
      windowId = undefined;
      cursorWorld = undefined;
      await cdp!.send("Page.enable", {}, sid);
      await cdp!.send("Input.setIgnoreInputEvents", { ignore: mode !== "control" }, sid).catch(noop);
      await startCast(sid);
      await primeFrame(sid, my);
      pushTabs();
      await showStartPage(sid, targetId, targets.get(targetId)?.url);
    };

    /**
     * The agent can resize the page out from under us with resize_page, and our clamp would
     * then crop every frame while the client kept mapping clicks against the cropped width.
     * Frame metadata is the true viewport, so let it correct the clamp.
     */
    const growClamp = (w: number, h: number): void => {
      const now = Date.now();
      if (now - lastGrowAt < 2000 || !pageSession) return;
      lastGrowAt = now;
      content = { width: Math.min(w, screen.width), height: Math.min(h, screen.height) };
      const sid = pageSession;
      void startCast(sid).catch((e) => log.warn("viewer clamp resync failed", { error: (e as Error).message }));
    };

    const upsert = (info: TargetRow | undefined): void => {
      if (!info || info.type !== "page") return;
      targets.set(info.targetId, info);
      pushTabs();
    };

    cdp.onEvent = (method, params, evSession) => {
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
        upsert(params.targetInfo as TargetRow | undefined);
        return;
      }
      if (method === "Target.targetDestroyed") {
        const gone = params.targetId as string;
        targets.delete(gone);
        closing.delete(gone);
        startPageTargets.delete(gone);
        if (gone === activeTargetId) {
          // The agent closed the tab we were streaming. Follow it to another rather than
          // freezing on the last frame of a page that no longer exists.
          const next = projectTabs()[0];
          activeTargetId = undefined;
          if (next) void attach(next.targetId).catch((e) => log.warn("viewer refollow failed", { error: (e as Error).message }));
        }
        pushTabs();
        return;
      }
      if (method !== "Page.screencastFrame") return;
      // fake-chrome emits frames with no envelope session, so undefined must pass.
      if (evSession !== undefined && evSession !== pageSession) return;
      if (!pageSession) return;
      const md = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
      if (md?.deviceWidth && md?.deviceHeight && (md.deviceWidth > content.width || md.deviceHeight > content.height)) {
        growClamp(md.deviceWidth, md.deviceHeight);
      }
      pump(params.data as string, params.metadata, params.sessionId as number | undefined, pageSession, epoch);
    };

    // Discovery first, with the handler already installed: getTargets alone loses anything
    // created between the call and the subscription, and setDiscoverTargets synthesizes
    // targetCreated for everything that already exists, so the merge below is idempotent.
    await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(noop);
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: TargetRow[] };
    for (const t of targetInfos) if (t.type === "page") targets.set(t.targetId, t);
    if (closed) {
      await cdp.close();
      return;
    }

    const tabs = projectTabs();
    if (!tabs.length) throw new Error("no page");
    // Chrome is launched with about:blank as the startup tab, so the first page target is the
    // blank one for the whole life of a browser whose agent opened its work in a new tab.
    // Prefer the newest tab that has actually gone somewhere.
    const real = tabs.filter((t) => t.url && t.url !== "about:blank");
    await attach((real.length ? real[real.length - 1] : tabs[0]).targetId);

    send({ type: "hello", mode, browserId, screen, content });
    send({ type: "tabs", tabs: projectTabs(), activeTargetId });

    if (closed) {
      await cdp.close();
      return;
    }
    browsers.attachViewer(browserId);
    attachedViewer = true;
    browsers.touch(browserId);

    /** Push the achieved size, so the client letterboxes honestly when a request was clamped. */
    const echoViewport = (): void => send({ type: "viewport", width: content.width, height: content.height });

    const applySize = async (): Promise<void> => {
      if (sizeTimer) {
        timers.delete(sizeTimer);
        sizeTimer = undefined;
      }
      const w = want;
      want = null;
      if (!w || !cdp || !pageSession) return;
      if (!contentsSizeOk) {
        echoViewport();
        return;
      }
      // A dead band wider than a scrollbar: fractional layout means the request is never
      // exactly equal to what was granted, and chasing the last pixel is how this oscillates.
      if (Math.abs(w.w - content.width) < 8 && Math.abs(w.h - content.height) < 8) {
        echoViewport();
        return;
      }
      const since = Date.now() - lastApplyAt;
      if (since < 500) {
        want = w;
        sizeTimer = track(setTimeout(() => void applySize(), 500 - since));
        return;
      }
      lastApplyAt = Date.now();
      const sid = pageSession;
      try {
        if (windowId === undefined) {
          const got = (await cdp.send("Browser.getWindowForTarget", {}, sid)) as {
            windowId: number;
            bounds?: { windowState?: string };
          };
          windowId = got.windowId;
          // A maximised or fullscreen window refuses to be resized; the agent's own
          // resize_page normalises the same way before it asks.
          if (got.bounds?.windowState && got.bounds.windowState !== "normal") {
            await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }, sid).catch(noop);
          }
        }
        // setContentsSize takes the CONTENT size in DIP and lets Chrome work out the tab strip
        // and omnibox overhead itself. Measuring that delta by hand is contaminated by
        // scrollbars, and Emulation.setDeviceMetricsOverride would change the fingerprint of a
        // browser that is very often sitting on a bot challenge.
        await cdp.send("Browser.setContentsSize", { windowId, width: w.w, height: w.h }, sid);
        resizedWindowId = windowId;
        content = { width: w.w, height: w.h };
        browsers.setWindowContent(browserId, content);
        if (pageSession === sid) await startCast(sid);
      } catch (e) {
        // Feature-detect once and stay letterboxed. Older Chromium builds — the arm64 image
        // installs Debian chromium — may not carry setContentsSize.
        contentsSizeOk = false;
        log.warn("viewer resize unsupported", { error: (e as Error).message });
      }
      echoViewport();
    };

    /**
     * Put the window back the way Chrome launched it. The outer bounds are the thing we
     * actually know — they are the --window-size launch argument — whereas the content size at
     * launch was never measured, so restoring through setContentsSize would be a guess.
     */
    const restore = async (): Promise<void> => {
      if (!browsers.windowContent(browserId) || resizedWindowId === undefined || !cdp || !pageSession) return;
      const launch = parseSize(config.windowSize, { width: 1280, height: 800 });
      const sid = pageSession;
      try {
        await cdp.send(
          "Browser.setWindowBounds",
          { windowId: resizedWindowId, bounds: { width: launch.width, height: launch.height } },
          sid,
        );
        browsers.setWindowContent(browserId, null);
        content = { ...config.viewerSize };
        if (pageSession === sid) await startCast(sid);
        echoViewport();
      } catch (e) {
        log.warn("viewer restore failed", { error: (e as Error).message });
      }
    };

    // Restore is bound to the lease ending, not to this socket closing: the socket drops and
    // reconnects six times on a flaky network, and a counted viewer list means two dashboards
    // would each hold their own idea of "original".
    cleanupPage = async () => {
      await hideStartPage(pageSession, activeTargetId);
    };

    released = (ev) => {
      if ((ev as { type?: string }).type !== "control.released") return;
      void hideStartPage(pageSession, activeTargetId);
      void restore();
    };
    hub.on(`browser:${browserId}`, released);

    const probeCursor = (x: number, y: number): void => {
      if (cursorBusy || !pageSession) return;
      const now = Date.now();
      if (now - lastCursorAt < 80) return;
      lastCursorAt = now;
      cursorBusy = true;
      const sid = pageSession;
      void (async () => {
        try {
          if (cursorWorld === undefined) {
            const { frameTree } = (await cdp!.send("Page.getFrameTree", {}, sid)) as {
              frameTree: { frame: { id: string } };
            };
            const { executionContextId } = (await cdp!.send(
              "Page.createIsolatedWorld",
              { frameId: frameTree.frame.id, worldName: "tallylamp-viewer", grantUniveralAccess: false },
              sid,
            )) as { executionContextId: number };
            cursorWorld = executionContextId;
          }
          const res = (await cdp!.send(
            "Runtime.callFunctionOn",
            {
              functionDeclaration: CURSOR_PROBE,
              executionContextId: cursorWorld,
              arguments: [{ value: x }, { value: y }],
              returnByValue: true,
            },
            sid,
          )) as { result?: { value?: string } };
          const cursor = safeCursor(res.result?.value);
          if (cursor !== lastCursor && pageSession === sid) {
            lastCursor = cursor;
            send({ type: "cursor", cursor });
          }
        } catch {
          // A navigation destroys the world; drop it and let the next move rebuild one.
          cursorWorld = undefined;
        } finally {
          cursorBusy = false;
        }
      })();
    };

    handle = (msg) => {
      // Only a control socket's traffic counts as a human saying "I am still looking at this".
      // A watch tab heartbeats on a timer whether or not anyone is in front of it, so touching
      // for every socket reset last_activity_at forever, and with attachedIdleTtlMs layered on
      // top a forgotten tab pinned ~1 GB of Chrome for the life of the process. Watching still
      // registers as attachment, so the browser keeps the long TTL -- it just counts from the
      // last real activity rather than from now.
      if (mode === "control") browsers.touch(browserId);
      if (msg.type === "heartbeat" && mode === "control" && typeof msg.leaseToken === "string") {
        try {
          browsers.heartbeatControl(browserId, msg.leaseToken);
          const firstBind = !boundLease;
          boundLease = msg.leaseToken;
          // The client heartbeats on open and every 15s after. Only the first one can have
          // anything to do; dressActiveTab is a no-op once the tab is dressed or has navigated.
          if (firstBind) void dressActiveTab().catch(noop);
        } catch {
          send({ type: "error", message: "lease expired" });
        }
        return;
      }
      if (mode !== "control") return;
      const lease = browsers.controlState(browserId);
      if (lease.controllerType !== "human") return;
      // The old gate asked only whether *a* human held the lease, so a socket opened by admin A
      // kept driving after admin B took the browser off them.
      if (!boundLease || lease.leaseToken !== boundLease) {
        send({ type: "error", message: "lease expired" });
        return;
      }
      // A local token bucket, deliberately not rate-limit.ts: that one signals by throwing an
      // HTTP-shaped error, and a synchronous throw inside a ws message handler with no
      // uncaughtException handler installed takes the process down. Shared by every message
      // that opens, closes, switches or navigates a tab.
      const spendToken = (): boolean => {
        const now = Date.now();
        tabTokens = Math.min(10, tabTokens + (now - tabLast) / 1000);
        tabLast = now;
        if (tabTokens < 1) return false;
        tabTokens -= 1;
        return true;
      };
      if (msg.type === "mouse") {
        if (msg.event !== "mouseMoved") lastInputAt = Date.now();
        void cdp!
          .send(
            "Input.dispatchMouseEvent",
            {
              type: msg.event ?? "mousePressed",
              x: msg.x,
              y: msg.y,
              button: msg.button ?? "left",
              clickCount: msg.clickCount ?? 1,
              modifiers: typeof msg.modifiers === "number" ? msg.modifiers : undefined,
            },
            pageSession,
          )
          .catch(noop);
        // The remote cursor shape is the only feedback that says "this is a link". Without it
        // the operator cannot tell a mis-aimed click from a dead one.
        if (msg.event === "mouseMoved" && typeof msg.x === "number" && typeof msg.y === "number") {
          probeCursor(msg.x, msg.y);
        }
        return;
      }
      if (msg.type === "key") {
        lastInputAt = Date.now();
        void cdp!
          .send(
            "Input.dispatchKeyEvent",
            {
              type: msg.event ?? "keyDown",
              key: msg.key,
              code: msg.code,
              text: msg.text,
              unmodifiedText: msg.text,
              // Chrome ignores a key with no text unless it carries a virtual key code, which is
              // why Enter, Tab, Backspace and the arrows used to do nothing in the remote page.
              windowsVirtualKeyCode: typeof msg.windowsVirtualKeyCode === "number" ? msg.windowsVirtualKeyCode : undefined,
              nativeVirtualKeyCode: typeof msg.windowsVirtualKeyCode === "number" ? msg.windowsVirtualKeyCode : undefined,
              location: typeof msg.location === "number" ? msg.location : undefined,
              isKeypad: msg.isKeypad === true ? true : undefined,
              modifiers: typeof msg.modifiers === "number" ? msg.modifiers : undefined,
            },
            pageSession,
          )
          .catch(noop);
        return;
      }
      if (msg.type === "paste") {
        const text = cleanPaste(msg.text);
        if (!text || !pageSession || !spendToken()) return;
        // Input.insertText, not a synthetic Ctrl+V: the remote Chrome's clipboard is its own
        // and holds nothing of the operator's. This types the text into whatever has focus,
        // which is what a paste is for here. It does not fire a `paste` event in the page, so
        // an editor that listens for one specifically will not see it.
        void cdp!
          .send("Input.insertText", { text }, pageSession)
          .catch((e) => log.warn("viewer paste failed", { error: (e as Error).message }));
        return;
      }
      if (msg.type === "scroll") {
        lastInputAt = Date.now();
        void cdp!
          .send(
            "Input.dispatchMouseEvent",
            { type: "mouseWheel", x: msg.x ?? 0, y: msg.y ?? 0, deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 },
            pageSession,
          )
          .catch(noop);
        return;
      }
      if (msg.type === "navigate") {
        const url = safeNavigationUrl(msg.url);
        if (!url) {
          send({ type: "notice", message: "Only http and https addresses can be opened from here." });
          return;
        }
        if (!pageSession || !spendToken()) return;
        void cdp!
          .send("Page.navigate", { url }, pageSession)
          .catch((e) => log.warn("viewer navigate failed", { error: (e as Error).message }));
        return;
      }
      if (msg.type === "reload") {
        if (!pageSession || !spendToken()) return;
        void cdp!.send("Page.reload", {}, pageSession).catch(noop);
        return;
      }
      if (msg.type === "historyGo") {
        const delta = msg.delta === 1 ? 1 : msg.delta === -1 ? -1 : 0;
        if (!delta || !pageSession || !spendToken()) return;
        const sid = pageSession;
        void (async () => {
          try {
            const { currentIndex, entries } = (await cdp!.send("Page.getNavigationHistory", {}, sid)) as {
              currentIndex: number;
              entries: Array<{ id: number }>;
            };
            const target = entries[currentIndex + delta];
            // Off either end of the history is a no-op, not an error: the buttons stay live
            // rather than needing the client to track history state it cannot see.
            if (target) await cdp!.send("Page.navigateToHistoryEntry", { entryId: target.id }, sid);
          } catch (e) {
            log.warn("viewer history failed", { error: (e as Error).message });
          }
        })();
        return;
      }
      if (msg.type === "newTab") {
        if (!spendToken() || switching) return;
        switching = true;
        void (async () => {
          try {
            const { targetId } = (await cdp!.send("Target.createTarget", { url: "about:blank" })) as {
              targetId: string;
            };
            targets.set(targetId, { targetId, type: "page", url: "about:blank", title: "New tab" });
            await cdp!.send("Target.activateTarget", { targetId }).catch(noop);
            await attach(targetId);
          } catch (e) {
            log.warn("viewer newTab failed", { error: (e as Error).message });
          } finally {
            switching = false;
          }
        })();
        return;
      }
      if (msg.type === "closeTab") {
        if (typeof msg.targetId !== "string") return;
        const wantedClose = msg.targetId;
        const t = targets.get(wantedClose);
        if (!t || !isTab(t) || closing.has(wantedClose) || !spendToken()) return;
        // Closing the last tab would leave the viewer with nothing to stream and the browser
        // with no window; Chrome would exit. `targets` is only pruned when Chrome answers, so
        // the count has to exclude closes already in flight — two clicks inside one debounce
        // window otherwise both saw two tabs and took the browser down between them.
        if (projectTabs().filter((p) => !closing.has(p.targetId)).length < 2) return;
        closing.add(wantedClose);
        void cdp!.send("Target.closeTarget", { targetId: wantedClose }).catch((e) => {
          closing.delete(wantedClose);
          log.warn("viewer closeTab failed", { error: (e as Error).message });
        });
        return;
      }
      if (msg.type === "selectTab") {
        if (typeof msg.targetId !== "string") return;
        const t = targets.get(msg.targetId);
        if (!t || !isTab(t) || msg.targetId === activeTargetId || switching) return;
        if (!spendToken()) return;
        switching = true;
        const wanted = msg.targetId;
        void (async () => {
          try {
            // Headful Chrome composites only the foreground tab, so a screencast on a
            // background target emits nothing and the stage would simply go black.
            await cdp!.send("Target.activateTarget", { targetId: wanted }).catch(noop);
            await attach(wanted);
          } catch (e) {
            log.warn("viewer selectTab failed", { error: (e as Error).message });
          } finally {
            switching = false;
          }
        })();
        return;
      }
      if (msg.type === "viewport") {
        want = {
          w: clampDim(msg.width, 320, screen.width, content.width),
          h: clampDim(msg.height, 240, screen.height, content.height),
        };
        if (!sizeTimer) sizeTimer = track(setTimeout(() => void applySize(), 250));
        return;
      }
    };

    // Setup is done: drain whatever the dashboard sent while it was in progress, in order.
    ready = true;
    if (closed) return;
    for (const queued of inbox.splice(0)) handle(queued);
  } catch (e) {
    log.warn("viewer failed", { error: (e as Error).message });
    teardown();
    try {
      ws.close(1011, "viewer failed");
    } catch {
      /* ignore */
    }
  }
}
