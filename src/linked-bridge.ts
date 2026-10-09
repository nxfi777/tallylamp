import net, { type Socket } from "node:net";
import { WebSocket, type RawData } from "ws";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { bridgeSpawn } from "./mcp-bridge.js";
import { serveDials, TunnelMux } from "./tunnels.js";

/** Admission estimate for one Node bridge, independently of Chrome's placement. */
export const LINKED_BRIDGE_THREADS = 16;
const START_TIMEOUT_MS = 20_000;
const HEARTBEAT_MS = 10_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const READY = "linked-bridge-ready";
const ERROR = "linked-bridge-error";

function parsed(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8"));
}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

function send(ws: WebSocket, message: unknown): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("linked bridge connection is closed"));
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(message), { binary: false }, (error) => error ? reject(error) : resolve());
  });
}

/** Both ends reap a half-open connection; a dead main must not leave a worker child behind. */
function heartbeat(ws: WebSocket, fail: (error: Error) => void): () => void {
  let answered = true;
  const pong = () => { answered = true; };
  ws.on("pong", pong);
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!answered) return fail(new Error("linked bridge heartbeat timed out"));
    answered = false;
    ws.ping(undefined, undefined, (error?: Error) => { if (error) fail(error); });
  }, HEARTBEAT_MS);
  timer.unref();
  return () => { clearInterval(timer); ws.off("pong", pong); };
}

/**
 * MCP text and CDP tunnel frames share one authenticated, main-initiated socket. The
 * worker can request only the fixed linked-browser shim supplied here, never a URL or
 * port of its choice. No extension token or agent credential leaves the main instance.
 */
export function createLinkedBridgeTransport(url: string, secret: string, cdpPort: number): Transport & { readonly closed: boolean } {
  let ws: WebSocket | undefined;
  let started = false;
  let stopped = false;
  let ready = false;
  let timer: NodeJS.Timeout | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let stopDials: (() => void) | undefined;
  let rejectStart: ((error: Error) => void) | undefined;
  const sockets = new Set<Socket>();

  const finish = (error?: Error) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    stopHeartbeat?.();
    stopDials?.();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    ws?.terminate();
    rejectStart?.(error ?? new Error("linked bridge connection closed before it was ready"));
    rejectStart = undefined;
    if (error) transport.onerror?.(error);
    transport.onclose?.();
  };

  const transport: Transport & { readonly closed: boolean } = {
    get closed() { return stopped; },
    async start() {
      if (started || stopped) throw new Error("linked bridge transport cannot be started again");
      started = true;
      await new Promise<void>((resolve, reject) => {
        rejectStart = reject;
        timer = setTimeout(() => finish(new Error("linked bridge startup timed out")), START_TIMEOUT_MS);
        timer.unref();
        try {
          ws = new WebSocket(url, {
            headers: { Authorization: `Bearer ${secret}` },
            handshakeTimeout: START_TIMEOUT_MS,
            maxPayload: MAX_MESSAGE_BYTES,
            perMessageDeflate: false,
          });
        } catch (error) {
          finish(asError(error));
          return;
        }
        ws.on("error", (error) => finish(error));
        ws.on("close", () => finish());
        stopHeartbeat = heartbeat(ws, finish);
        stopDials = serveDials(ws, async (host, port) => {
          if (stopped || host !== "cdp" || port !== 1) return null;
          return new Promise<Socket>((connected, failed) => {
            const socket = net.connect({ host: "127.0.0.1", port: cdpPort });
            socket.setNoDelay(true);
            let didConnect = false;
            sockets.add(socket);
            const deadline = setTimeout(() => socket.destroy(new Error("linked CDP connection timed out")), START_TIMEOUT_MS);
            deadline.unref();
            socket.once("close", () => {
              clearTimeout(deadline);
              sockets.delete(socket);
              if (!didConnect) failed(new Error("linked CDP connection closed"));
            });
            socket.once("error", failed);
            socket.once("connect", () => { didConnect = true; clearTimeout(deadline); connected(socket); });
          });
        });
        ws.on("message", (data, binary) => {
          if (binary || stopped) return;
          try {
            const value = parsed(data);
            const envelope = value as { type?: unknown; message?: unknown } | null;
            if (envelope?.type === ERROR) {
              throw new Error(typeof envelope.message === "string" ? envelope.message : "worker could not start the linked bridge");
            }
            if (!ready && envelope?.type === READY) {
              ready = true;
              if (timer) clearTimeout(timer);
              rejectStart = undefined;
              resolve();
              return;
            }
            if (!ready) throw new Error("worker sent MCP before the linked bridge was ready");
            const message = JSONRPCMessageSchema.parse(value);
            transport.onmessage?.(message);
          } catch (error) { finish(asError(error)); }
        });
      });
    },
    async send(message) {
      if (!ready || stopped || !ws) throw new Error("linked bridge is not connected");
      try { await send(ws, message); }
      catch (error) { finish(asError(error)); throw error; }
    },
    async close() { finish(); },
  };
  return transport;
}

/** The caller authenticates and admits this connection before upgrading it. */
export function acceptLinkedBridge(ws: WebSocket, tempDir?: string): {
  close(): Promise<void>;
  closed: Promise<void>;
  readonly pid: number | null;
} {
  let stopped = false;
  let ready = false;
  let child: StdioClientTransport | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const sockets = new Set<Socket>();
  const mux = new TunnelMux(ws, { role: "linked-bridge" });
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.pause();
    void mux.open("cdp", 1).then((upstream) => {
      if (!upstream || stopped || socket.destroyed) {
        upstream?.destroy();
        socket.destroy();
        return;
      }
      const end = () => { socket.destroy(); upstream.destroy(); };
      upstream.on("error", end);
      upstream.once("close", end);
      socket.once("close", end);
      socket.pipe(upstream).pipe(socket);
    }).catch(() => socket.destroy());
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    clearTimeout(startTimer);
    stopHeartbeat();
    // Set the promise before terminating anything: close callbacks may re-enter here.
    closing = Promise.resolve().then(async () => {
      mux.shutdown("linked bridge closed");
      ws.terminate();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await listening.catch(() => undefined);
      await Promise.all([
        child?.close().catch(() => undefined),
        new Promise<void>((resolve) => { server.close(() => resolve()); }),
      ]);
    }).finally(resolveClosed);
    return closing;
  };
  const fail = (error: Error) => {
    if (stopped) return;
    // The channel is unusable even if this advisory message cannot leave the socket.
    void send(ws, { type: ERROR, message: error.message }).catch(() => undefined);
    void close();
  };
  const stopHeartbeat = heartbeat(ws, fail);
  const startTimer = setTimeout(() => fail(new Error("worker linked bridge startup timed out")), START_TIMEOUT_MS);
  startTimer.unref();
  ws.on("error", fail);
  ws.on("close", () => { void close(); });
  server.on("error", fail);
  ws.on("message", (data, binary) => {
    if (binary || stopped) return;
    try {
      if (!ready || !child) throw new Error("linked bridge is not ready");
      const message = JSONRPCMessageSchema.parse(parsed(data));
      void child.send(message).catch((error) => fail(asError(error)));
    } catch (error) { fail(asError(error)); }
  });

  void (async () => {
    await listening;
    if (stopped) return;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("linked bridge CDP listener did not start");
    const spawn = bridgeSpawn(`ws://127.0.0.1:${address.port}/devtools/browser/linked`, "ignore", true);
    child = new StdioClientTransport({
      ...spawn,
      env: { ...spawn.env, ...(tempDir ? { TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir } : {}) },
      maxBufferSize: MAX_MESSAGE_BYTES,
    });
    child.onerror = fail;
    child.onclose = () => { void close(); };
    child.onmessage = (message: JSONRPCMessage) => { void send(ws, message).catch((error) => fail(asError(error))); };
    await child.start();
    if (stopped) return;
    ready = true;
    await send(ws, { type: READY });
    clearTimeout(startTimer);
  })().catch((error) => fail(asError(error)));

  return { close, closed, get pid() { return child?.pid ?? null; } };
}
