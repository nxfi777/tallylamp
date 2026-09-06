import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetDbForTests } from "../src/db.js";
import { BrowserManager } from "../src/browsers.js";
import { McpGateway } from "../src/mcp.js";
import { createApp } from "../src/server.js";
import { attachViewerUpgrade } from "../src/viewer.js";
import { attachTunnelUpgrade } from "../src/tunnels.js";
import { createAgent } from "../src/auth.js";
import { resetRateLimits } from "../src/rate-limit.js";

export type TestCtx = {
  url: string;
  adminSecret: string;
  browsers: BrowserManager;
  mcp: McpGateway;
  close: () => Promise<void>;
  cookie: string;
  agentToken: string;
};

export async function startTestServer(opts?: { adminSecret?: string }): Promise<TestCtx> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tallylamp-test-"));
  process.env.TALLYLAMP_DATA_DIR = dir;
  process.env.ADMIN_SECRET = opts?.adminSecret ?? "test-admin-secret-value";
  process.env.TALLYLAMP_FAKE_CHROME = "1";
  process.env.TALLYLAMP_PUBLIC_URL = "http://127.0.0.1";
  process.env.TALLYLAMP_OAUTH = "1";
  process.env.TALLYLAMP_MAX_BROWSERS = "4";
  resetRateLimits();
  resetDbForTests(path.join(dir, "tallylamp.sqlite"));

  const browsers = new BrowserManager();
  const mcp = new McpGateway(browsers);
  const app = createApp(browsers, mcp);
  const server = http.createServer(app);
  attachViewerUpgrade(server, browsers);
  attachTunnelUpgrade(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  process.env.TALLYLAMP_PUBLIC_URL = url;

  const login = await fetch(`${url}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.ADMIN_SECRET }),
  });
  const setCookie = login.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0] || "";
  const created = createAgent({ name: "Test Agent", maxBrowsers: 3 });

  return {
    url,
    adminSecret: process.env.ADMIN_SECRET!,
    browsers,
    mcp,
    cookie,
    agentToken: created.token,
    close: async () => {
      await mcp.closeAll();
      await browsers.shutdown();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
        setTimeout(resolve, 1000);
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function json(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
