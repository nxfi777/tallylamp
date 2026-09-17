import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { agentDesktop, agentDesktopCommand, authorizeAgentDesktop } from "../src/agent-desktop.js";
import { createAgent, updateAgent, DEFAULT_AGENT_SCOPES, type Principal } from "../src/auth.js";
import type { BrowserManager } from "../src/browsers.js";
import type { ChromeRuntime } from "../src/chrome.js";
import { LIFECYCLE_TOOLS } from "../src/mcp.js";
import { startTestServer, json, type TestCtx } from "./helpers.js";

const admin: Principal = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] };
const size = { width: 2560, height: 1600 };
describe("atomic native input", () => {
  it("accepts bounded input, releases chords and rejects command injection", () => {
    assert.deepEqual(agentDesktopCommand({ action: "key", keys: ["Control", "l"] }, size), {
      args: ["key", "--clearmodifiers", "Control_L+U006c"], release: ["keyup", "Control_L", "U006c"],
    });
    for (const input of [{ action: "key", keys: ["ctrl+l"] }, { action: "key", keys: ["constructor"] },
      { action: "click", x: NaN, y: 0 }, { action: "click", x: 2560, y: 1 }, { action: "click", x: 1, y: 2, button: "constructor" },
      { action: "type", text: "a".repeat(2049) }, { action: "keyDown", key: "Shift" }]) {
      assert.throws(() => agentDesktopCommand(input, size));
    }
    assert.deepEqual(agentDesktopCommand({ action: "type", text: "--window 1; $(bad)" }, size).args,
      ["type", "--clearmodifiers", "--delay", "0", "--", "--window 1; $(bad)"]);
    assert.equal(agentDesktopCommand({ action: "openExtensions" }, size).args.at(-1), "chrome://extensions/\n");
  });
});

describe("agent native access", () => {
  let ctx: TestCtx;
  let owner: ReturnType<typeof createAgent>;
  let other: ReturnType<typeof createAgent>;
  let id: string;
  let rt: ChromeRuntime;
  let oldDisplay: string | null;
  const env = { xvfb: process.env.TALLYLAMP_XVFB, fake: process.env.TALLYLAMP_FAKE_CHROME, defaultAccess: process.env.TALLYLAMP_AGENT_DESKTOP_DEFAULT };
  before(async () => {
    process.env.TALLYLAMP_AGENT_DESKTOP_DEFAULT = "0";
    ctx = await startTestServer();
    owner = createAgent({ name: "Native owner" }); other = createAgent({ name: "Other agent" });
    id = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "Native test" }).id;
    rt = await ctx.browsers.ensureRunning(id);
    oldDisplay = rt.display;
    rt.display = ":99"; rt.xvfb = {} as ChromeRuntime["xvfb"];
    process.env.TALLYLAMP_XVFB = "1"; process.env.TALLYLAMP_FAKE_CHROME = "0";
  });
  after(async () => {
    rt.display = oldDisplay; rt.xvfb = undefined;
    await ctx.close();
    for (const [key, value] of [["TALLYLAMP_XVFB", env.xvfb], ["TALLYLAMP_FAKE_CHROME", env.fake], ["TALLYLAMP_AGENT_DESKTOP_DEFAULT", env.defaultAccess]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  it("defaults off and only an administrator can grant the owner's access", async () => {
    assert.equal(ctx.browsers.publicView(ctx.browsers.row(id)).agentDesktopEnabled, false);
    assert.throws(() => authorizeAgentDesktop(ctx.browsers, owner.agent, id), /Ask the user.*Extensions.*Allow agent control.*Wait for approval/);
    const url = `${ctx.url}/api/v1/browsers/${id}/agent-desktop`;
    assert.equal((await json(url, { method: "PUT", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })).status, 403);
    assert.equal((await json(url, { method: "PUT", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) })).status, 400);
    assert.equal((await json(url, { method: "PUT", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })).status, 200);
    assert.equal(authorizeAgentDesktop(ctx.browsers, owner.agent, id), rt);
    assert.throws(() => authorizeAgentDesktop(ctx.browsers, other.agent, id), /owned by another/);
    const lent = { row: () => ctx.browsers.row(id), assertAccess: () => {} } as unknown as BrowserManager;
    assert.throws(() => authorizeAgentDesktop(lent, other.agent, id), /borrowing is not permission/);
  });
  const processes = () => {
    const calls: Array<{ bin: string; args: string[]; child: EventEmitter & { stdout: PassThrough; killed: boolean; kill: () => boolean } }> = [];
    const spawnProcess = ((bin: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
      calls.push({ bin, args, child });
      if (args[0] === "keyup" || args[0] === "mouseup") queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as unknown as typeof spawn;
    return { calls, spawnProcess };
  };
  it("returns full-window image dimensions and bounds simultaneous native calls", async () => {
    const { calls, spawnProcess } = processes();
    const pending = agentDesktop(ctx.browsers, owner.agent, id, {}, true, spawnProcess);
    await assert.rejects(agentDesktop(ctx.browsers, owner.agent, id, { action: "key", keys: ["Enter"] }, false, spawnProcess), /in progress/);
    const jpeg = Buffer.from([255, 216, 1, 255, 217]);
    calls[0].child.stdout.emit("data", jpeg);
    const result = await pending;
    assert.deepEqual(result.image, jpeg);
    assert.equal(result.screenWidth, rt.screen.width);
    assert.equal(result.imageWidth, Math.min(1600, rt.screen.width));
    assert.equal(calls[0].child.killed, true);
  });
  it("human takeover kills in-flight typing and refuses subsequent native reads and writes", async () => {
    const { calls, spawnProcess } = processes();
    const pending = agentDesktop(ctx.browsers, owner.agent, id, { action: "type", text: "private input" }, false, spawnProcess);
    ctx.browsers.acquireControl(id, "human", "admin", { force: true });
    await assert.rejects(pending, /controlled by a human/);
    assert.equal(calls[0].child.killed, true);
    assert.equal(calls[1].args[0], "keyup");
    assert.throws(() => authorizeAgentDesktop(ctx.browsers, owner.agent, id), /controlled by a human/);
    ctx.browsers.releaseControl(id);
  });
  it("revoking the UI permission cancels a running operation", async () => {
    const { calls, spawnProcess } = processes();
    const pending = agentDesktop(ctx.browsers, owner.agent, id, { action: "key", keys: ["Control", "l"] }, false, spawnProcess);
    ctx.browsers.updateAgentDesktop(id, false, admin);
    await assert.rejects(pending, /Allow agent control/);
    assert.equal(calls[0].child.killed, true);
    assert.equal(calls[1].args[0], "keyup");
    ctx.browsers.updateAgentDesktop(id, true, admin);
  });
  it("rechecks current agent scopes rather than trusting the session's cached principal", () => {
    updateAgent(owner.agent.id, { scopes: DEFAULT_AGENT_SCOPES.filter(s => s !== "browser:control:own") });
    assert.throws(() => authorizeAgentDesktop(ctx.browsers, owner.agent, id), /missing.*browser:control:own/);
    updateAgent(owner.agent.id, { scopes: [...DEFAULT_AGENT_SCOPES] });
  });
  it("registers both MCP tools and enforces the actual target's human lease through MCP", async () => {
    assert.ok(LIFECYCLE_TOOLS.some(t => t.name === "tallylamp_desktop_action"));
    assert.ok(LIFECYCLE_TOOLS.some(t => t.name === "tallylamp_desktop_screenshot"));
    const rpc = (method: string, params: unknown, session?: string) => json(`${ctx.url}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25", ...(session ? { "MCP-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "native-test", version: "1" } });
    ctx.browsers.acquireControl(id, "human", "admin");
    const result = await rpc("tools/call", { name: "tallylamp_desktop_action", arguments: { browserId: id, action: "key", keys: ["Enter"] } }, init.headers.get("mcp-session-id")!);
    assert.match(String(result.body), /human_controlling_browser/);
    ctx.browsers.releaseControl(id);
    ctx.browsers.updateAgentDesktop(id, false, admin);
    const denied = await rpc("tools/call", { name: "tallylamp_desktop_screenshot", arguments: { browserId: id } }, init.headers.get("mcp-session-id")!);
    assert.match(String(denied.body), /Allow agent control/);
  });
  it("applies the env default only at creation and keeps saved choices and revocations", () => {
    const policy = createAgent({ name: "Default policy", maxBrowsers: 4 });
    const existing = ctx.browsers.create({ principal: policy.agent, via: "mcp" });
    assert.equal(existing.agent_desktop_enabled, 0);
    process.env.TALLYLAMP_AGENT_DESKTOP_DEFAULT = "1";
    try {
      const allowed = ctx.browsers.create({ principal: policy.agent, via: "mcp" });
      assert.equal(allowed.agent_desktop_enabled, 1);
      assert.equal(allowed.extensions_enabled, 0, "native access must not enable extensions");
      assert.equal(ctx.browsers.row(existing.id).agent_desktop_enabled, 0, "existing decisions are not overwritten");
      assert.equal(ctx.browsers.create({ principal: admin, via: "dashboard" }).agent_desktop_enabled, 0);
      ctx.browsers.updateAgentDesktop(allowed.id, false, admin);
      assert.equal(ctx.browsers.row(allowed.id).agent_desktop_enabled, 0, "revocation wins while env default is on");
      const kept = ctx.browsers.create({ principal: policy.agent, via: "mcp" });
      process.env.TALLYLAMP_AGENT_DESKTOP_DEFAULT = "0";
      assert.equal(ctx.browsers.row(kept.id).agent_desktop_enabled, 1, "saved grants survive a default change");
      assert.equal(ctx.browsers.create({ principal: policy.agent, via: "mcp" }).agent_desktop_enabled, 0);
    } finally { process.env.TALLYLAMP_AGENT_DESKTOP_DEFAULT = "0"; }
  });
  it("tells agents where to request permission and to wait instead of bypassing it", () => {
    for (const name of ["tallylamp_desktop_screenshot", "tallylamp_desktop_action"]) {
      assert.match(LIFECYCLE_TOOLS.find(t => t.name === name)!.description!, /ask the user.*dashboard > Extensions > Allow agent control.*wait for approval/);
    }
  });
});
