import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ChromeRuntime } from "./chrome.js";

/**
 * Minimal CDP stand-in for tests that must not launch a real browser.
 */
export function startFakeChrome(): Promise<{ runtime: ChromeRuntime; close: () => Promise<void> }> {
  const pages = [{ id: "page-1", type: "page", url: "about:blank", title: "New Tab", webSocketDebuggerUrl: "" }];
  let wsUrl = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: wsUrl, "User-Agent": "Mozilla/5.0 FakeChrome" }));
      return;
    }
    if (req.url === "/json/list" || req.url === "/json") {
      pages[0]!.webSocketDebuggerUrl = wsUrl;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(pages));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => attachCdp(ws));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      wsUrl = `ws://127.0.0.1:${port}/devtools/browser/fake`;
      const runtime = {
        display: null,
        cdpPort: port,
        cdpUrl: `http://127.0.0.1:${port}`,
        chrome: { pid: process.pid, exitCode: null, unref() {}, kill() {} } as unknown as ChromeRuntime["chrome"],
        sandboxStatus: "unknown" as const,
        gpuStatus: "unknown" as const,
        profileDir: "/tmp/fake",
        downloadDir: "/tmp/fake-dl",
        // Declared so the viewer's server-side clamp is exercised by the test suite rather
        // than silently defaulting.
        screen: { width: 2560, height: 1600 },
      };
      resolve({
        runtime,
        close: async () => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          await new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
            setTimeout(r, 500);
          });
        },
      });
    });
  });
}

/**
 * CDP calls the fake has served, so a test can assert on what the viewer actually asked
 * Chrome for. The catch-all `ok({})` below answers anything, which would otherwise let a
 * test for new behaviour pass without that behaviour existing.
 */
export const fakeCdpCalls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];

export function resetFakeCdp(): void {
  fakeCdpCalls.length = 0;
}

/** A real 8x8 JPEG, shared by the screencast and the screenshot paths. */
const FAKE_JPEG =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAAf/aAAwDAQACEQMRAD8A+mKKKK2MT//Z";

/** Live screencasts, so a test can make the page appear to move. */
const casts = new Set<{ ws: WebSocket; envelope?: string; params: Record<string, unknown> }>();

/**
 * Push one screencast frame, as a real repaint would. Real Chrome sends exactly one frame the
 * instant a screencast starts and then nothing until something actually repaints, so a test
 * that needs motion has to ask for it — which is the whole distinction the capture code turns
 * on.
 */
export function emitFakeFrame(): number {
  let sent = 0;
  for (const c of casts) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    c.ws.send(
      JSON.stringify({
        method: "Page.screencastFrame",
        sessionId: c.envelope,
        params: {
          data: FAKE_JPEG,
          sessionId: 1,
          metadata: {
            deviceWidth: Number(c.params.maxWidth ?? 1280),
            deviceHeight: Number(c.params.maxHeight ?? 800),
            timestamp: Date.now() / 1000,
          },
        },
      }),
    );
    sent += 1;
  }
  return sent;
}

/** Two tabs, so tab switching and the "do not strand the human on about:blank" pick are real. */
const DEFAULT_TARGETS = [
  { targetId: "t1", type: "page", title: "New Tab", url: "about:blank" },
  { targetId: "t2", type: "page", title: "Example", url: "https://example.test/" },
];

let FAKE_TARGETS: Array<{ targetId: string; type: string; title: string; url: string }> = DEFAULT_TARGETS;

/** Vary the tab list a test sees — e.g. a browser sitting on its blank startup tab alone. */
export function setFakeTargets(targets: typeof DEFAULT_TARGETS | null): void {
  FAKE_TARGETS = targets ?? DEFAULT_TARGETS;
}

function attachCdp(ws: WebSocket) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    fakeCdpCalls.push({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
    const ok = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
    if (msg.method === "Target.setDiscoverTargets") {
      ok({});
      // Real Chrome synthesizes targetCreated for everything that already exists.
      for (const t of FAKE_TARGETS) ws.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: t } }));
      return;
    }
    if (msg.method === "Target.getTargets") {
      ok({ targetInfos: FAKE_TARGETS });
      return;
    }
    if (msg.method === "Target.attachToTarget") {
      // A distinct session per target, or nothing can tell two tabs' frames apart.
      ok({ sessionId: `sess-${String(msg.params?.targetId ?? "t1")}` });
      return;
    }
    if (msg.method === "Browser.getWindowForTarget") {
      ok({ windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" } });
      return;
    }
    if (msg.method === "Runtime.evaluate") {
      const expr = String(msg.params?.expression ?? "");
      let value: unknown = null;
      try {
        if (expr.includes("userAgent")) {
          value = {
            userAgent: "Mozilla/5.0 FakeChrome",
            webdriver: undefined,
            languages: ["en-US"],
            plugins: [],
          };
        } else value = null;
      } catch {
        value = null;
      }
      ok({ result: { type: "object", value } });
      return;
    }
    if (msg.method === "Page.startScreencast") {
      ok({});
      const cast = { ws, envelope: msg.sessionId, params: msg.params ?? {} };
      casts.add(cast);
      ws.once("close", () => casts.delete(cast));
      // A real 8x8 JPEG. The previous fixture had a zero-length DQT segment, so Chrome
      // refused to decode it and every visual check against the fake showed a broken image.
      // Stamped with the envelope session it was started on, as real Chrome does, so a viewer
      // holding two sessions can tell whose frame this is.
      ws.send(
        JSON.stringify({
          method: "Page.screencastFrame",
          sessionId: msg.sessionId,
          params: {
            data: FAKE_JPEG,
            sessionId: 1,
            metadata: {
              deviceWidth: Number(msg.params?.maxWidth ?? 1280),
              deviceHeight: Number(msg.params?.maxHeight ?? 800),
            },
          },
        }),
      );
      return;
    }
    if (msg.method === "Page.stopScreencast") {
      for (const c of [...casts]) if (c.ws === ws) casts.delete(c);
      ok({});
      return;
    }
    if (msg.method === "Page.screencastFrameAck" || msg.method === "Page.enable" || msg.method === "Runtime.enable" || msg.method === "Page.stopScreencast" || msg.method === "Input.setIgnoreInputEvents" || msg.method.startsWith("Input.")) {
      ok({});
      return;
    }
    if (msg.method === "Page.captureScreenshot") {
      // A JPEG, because that is what the viewer asks for and how it labels the frame. A PNG
      // here renders as a broken image in any smoke test against the fake.
      ok({
        data:
          "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAAf/aAAwDAQACEQMRAD8A+mKKKK2MT//Z",
      });
      return;
    }
    ok({});
  });
}
