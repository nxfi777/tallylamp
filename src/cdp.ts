import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class CdpClient {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, Pending>();
  /**
   * The third argument is the CDP session the event arrived on. Without it a client attached
   * to two page targets cannot tell whose `Page.screencastFrame` it is holding, which is the
   * whole of what tab switching needs to get right.
   */
  onEvent: ((method: string, params: Record<string, unknown>, sessionId?: string) => void) | null = null;

  constructor(public readonly browserWsUrl: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.browserWsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => resolve());
      this.ws!.once("error", reject);
    });
    this.ws.on("close", () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("CDP closed"));
      }
      this.pending.clear();
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method && this.onEvent) this.onEvent(msg.method, msg.params ?? {}, msg.sessionId);
    });
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.ws) throw new Error("CDP not connected");
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      // The timer is held on the pending entry and cleared when the reply lands. It used to be
      // orphaned, so every send left a live 8s timer behind — and the viewer sends one per
      // pointer move.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout ${method}`));
        }
      }, 8_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }
}

export async function browserWsUrl(cdpHttp: string): Promise<string> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 10_000) {
    try {
      const res = await fetch(`${cdpHttp}/json/version`);
      const j = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      last = JSON.stringify(j);
    } catch (e) {
      last = (e as Error).message;
    }
    await sleep(100);
  }
  throw new Error(`could not read CDP version from ${cdpHttp}: ${last}`);
}

export async function listPages(cdpHttp: string): Promise<Array<{ id: string; url: string; title: string; type: string; webSocketDebuggerUrl?: string }>> {
  const res = await fetch(`${cdpHttp}/json/list`);
  return (await res.json()) as Array<{ id: string; url: string; title: string; type: string; webSocketDebuggerUrl?: string }>;
}

export async function evaluate(cdp: CdpClient, expression: string): Promise<unknown> {
  const { targetId } = await pickPage(cdp);
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
    sessionId: string;
  };
  await cdp.send("Runtime.enable", {}, sessionId);
  const result = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)) as {
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

async function pickPage(cdp: CdpClient): Promise<{ targetId: string }> {
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  const page = targetInfos.find((t) => t.type === "page") ?? targetInfos[0];
  if (!page) throw new Error("no CDP targets");
  return { targetId: page.targetId };
}

export async function captureScreenshot(cdpHttp: string, quality = 40): Promise<Buffer> {
  const wsUrl = await browserWsUrl(cdpHttp);
  const cdp = new CdpClient(wsUrl);
  await cdp.connect();
  try {
    const { targetId } = await pickPage(cdp);
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    await cdp.send("Page.enable", {}, sessionId);
    const { data } = (await cdp.send(
      "Page.captureScreenshot",
      { format: "jpeg", quality },
      sessionId,
    )) as { data: string };
    return Buffer.from(data, "base64");
  } finally {
    await cdp.close();
  }
}
