import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { adminPrincipal, createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import {
  activeGrant,
  answerRequest,
  grantAccess,
  isPermanent,
  requestBrowser,
  revokeGrant,
  sweepLending,
} from "../src/lending.js";
import { MUTATING_TOOLS } from "../src/mcp.js";
import { getDb } from "../src/db.js";

/**
 * An agent asking the operator for access to a browser the operator owns, at a level the
 * operator chooses.
 *
 * The thing under test is not really "can it read a page" -- it is the gap between the two
 * levels. A read grant that leaks one mutating tool is worse than no read level at all,
 * because the operator was told it could only look.
 */

/** The MCP call the real client makes, over the wire, exactly as it makes it. */
async function mcp(
  ctx: TestCtx,
  token: string,
  name: string,
  args: Record<string, unknown>,
  session?: string,
) {
  const res = await json(`${ctx.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      ...(session ? { "MCP-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  // The transport answers with an SSE frame whose data line holds the JSON-RPC envelope, and
  // the tool's own payload is a JSON string inside that. Unwrapped here so every assertion
  // below reads the text the agent reads, rather than three layers of escaped quotes.
  const raw = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  let text = raw;
  const data = raw.match(/^data: (.+)$/m)?.[1];
  if (data) {
    try {
      const env = JSON.parse(data) as { result?: { content?: Array<{ text?: string }> } };
      const parts = env.result?.content?.map((c) => c.text ?? "").join("\n");
      if (parts) text = parts;
    } catch {
      /* leave the raw frame; the assertion message is more useful than a swallowed parse */
    }
  }
  return { ...res, text };
}

async function initSession(ctx: TestCtx, token: string): Promise<string> {
  const init = await json(`${ctx.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "reader", version: "0" } },
    }),
  });
  return init.headers.get("mcp-session-id")!;
}

/**
 * A fake Chrome has no chrome-devtools-mcp child, so a forwarded tool that gets all the way
 * past authorization lands on "No browser is bound" instead of a snapshot. That sentinel is
 * how the rest of this suite distinguishes "refused" from "allowed through, nothing to serve
 * it" (see tests/mcp.test.ts), and it is the same distinction being made here.
 */
const reachedBridge = (text: string) => text.includes("No browser is bound");

describe("an agent asking the operator to read one of their browsers", () => {
  let ctx: TestCtx;
  let reader: ReturnType<typeof createAgent>;
  let browserId: string;

  before(async () => {
    ctx = await startTestServer();
    // One operator-owned browser per case, and binding starts them. The helper's fleet cap of
    // 4 is about memory on a real host, which a fake Chrome does not use.
    process.env.TALLYLAMP_MAX_BROWSERS = "80";
  });
  after(async () => {
    delete process.env.TALLYLAMP_MAX_BROWSERS;
    await ctx.close();
  });

  /** A managed browser the human operator owns and signed in themselves. */
  const adminBrowser = (name: string) =>
    ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard", name }).id;

  const fresh = (name: string) => {
    reader = createAgent({ name, scopes: [...DEFAULT_AGENT_SCOPES], maxBrowsers: 2 });
    browserId = adminBrowser(`op-${Math.abs(Date.now() % 99999)}-${name}`);
    return { reader, browserId };
  };

  it("1. files the request on default scopes, and gets nothing until it is answered", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-a");
    assert.ok(
      !agent.agent.scopes.includes("browser:borrow"),
      "the point of this case is an agent nobody has edited first",
    );

    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id, reason: "read the dashboard page" });
    assert.equal(out.state, "pending", JSON.stringify(out));
    assert.equal(out.state === "pending" && out.access, "read", "an unqualified ask for the operator's browser is read");
    assert.equal(
      out.state === "pending" && out.answeredBy,
      "administrator",
      "there is no owning agent to answer for an operator-owned browser",
    );

    // Pending is not access, and the tool the client would reach for next says so.
    assert.equal(activeGrant(id, agent.agent.id), null);
    const session = await initSession(ctx, agent.token);
    const used = await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);
    assert.match(used.text, /unauthorized/, used.text.slice(0, 300));
    assert.match(used.text, /owned by another principal/, used.text.slice(0, 300));
  });

  it("2. binds read-only once the operator approves, and the reading tools go through", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-b");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id, reason: "one page" });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });

    const session = await initSession(ctx, agent.token);
    const used = await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);
    assert.match(used.text, /"bound":true/, used.text.slice(0, 300));
    assert.match(used.text, /"access":"read"/, used.text.slice(0, 400));

    // The two calls the client then repeats forever. Neither is refused; both reach the bridge.
    for (const tool of ["list_pages", "take_snapshot"]) {
      const res = await mcp(ctx, agent.token, tool, {}, session);
      assert.ok(
        reachedBridge(res.text),
        `${tool} must pass authorization under a read grant, got: ${res.text.slice(0, 300)}`,
      );
      assert.ok(!res.text.includes("grant_level_insufficient"), `${tool} must not be treated as mutating`);
    }
  });

  it("2b. advertises only the tools a reader can actually call", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-b2");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });
    const session = await initSession(ctx, agent.token);
    await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);

    const listed = await json(`${ctx.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent.token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        "MCP-Session-Id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = typeof listed.body === "string" ? listed.body : JSON.stringify(listed.body);
    const names = [...text.matchAll(/\\?"name\\?":\\?"([a-z_]+)\\?"/g)].map((m) => m[1]!);
    assert.ok(names.length > 5, text.slice(0, 300));
    for (const tool of MUTATING_TOOLS) {
      assert.ok(!names.includes(tool), `${tool} must not be offered to a reader that cannot call it`);
    }
    assert.ok(names.includes("tallylamp_select_page"), "but the read-safe way to change tab must be");
    assert.ok(names.includes("tallylamp_request_browser"), "and the way to ask for more");
  });

  it("3. refuses every mutating tool there is, including ones added after this was written", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-c");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });
    const session = await initSession(ctx, agent.token);
    await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);

    // Iterated, not listed: a tool added to MUTATING_TOOLS later is covered without anybody
    // remembering to come back here, which is the only way this stays true.
    assert.ok(MUTATING_TOOLS.size > 15, "sanity: the set is the real one");
    for (const tool of MUTATING_TOOLS) {
      const res = await mcp(ctx, agent.token, tool, {}, session);
      assert.ok(
        res.text.includes("grant_level_insufficient") || res.text.includes("unauthorized"),
        `${tool} must be refused under a read grant, got: ${res.text.slice(0, 200)}`,
      );
      // The refusal has to name the level, or the agent retries instead of asking for more.
      assert.match(
        res.text,
        /access level\W*read|either access level|belongs to whoever owns/i,
        `${tool} refusal must say why, not just no: ${res.text.slice(0, 200)}`,
      );
      assert.ok(
        !/"retryable":true/.test(res.text),
        `${tool} must not invite a retry -- waiting never turns read into control: ${res.text.slice(0, 200)}`,
      );
    }
  });

  it("4. takes no control lease and moves nobody's tab", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-d");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });

    const before = ctx.browsers.controlState(id);
    assert.equal(before.controllerType, "none", "sanity: nobody was driving before the read bind");
    const session = await initSession(ctx, agent.token);
    await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);
    const after = ctx.browsers.controlState(id);
    assert.equal(after.controllerType, "none", "a reader must never appear as the controller");
    assert.notEqual(after.controllerId, agent.agent.id);

    // And the same while a person holds the lease: the reader must not disturb it at all.
    ctx.browsers.acquireControl(id, "human", "admin", { force: true });
    try {
      const held = ctx.browsers.controlState(id);
      const s2 = await initSession(ctx, agent.token);
      await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, s2);
      const still = ctx.browsers.controlState(id);
      assert.equal(still.controllerType, "human", "a read bind must not take a lease off a person");
      assert.equal(still.controllerId, held.controllerId, "nor replace the lease they are holding");
    } finally {
      ctx.browsers.releaseControl(id);
    }
  });

  it("4b. never brings a tab to the front, which is what makes reading under somebody safe", () => {
    // The guarantee lives in an argument passed to the bridge, and a fake Chrome has no bridge
    // to observe it on -- so it is asserted at the only place it can be: every select_page this
    // service sends is explicitly non-foregrounding. chrome-devtools-mcp 1.8.0 calls
    // Page.bringToFront only when the flag is true (node_modules/.../tools/pages.js), so false
    // is a promise the bridge keeps and true would break it.
    const src = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    const calls = [...src.matchAll(/name:\s*"select_page",\s*arguments:\s*\{([^}]*)\}/g)];
    assert.ok(calls.length >= 2, `expected the bind and the tool call sites, found ${calls.length}`);
    for (const c of calls) {
      assert.match(c[1]!, /bringToFront:\s*false/, `select_page must pass bringToFront: false, got: ${c[1]}`);
    }
    // Comments stripped first: the note explaining what the bridge does with a true flag is
    // prose about somebody else's code, not a call this service makes.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.ok(!/bringToFront:\s*true/.test(code), "nothing in this service may foreground a tab");
  });

  it("5. keeps reading while a person is driving, because looking is not a mutation", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-e");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });
    const session = await initSession(ctx, agent.token);
    await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);

    ctx.browsers.acquireControl(id, "human", "admin", { force: true });
    try {
      for (const tool of ["list_pages", "take_snapshot"]) {
        const res = await mcp(ctx, agent.token, tool, {}, session);
        assert.ok(
          reachedBridge(res.text),
          `${tool} must still work under a human lease, got: ${res.text.slice(0, 300)}`,
        );
        assert.ok(!res.text.includes("human_controlling_browser"), `${tool} is not gated by the lease`);
      }
      // But the lease still stops the mutating half, for the reader as for anyone.
      const clicked = await mcp(ctx, agent.token, "click", { uid: "1_1" }, session);
      assert.ok(clicked.text.includes("grant_level_insufficient") || clicked.text.includes("human_controlling"));
    } finally {
      ctx.browsers.releaseControl(id);
    }
  });

  it("6. approving a control request at read gives read, and says so", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-f");
    const out = requestBrowser(ctx.browsers, agent.agent, {
      browserId: id,
      access: "control",
      reason: "wants to click",
    });
    assert.equal(out.state === "pending" && out.access, "control");

    const answered = answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      access: "read",
      untilRevoked: true,
    });
    assert.equal(answered.state, "granted");
    assert.equal(answered.access, "control", "what it asked for is kept");
    assert.equal(answered.granted_access, "read", "and what it got is recorded separately");

    const grant = activeGrant(id, agent.agent.id)!;
    assert.equal(grantAccess(grant), "read", "the downgrade has to reach the grant, not just the record");
    assert.throws(() => ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "control"), /read/);
    ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "read");

    // The agent is told the level it actually holds, both when it binds and when it asks again.
    const session = await initSession(ctx, agent.token);
    const used = await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);
    assert.match(used.text, /"access":"read"/, used.text.slice(0, 400));
    const again = await mcp(ctx, agent.token, "tallylamp_request_browser", { browserId: id }, session);
    assert.match(again.text, /"state":"granted"/, again.text.slice(0, 300));
    assert.match(again.text, /"access":"read"/, again.text.slice(0, 300));
  });

  it("6b. a reader can ask for control, and keeps reading while it waits", () => {
    const { reader: agent, browserId: id } = fresh("daemon-g");
    const first = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: first.state === "pending" ? first.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });

    // The upgrade is a new request, not a lookup of the grant already in hand.
    const up = requestBrowser(ctx.browsers, agent.agent, { browserId: id, access: "control", reason: "needs to click now" });
    assert.equal(up.state, "pending", JSON.stringify(up));
    assert.equal(up.state === "pending" && up.access, "control");
    // And the read grant is untouched while the operator thinks about it.
    assert.equal(grantAccess(activeGrant(id, agent.agent.id)!), "read");
    ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "read");

    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: up.state === "pending" ? up.requestId : "",
      decision: "grant",
      durationSec: 3600,
    });
    assert.equal(grantAccess(activeGrant(id, agent.agent.id)!), "control", "approval replaces the read grant");
    ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "control");
  });

  it("7. an until-revoked grant survives a reaped session; revoking it bites on the next call", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-h");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });
    const grant = activeGrant(id, agent.agent.id)!;
    assert.ok(isPermanent(grant.expires_at), "until-revoked must not carry a real expiry");

    const session = await initSession(ctx, agent.token);
    await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);

    // Idle reaping is the ordinary fate of this daemon's session between polls.
    process.env.TALLYLAMP_MCP_SESSION_IDLE_SEC = "0";
    await ctx.mcp.reapIdleSessions();
    delete process.env.TALLYLAMP_MCP_SESSION_IDLE_SEC;
    assert.ok(activeGrant(id, agent.agent.id), "a grant is not session state");
    // Nor does the lending sweep, which expires requests and grants, touch it.
    sweepLending(ctx.browsers);
    assert.ok(activeGrant(id, agent.agent.id), "and time does not take it away");

    // A brand new session, which is what the client opens after a 404.
    const s2 = await initSession(ctx, agent.token);
    const rebound = await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, s2);
    assert.match(rebound.text, /"access":"read"/, rebound.text.slice(0, 300));

    // Revoked mid-session: the very next call on the session already bound has to fail.
    revokeGrant(ctx.browsers, id, agent.agent.id, adminPrincipal());
    const after = await mcp(ctx, agent.token, "list_pages", {}, s2);
    assert.match(after.text, /unauthorized/, after.text.slice(0, 300));
    assert.ok(!reachedBridge(after.text), "a revoked grant must not still reach the bridge");
  });

  it("7b. a timed grant lapses on its own, and the next call fails the same way", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-i");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      durationSec: 3600,
    });
    const session = await initSession(ctx, agent.token);
    const bound = await mcp(ctx, agent.token, "tallylamp_use_browser", { browserId: id }, session);
    assert.match(bound.text, /"bound":true/);

    getDb()
      .prepare(`UPDATE browser_grants SET expires_at = ? WHERE browser_id = ? AND grantee_id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), id, agent.agent.id);
    const after = await mcp(ctx, agent.token, "list_pages", {}, session);
    assert.match(after.text, /unauthorized/, after.text.slice(0, 300));
  });

  it("8. is a grant on one browser and nothing else, and never permits delete or stop", async () => {
    const { reader: agent, browserId: id } = fresh("daemon-j");
    const other = adminBrowser("operator-other");
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });

    // The other browser is untouched by the grant, at every level.
    for (const kind of ["read", "control", "delete"] as const) {
      assert.throws(
        () => ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(other), kind),
        /owned by another principal/,
        `a grant on one browser must not open ${kind} on another`,
      );
    }
    assert.ok(
      !ctx.browsers.listVisible(agent.agent).some((r) => r.id === other),
      "nor list it",
    );
    const visible = ctx.browsers.listVisible(agent.agent).find((r) => r.id === id);
    assert.ok(visible?.lentToMe, "the granted browser is listed, and marked as not its own");
    assert.equal(visible?.grantAccess, "read", "and carries the level, so it does not try to drive it");

    // Deleting is never a thing a grant does, at either level.
    assert.throws(() => ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "delete"), /another principal/);
    const session = await initSession(ctx, agent.token);
    for (const tool of ["tallylamp_delete_browser", "tallylamp_stop_browser", "tallylamp_save_profile"]) {
      const res = await mcp(ctx, agent.token, tool, { browserId: id }, session);
      assert.match(res.text, /unauthorized/, `${tool}: ${res.text.slice(0, 200)}`);
    }
    // And the browser is still there to prove none of that went through.
    assert.equal(ctx.browsers.row(id).id, id);
  });

  it("9. bounds the asking, so an inbox cannot be flooded by a retry loop", () => {
    const spammer = createAgent({ name: "spammer", scopes: [...DEFAULT_AGENT_SCOPES], maxBrowsers: 2 });
    const ids = [adminBrowser("flood-1"), adminBrowser("flood-2"), adminBrowser("flood-3"), adminBrowser("flood-4")];

    // Re-asking for the same browser is free: it keeps one place in the queue, as promised.
    const a = requestBrowser(ctx.browsers, spammer.agent, { browserId: ids[0]! });
    const b = requestBrowser(ctx.browsers, spammer.agent, { browserId: ids[0]! });
    assert.equal(a.state === "pending" && a.requestId, b.state === "pending" ? b.requestId : "");

    // New ones are not. Somewhere in the next few the agent runs out of rope, and is told
    // clearly rather than being invited back immediately.
    let refusal: Error | null = null;
    for (const id of ids.slice(1)) {
      try {
        requestBrowser(ctx.browsers, spammer.agent, { browserId: id });
      } catch (e) {
        refusal = e as Error;
        break;
      }
    }
    assert.ok(refusal, "an agent must not be able to open an unbounded number of requests");
    assert.match(refusal!.message, /limit|too quickly/i, refusal!.message);
    assert.equal((refusal as { retryable?: boolean }).retryable, false, "a throttle must not invite an immediate retry");
    assert.equal((refusal as { code?: string }).code, "lend_request_throttled");
  });

  it("never hands an operator's browser over on idleness alone, however long it sits", () => {
    const { reader: agent, browserId: id } = fresh("daemon-k");
    // Marked lendable and idle for an hour: every condition the auto-grant rule looks at.
    ctx.browsers.setLendable(id, true, adminPrincipal());
    getDb()
      .prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), id);

    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id });
    assert.equal(out.state, "pending", "a person's browser is handed over by a person, never by a clock");
    sweepLending(ctx.browsers);
    assert.equal(activeGrant(id, agent.agent.id), null, "and the sweep must not do it either");
  });

  it("is not offered up to an agent that merely asked for any browser", () => {
    const { reader: agent } = fresh("daemon-l");
    const mine = adminBrowser("operator-private");
    ctx.browsers.setLendable(mine, true, adminPrincipal());
    const out = requestBrowser(ctx.browsers, agent.agent, { reason: "anything will do" });
    assert.notEqual(
      out.state === "granted" ? out.browserId : out.state === "pending" ? out.browserId : "",
      mine,
      "an operator's browser has to be named; it is never the answer to 'any browser'",
    );
  });

  it("still refuses an agent-owned browser to an agent without browser:borrow", () => {
    const owner = createAgent({ name: "peer-owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend"], maxBrowsers: 3 });
    const asker = createAgent({ name: "peer-asker", scopes: [...DEFAULT_AGENT_SCOPES], maxBrowsers: 3 });
    const peer = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "peer-browser" });
    // Asking the operator needs no scope; asking a peer for its live logins still does.
    assert.throws(() => requestBrowser(ctx.browsers, asker.agent, { browserId: peer.id }), /browser:borrow/);
  });
});

describe("a grant outlives the service that issued it", () => {
  it("7c. is still there after a restart, and still read-only", async () => {
    let ctx = await startTestServer({ keepDataDir: true });
    const dir = ctx.dataDir;
    const agent = createAgent({ name: "survivor", scopes: [...DEFAULT_AGENT_SCOPES], maxBrowsers: 2 });
    const id = ctx.browsers.create({ principal: adminPrincipal(), via: "dashboard", name: "restarted" }).id;
    const out = requestBrowser(ctx.browsers, agent.agent, { browserId: id, reason: "across a deploy" });
    answerRequest(ctx.browsers, adminPrincipal(), {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
      untilRevoked: true,
    });
    await ctx.close();

    // Everything in memory is gone: new managers, new gateway, new sessions. Only the file is
    // the same, which is the whole claim -- a grant is a row, not a session.
    ctx = await startTestServer({ dataDir: dir });
    try {
      const grant = activeGrant(id, agent.agent.id);
      assert.ok(grant, "an until-revoked grant must survive the process that issued it");
      assert.equal(grantAccess(grant!), "read");
      assert.ok(isPermanent(grant!.expires_at));
      ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "read");
      assert.throws(() => ctx.browsers.assertAccess(agent.agent, ctx.browsers.row(id), "control"), /read/);
    } finally {
      await ctx.close();
    }
  });
});
