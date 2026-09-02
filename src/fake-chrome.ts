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

function attachCdp(ws: WebSocket) {
  let idSession = "sess-1";
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
    const ok = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
    if (msg.method === "Target.getTargets") {
      ok({ targetInfos: [{ targetId: "t1", type: "page", title: "New Tab", url: "about:blank" }] });
      return;
    }
    if (msg.method === "Target.attachToTarget") {
      ok({ sessionId: idSession });
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
      const jpeg =
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAIIAAgICAgICAgICAgICAgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAD//2Q==";
      ws.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: jpeg, sessionId: 1, metadata: {} } }));
      return;
    }
    if (msg.method === "Page.screencastFrameAck" || msg.method === "Page.enable" || msg.method === "Runtime.enable" || msg.method === "Page.stopScreencast" || msg.method === "Input.setIgnoreInputEvents" || msg.method.startsWith("Input.")) {
      ok({});
      return;
    }
    if (msg.method === "Page.captureScreenshot") {
      ok({
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      });
      return;
    }
    ok({});
  });
}
