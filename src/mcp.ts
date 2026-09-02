import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./log.js";
import { Err, errorBody } from "./errors.js";
import type { Principal } from "./auth.js";
import { CREATE_BROWSER_TOOL_DESCRIPTION } from "./metadata.js";
import { BrowserManager, logToolActivity, type BrowserRow } from "./browsers.js";
import { sanitizedChromeEnv } from "./chrome.js";

const require = createRequire(import.meta.url);

const MUTATING_TOOLS = new Set([
  "click",
  "drag",
  "fill",
  "fill_form",
  "handle_dialog",
  "hover",
  "press_key",
  "type_text",
  "upload_file",
  "click_at",
  "close_page",
  "navigate_page",
  "new_page",
  "select_page",
  "emulate",
  "resize_page",
  "evaluate_script",
  "screencast_start",
  "screencast_stop",
]);

export const LIFECYCLE_TOOLS: Tool[] = [
  {
    name: "tallylamp_create_browser",
    description: CREATE_BROWSER_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional display name" },
        persistent: { type: "boolean", description: "Retain the profile after idle stop. Default true." },
        seedId: { type: "string", description: "Optional seed profile id to clone" },
        metadata: {
          type: "object",
          description: "Optional descriptive metadata (source, project, purpose, task, labels). Not identity.",
        },
      },
    },
  },
  {
    name: "tallylamp_list_browsers",
    description: "List browsers this agent can access.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tallylamp_use_browser",
    description:
      "Bind this MCP session to an existing browser owned by you (or any browser if you are the administrator). Subsequent chrome-devtools tools drive that browser.",
    inputSchema: {
      type: "object",
      required: ["browserId"],
      properties: { browserId: { type: "string" } },
    },
  },
  {
    name: "tallylamp_stop_browser",
    description: "Stop the Chrome process for a browser. Persistent profiles are kept.",
    inputSchema: {
      type: "object",
      required: ["browserId"],
      properties: { browserId: { type: "string" } },
    },
  },
  {
    name: "tallylamp_delete_browser",
    description: "Delete a browser and its profile. This removes authenticated website state.",
    inputSchema: {
      type: "object",
      required: ["browserId"],
      properties: { browserId: { type: "string" } },
    },
  },
];

function chromeDevtoolsBin(): string {
  const pkg = require.resolve("chrome-devtools-mcp/package.json");
  const dir = path.dirname(pkg);
  return path.join(dir, "build", "src", "index.js");
}

type Session = {
  id: string;
  principal: Principal;
  transport: StreamableHTTPServerTransport;
  server: Server;
  browserId?: string;
  child?: { client: Client; transport: StdioClientTransport };
  clientInfo?: { name?: string; version?: string };
};

export class McpGateway {
  private sessions = new Map<string, Session>();

  constructor(private browsers: BrowserManager) {}

  async handle(req: Request, res: Response, principal: Principal): Promise<void> {
    const sessionId = req.header("mcp-session-id");
    if (req.method === "DELETE" && sessionId) {
      await this.close(sessionId);
      res.status(200).end();
      return;
    }
    if (sessionId && this.sessions.has(sessionId)) {
      const s = this.sessions.get(sessionId)!;
      await s.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method === "POST" && isInitializeRequest(req.body)) {
      await this.open(req, res, principal);
      return;
    }
    if (req.method === "GET" && sessionId) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.status(400).json({ error: "missing MCP session; send initialize" });
  }

  private async open(req: Request, res: Response, principal: Principal): Promise<void> {
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
    });
    const server = new Server(
      { name: "tallylamp", version: config.version },
      { capabilities: { tools: { listChanged: true } } },
    );
    const session: Session = { id, principal, transport, server };
    this.sessions.set(id, session);

    const init = req.body as { params?: { clientInfo?: { name?: string; version?: string } } };
    session.clientInfo = init.params?.clientInfo;

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [...LIFECYCLE_TOOLS];
      if (session.child) {
        const listed = await session.child.client.listTools();
        tools.push(...listed.tools);
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.callTool(session, request.params.name, request.params.arguments ?? {});
    });

    // Do not tear the MCP session down when a single POST SSE stream ends.
    // Clients reconnect with MCP-Session-Id; DELETE /mcp is the explicit close.

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    startSseKeepalive(res);
  }

  private async callTool(session: Session, name: string, args: Record<string, unknown>) {
    if (name.startsWith("tallylamp_")) {
      return this.callLifecycle(session, name, args);
    }
    if (session.browserId && MUTATING_TOOLS.has(name) && this.browsers.isHumanControlled(session.browserId)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "browser is controlled by a human; retry later",
          },
        ],
      };
    }
    if (!session.browserId || !session.child) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "No browser is bound to this session. Call tallylamp_create_browser or tallylamp_use_browser first.",
          },
        ],
      };
    }
    this.browsers.touch(session.browserId);
    logToolActivity(session.browserId, name);
    const result = await session.child.client.callTool({ name, arguments: args });
    void this.browsers.refreshPageInfo(session.browserId);
    return result;
  }

  private async callLifecycle(session: Session, name: string, args: Record<string, unknown>) {
    const p = session.principal;
    try {
      if (name === "tallylamp_create_browser") {
        const row = this.browsers.create({
          principal: p,
          via: "mcp",
          name: typeof args.name === "string" ? args.name : undefined,
          persistent: args.persistent !== false,
          metadata: args.metadata,
          seedId: typeof args.seedId === "string" ? args.seedId : undefined,
          clientName: session.clientInfo?.name,
          clientVersion: session.clientInfo?.version,
        });
        await this.bind(session, row);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                browserId: row.id,
                name: row.name,
                slug: row.slug,
                persistent: row.persistent === 1,
                note: "Browser created and bound to this session. chrome-devtools tools are now available. Metadata is descriptive only; authenticated identity is the agent principal.",
              }),
            },
          ],
        };
      }
      if (name === "tallylamp_list_browsers") {
        const rows =
          p.type === "admin" ? this.browsers.list() : this.browsers.list({ ownerType: "agent", ownerId: p.id });
        return {
          content: [{ type: "text", text: JSON.stringify(rows.map((r) => this.browsers.publicView(r))) }],
        };
      }
      if (name === "tallylamp_use_browser") {
        const id = String(args.browserId ?? "");
        const row = this.browsers.row(id);
        this.browsers.assertAccess(p, row, "control");
        await this.bind(session, row);
        return { content: [{ type: "text", text: JSON.stringify({ browserId: row.id, bound: true }) }] };
      }
      if (name === "tallylamp_stop_browser") {
        const id = String(args.browserId ?? session.browserId ?? "");
        const row = this.browsers.row(id);
        this.browsers.assertAccess(p, row, "control");
        await this.browsers.stop(id);
        return { content: [{ type: "text", text: JSON.stringify({ browserId: id, status: "stopped" }) }] };
      }
      if (name === "tallylamp_delete_browser") {
        const id = String(args.browserId ?? session.browserId ?? "");
        await this.browsers.destroy(id, p);
        if (session.browserId === id) await this.unbindChild(session);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: id }) }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    } catch (e) {
      const body = errorBody(e);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
    }
  }

  private async bind(session: Session, row: BrowserRow): Promise<void> {
    const rt = await this.browsers.ensureRunning(row.id);
    if (session.browserId && session.browserId !== row.id) {
      this.browsers.detachMcp(session.browserId);
    }
    await this.unbindChild(session);
    session.browserId = row.id;
    this.browsers.attachMcp(row.id);
    this.browsers.recordClient(row.id, session.clientInfo?.name, session.clientInfo?.version);
    if (!this.browsers.isHumanControlled(row.id)) {
      this.browsers.acquireControl(row.id, "agent", session.principal.id);
    }
    if (config.fakeChrome) {
      log.info("mcp bound fake browser (no chrome-devtools-mcp child)", { session: session.id, browser: row.id });
      return;
    }
    const bin = chromeDevtoolsBin();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        bin,
        `--browser-url=${rt.cdpUrl}`,
        "--no-usage-statistics",
        "--experimental-structured-content",
      ],
      env: {
        ...sanitizedChromeEnv(),
        CI: "1",
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "tallylamp-bridge", version: config.version });
    await client.connect(transport);
    session.child = { client, transport };
    try {
      await session.server.notification({ method: "notifications/tools/list_changed" });
    } catch {
      /* client may not support it */
    }
    log.info("mcp bound browser", { session: session.id, browser: row.id });
  }

  private async unbindChild(session: Session): Promise<void> {
    if (!session.child) return;
    try {
      await session.child.client.close();
    } catch {
      /* ignore */
    }
    session.child = undefined;
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.browserId) this.browsers.detachMcp(s.browserId);
    await this.unbindChild(s);
    try {
      await s.transport.close();
    } catch {
      /* ignore */
    }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.close(id);
  }
}

const SSE_KEEPALIVE_MS = 30_000;

export function startSseKeepalive(res: Response, everyMs = SSE_KEEPALIVE_MS): () => void {
  const timer = setInterval(() => {
    if (!res.headersSent || res.writableEnded || !res.writable) return;
    const ct = res.getHeader("content-type");
    if (ct !== undefined && !String(ct).includes("text/event-stream")) return;
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* ignore */
    }
  }, everyMs);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
  return () => clearInterval(timer);
}

void fileURLToPath;
void Err;
