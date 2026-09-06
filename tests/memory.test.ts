import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { rateLimit, pruneRateLimits, resetRateLimits } from "../src/rate-limit.js";
import { config } from "../src/config.js";

describe("memory bounds", () => {
  it("prunes idle rate-limit buckets, which were never released", async () => {
    resetRateLimits();
    for (let i = 0; i < 5000; i++) rateLimit(`probe:${i}`, 60, 30);
    // Nothing is idle yet, so nothing should go.
    assert.equal(pruneRateLimits(300_000), 0, "active buckets must survive");
    // The cutoff is strict, so let the clock move past the newest bucket.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(pruneRateLimits(0), 5000, "idle buckets must be released");
    assert.equal(pruneRateLimits(0), 0, "and the map must now be empty");
    resetRateLimits();
  });

  it("caps what a viewer socket may send at far below ws's 100 MiB default", () => {
    // A viewer only ever sends small control JSON; the default let one message cost the
    // process hundreds of megabytes.
    assert.ok(config.viewerHighWaterBytes <= 8 * 1024 * 1024);
    assert.ok(config.viewerWatchMinFrameMs >= 20, "an absolute frame floor must exist");
    assert.ok(config.viewerControlMinFrameMs >= 20);
  });

  it("caps the chrome-devtools bridge child's heap", () => {
    assert.match(config.mcpBridgeNodeOptions, /--max-old-space-size=\d+/);
  });
});

describe("the mcp bridge does not outlive its browser", () => {
  let ctx: TestCtx;
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("releases the bridge when the browser is stopped from the control API", async () => {
    const call = async (body: unknown, sid?: string) => {
      const res = await fetch(`${ctx.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.agentToken}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(sid ? { "mcp-session-id": sid } : {}),
        },
        body: JSON.stringify(body),
      });
      return { text: await res.text(), sid: res.headers.get("mcp-session-id") };
    };

    const init = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const sid = init.sid!;

    // Create it through MCP so the agent owns it; an admin-created browser is not
    // accessible to an agent principal, which is a separate (correct) behaviour.
    const made = await call(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tallylamp_create_browser", arguments: { name: "bridged" } },
      },
      sid,
    );
    const id = /browserId\\?":\\?"([a-f0-9]+)/.exec(made.text)?.[1];
    assert.ok(id, `expected a browserId, got: ${made.text.slice(0, 300)}`);
    assert.equal(ctx.browsers.mcpCount(id), 1, "creating through MCP should bind the session");

    // Stopping from the control API must tear the bridge down too, not just via the tool.
    await json(`${ctx.url}/api/v1/browsers/${id}/stop`, {
      method: "POST",
      headers: { Cookie: ctx.cookie },
    });
    assert.equal(ctx.browsers.mcpCount(id), 0, "a stopped browser must not keep a bridge attached");
  });
});
