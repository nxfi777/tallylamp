import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { createAgent } from "../src/auth.js";
import { downloadDir, profileDir } from "../src/config.js";
import { existsSync } from "node:fs";

let ctx: TestCtx;

describe("isolation and secrets", () => {
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("each browser has its own profile and download directories", async () => {
    const a = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "iso-a", start: false }),
    });
    const b = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "iso-b", start: false }),
    });
    const idA = (a.body as { browser: { id: string } }).browser.id;
    const idB = (b.body as { browser: { id: string } }).browser.id;
    assert.notEqual(profileDir(idA), profileDir(idB));
    assert.notEqual(downloadDir(idA), downloadDir(idB));
    assert.equal(existsSync(profileDir(idA)), true);
    assert.equal(existsSync(profileDir(idB)), true);
  });

  it("browser A authorization cannot view browser B", async () => {
    const agent = createAgent({ name: "iso-agent" });
    const mine = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mine", start: false }),
    });
    const other = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "admin-only", start: false }),
    });
    const otherId = (other.body as { browser: { id: string } }).browser.id;
    const r = await json(`${ctx.url}/api/v1/browsers/${otherId}`, {
      headers: { Authorization: `Bearer ${agent.token}` },
    });
    assert.equal(r.status, 403);
    void mine;
  });

  it("expired viewer tickets are rejected", async () => {
    const created = await json(`${ctx.url}/api/v1/browsers`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "view", start: true }),
    });
    const id = (created.body as { browser: { id: string } }).browser.id;
    const t = await json(`${ctx.url}/api/v1/browsers/${id}/viewer-ticket`, {
      method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "watch" }),
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const wsUrl = `${ctx.url.replace("http", "ws")}/api/v1/browsers/${id}/view?ticket=${ticket}`;
    const WebSocket = (await import("ws")).default;
    const first = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve(101);
        ws.terminate();
      });
      ws.on("error", () => resolve(0));
    });
    assert.equal(first, 101);
    const again = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("error", () => resolve(0));
    });
    assert.notEqual(again, 101);
  });

  it("healthz does not leak secrets or browser names", async () => {
    const r = await json(`${ctx.url}/healthz`);
    const s = JSON.stringify(r.body);
    assert.equal(s.includes("ADMIN_SECRET"), false);
    assert.equal(s.includes("tl_ag"), false);
    assert.equal(s.includes("iso-a"), false);
  });

  it("chrome env allowlist excludes admin secret", async () => {
    const { sanitizedChromeEnv } = await import("../src/chrome.js");
    process.env.ADMIN_SECRET = "super-secret-value";
    process.env.RAILWAY_TOKEN = "railway-token";
    const env = sanitizedChromeEnv();
    assert.equal(env.ADMIN_SECRET, undefined);
    assert.equal(env.RAILWAY_TOKEN, undefined);
  });
});
