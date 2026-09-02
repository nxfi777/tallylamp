import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { sha256 } from "./auth.js";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import { CdpClient } from "./cdp.js";
import type { BrowserManager } from "./browsers.js";
import { log } from "./log.js";

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
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = url.pathname.match(/^\/api\/v1\/browsers\/([^/]+)\/view$/);
    if (!m) return;
    const browserId = m[1];
    const token = url.searchParams.get("ticket") ?? "";
    try {
      const ticket = consumeViewerTicket(token, browserId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        void runViewer(ws, req, browsers, browserId, ticket.mode);
      });
    } catch (e) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log.warn("viewer upgrade rejected", { error: (e as Error).message });
    }
  });
  return wss;
}

async function runViewer(
  ws: WebSocket,
  _req: IncomingMessage,
  browsers: BrowserManager,
  browserId: string,
  mode: "watch" | "control",
) {
  let cdp: CdpClient | null = null;
  let sessionId: string | undefined;
  try {
    const wsUrl = await browsers.cdpWs(browserId);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    const page = targetInfos.find((t) => t.type === "page") ?? targetInfos[0];
    if (!page) throw new Error("no page");
    const attached = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as {
      sessionId: string;
    };
    sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Input.setIgnoreInputEvents", { ignore: mode !== "control" }, sessionId).catch(() => undefined);
    cdp.onEvent = (method, params) => {
      if (method === "Page.screencastFrame") {
        const data = params.data as string;
        const session = params.sessionId as number | undefined;
        ws.send(JSON.stringify({ type: "frame", mime: "image/jpeg", data, metadata: params.metadata }));
        if (session !== undefined) {
          void cdp!.send("Page.screencastFrameAck", { sessionId: session }, sessionId);
        }
      }
    };
    const quality = mode === "control" ? 60 : 35;
    const everyNth = mode === "control" ? 1 : 4;
    await cdp.send(
      "Page.startScreencast",
      { format: "jpeg", quality, everyNthFrame: everyNth, maxWidth: mode === "control" ? 1280 : 640, maxHeight: mode === "control" ? 800 : 400 },
      sessionId,
    );
    ws.send(JSON.stringify({ type: "hello", mode, browserId }));

    ws.on("message", (raw) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "heartbeat" && mode === "control" && typeof msg.leaseToken === "string") {
        try {
          browsers.heartbeatControl(browserId, msg.leaseToken);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "lease expired" }));
        }
        return;
      }
      if (mode !== "control") return;
      const lease = browsers.controlState(browserId);
      if (lease.controllerType !== "human") return;
      if (msg.type === "mouse") {
        void cdp!.send(
          "Input.dispatchMouseEvent",
          {
            type: msg.event ?? "mousePressed",
            x: msg.x,
            y: msg.y,
            button: msg.button ?? "left",
            clickCount: msg.clickCount ?? 1,
          },
          sessionId,
        );
      }
      if (msg.type === "key") {
        void cdp!.send(
          "Input.dispatchKeyEvent",
          {
            type: msg.event ?? "keyDown",
            key: msg.key,
            code: msg.code,
            text: msg.text,
            unmodifiedText: msg.text,
          },
          sessionId,
        );
      }
      if (msg.type === "scroll") {
        void cdp!.send(
          "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: msg.x ?? 0, y: msg.y ?? 0, deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 },
          sessionId,
        );
      }
    });
    ws.on("close", () => {
      void cdp?.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
      void cdp?.close();
    });
  } catch (e) {
    log.warn("viewer failed", { error: (e as Error).message });
    try {
      ws.close(1011, "viewer failed");
    } catch {
      /* ignore */
    }
    await cdp?.close();
  }
}
