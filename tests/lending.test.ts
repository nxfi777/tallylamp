import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import {
  requestBrowser,
  answerRequest,
  activeGrant,
  revokeGrant,
  sweepLending,
  inbox,
  candidates,
} from "../src/lending.js";
import { getDb } from "../src/db.js";

describe("lending a browser between agents", () => {
  let ctx: TestCtx;
  let owner: ReturnType<typeof createAgent>;
  let borrower: ReturnType<typeof createAgent>;

  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  /** A fresh pair of agents and a browser the first one owns, per test. */
  const setup = (opts?: { ownerScopes?: string[]; borrowerScopes?: string[]; lendable?: boolean }) => {
    owner = createAgent({
      name: "owner",
      scopes: opts?.ownerScopes ?? [...DEFAULT_AGENT_SCOPES, "browser:lend"],
      maxBrowsers: 5,
    });
    borrower = createAgent({
      name: "borrower",
      scopes: opts?.borrowerScopes ?? [...DEFAULT_AGENT_SCOPES, "browser:borrow"],
      maxBrowsers: 5,
    });
    const row = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: `lend-${Math.abs(Date.now() % 99999)}` });
    if (opts?.lendable) ctx.browsers.setLendable(row.id, true, owner.agent);
    return ctx.browsers.row(row.id);
  };

  it("refuses an agent that was never granted browser:borrow", () => {
    const row = setup({ borrowerScopes: [...DEFAULT_AGENT_SCOPES] });
    assert.throws(
      () => requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id }),
      /browser:borrow/,
      "borrowing is a credential transfer; it must not come with the default scopes",
    );
  });

  it("queues a request against a browser its owner has not opted in, and grants nothing meanwhile", () => {
    const row = setup();
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id, reason: "need the login" });
    assert.equal(out.state, "pending");
    assert.equal(activeGrant(row.id, borrower.agent.id), null, "a pending request is not access");
    assert.throws(
      () => ctx.browsers.assertAccess(borrower.agent, row, "control"),
      /owned by another principal/,
      "ownership must still refuse while the request is only pending",
    );
  });

  it("asking twice keeps one place in the queue rather than flooding the owner", () => {
    const row = setup();
    const a = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    const b = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    assert.equal(a.state, "pending");
    assert.equal(b.state, "pending");
    assert.equal(
      a.state === "pending" && b.state === "pending" && a.requestId,
      b.state === "pending" ? b.requestId : "",
      "a retry must reuse the outstanding request",
    );
    assert.equal(inbox(ctx.browsers, owner.agent).filter((r) => r.browser_id === row.id).length, 1);
  });

  it("grants on the owner's answer, and the loan drives but cannot delete", () => {
    const row = setup();
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    assert.equal(out.state, "pending");
    const answered = answerRequest(ctx.browsers, owner.agent, {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
    });
    assert.equal(answered.state, "granted");
    // Driving is exactly what a loan is for.
    ctx.browsers.assertAccess(borrower.agent, ctx.browsers.row(row.id), "control");
    ctx.browsers.assertAccess(borrower.agent, ctx.browsers.row(row.id), "read");
    // Deleting is not: the profile, and every login in it, still belongs to the owner.
    assert.throws(
      () => ctx.browsers.assertAccess(borrower.agent, ctx.browsers.row(row.id), "delete"),
      /owned by another principal/,
      "a borrower must never be able to delete the profile it was lent",
    );
    assert.throws(
      () => ctx.browsers.updateName(row.id, "Borrower renamed this", borrower.agent),
      /owned by another principal/,
      "a borrower may drive the profile but must not rename the owner's resource",
    );
    assert.ok(
      ctx.browsers.listVisible(borrower.agent).some((r) => r.id === row.id && r.lentToMe),
      "a borrowed browser must be listed, and marked as borrowed",
    );
  });

  it("an owner without browser:lend cannot grant, however willing", () => {
    const row = setup({ ownerScopes: [...DEFAULT_AGENT_SCOPES] });
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    assert.throws(
      () => answerRequest(ctx.browsers, owner.agent, { requestId: out.state === "pending" ? out.requestId : "", decision: "grant" }),
      /browser:lend/,
    );
  });

  it("hands an idle lendable browser over with nobody answering, which is what covers a crashed owner", () => {
    const row = setup({ lendable: true });
    // Never started, so it has been idle since it was created -- the same state a crashed
    // owner's browser reaches on its own. No answer from the owner is involved here at all.
    getDb()
      .prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), row.id);
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id, reason: "owner went quiet" });
    assert.equal(out.state, "granted", "an idle opted-in browser must not need an answer");
    assert.ok(activeGrant(row.id, borrower.agent.id));
  });

  it("does not hand over an idle browser its owner never opted in", () => {
    const row = setup({ lendable: false });
    getDb()
      .prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), row.id);
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    assert.equal(out.state, "pending", "idleness alone must not lend a profile nobody offered");
    sweepLending(ctx.browsers);
    assert.equal(activeGrant(row.id, borrower.agent.id), null, "and the sweep must not either");
  });

  it("never queues behind a human, because a takeover is exclusive", () => {
    const row = setup({ lendable: true });
    ctx.browsers.acquireControl(row.id, "human", "admin", { force: true });
    try {
      const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
      assert.equal(out.state, "unavailable");
      assert.match(out.state === "unavailable" ? out.reason : "", /human/);
    } finally {
      ctx.browsers.releaseControl(row.id);
    }
  });

  it("revoking takes the browser back at once", () => {
    const row = setup();
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    answerRequest(ctx.browsers, owner.agent, {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "grant",
    });
    ctx.browsers.assertAccess(borrower.agent, ctx.browsers.row(row.id), "control");
    revokeGrant(ctx.browsers, row.id, borrower.agent.id, owner.agent);
    assert.equal(activeGrant(row.id, borrower.agent.id), null);
    assert.throws(() => ctx.browsers.assertAccess(borrower.agent, ctx.browsers.row(row.id), "control"));
  });

  it("expires a request nobody ever answered instead of leaving it queued forever", () => {
    const row = setup();
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    const id = out.state === "pending" ? out.requestId : "";
    getDb()
      .prepare(`UPDATE browser_requests SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), id);
    sweepLending(ctx.browsers);
    const after = getDb().prepare(`SELECT state FROM browser_requests WHERE id = ?`).get(id) as { state: string };
    assert.equal(after.state, "expired");
    assert.equal(inbox(ctx.browsers, owner.agent).filter((r) => r.id === id).length, 0);
  });

  it("a denial carries the owner's own eta, which is the one estimate it knows best", () => {
    const row = setup();
    const out = requestBrowser(ctx.browsers, borrower.agent, { browserId: row.id });
    const denied = answerRequest(ctx.browsers, owner.agent, {
      requestId: out.state === "pending" ? out.requestId : "",
      decision: "deny",
      etaSec: 300,
      reason: "mid checkout",
    });
    assert.equal(denied.state, "denied");
    assert.equal(denied.eta_sec, 300);
    assert.equal(activeGrant(row.id, borrower.agent.id), null);
  });
});

describe("the owner's inbox rides back on its own tool calls", () => {
  let ctx: TestCtx;
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("appends pending requests to a tool result, because an idle agent cannot be woken", async () => {
    const mcpCall = async (name: string, args: Record<string, unknown>, token: string, session?: string) =>
      json(`${ctx.url}/mcp`, {
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

    const ownerAgent = createAgent({ name: "inbox-owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend"], maxBrowsers: 3 });
    const askerAgent = createAgent({ name: "inbox-asker", scopes: [...DEFAULT_AGENT_SCOPES, "browser:borrow"], maxBrowsers: 3 });

    const init = await json(`${ctx.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    const session = init.headers.get("mcp-session-id")!;
    const created = await mcpCall("tallylamp_create_browser", { name: "inboxed" }, ownerAgent.token, session);
    const raw = typeof created.body === "string" ? created.body : JSON.stringify(created.body);
    const browserId = raw.match(/browserId\\?":\\?"([a-f0-9]+)/)?.[1] ?? "";
    assert.ok(browserId, raw.slice(0, 300));

    requestBrowser(ctx.browsers, askerAgent.agent, { browserId, reason: "the shared login" });

    // Any tool call is the moment the owner is reachable -- the same wrapper covers the
    // forwarded chrome-devtools tools, which a fake Chrome has no bridge child to serve.
    const drove = await mcpCall("tallylamp_list_browsers", {}, ownerAgent.token, session);
    const text = typeof drove.body === "string" ? drove.body : JSON.stringify(drove.body);
    assert.match(text, /asking to borrow this browser/, text.slice(0, 500));
    assert.match(text, /inbox-asker/, "the note must name who is asking");
    assert.match(text, /the shared login/, "and why");
  });
});

describe("asking for any browser rather than a named one", () => {
  let ctx: TestCtx;
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => ctx.close());

  it("ranks every candidate but asks exactly one, so a fan-out cannot land several Chromes", () => {
    const owner = createAgent({ name: "fan-owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend"], maxBrowsers: 9 });
    const asker = createAgent({ name: "fan-asker", scopes: [...DEFAULT_AGENT_SCOPES, "browser:borrow"], maxBrowsers: 9 });

    const busy = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "fan-busy" });
    const idle = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "fan-idle" });
    const taken = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "fan-taken" });
    ctx.browsers.setLendable(idle.id, true, owner.agent);
    getDb().prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`).run(new Date().toISOString(), busy.id);
    getDb()
      .prepare(`UPDATE browsers SET last_activity_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), idle.id);
    // A browser a person is driving is not a queue to join, so it must not even be ranked.
    ctx.browsers.acquireControl(taken.id, "human", "admin", { force: true });

    try {
      const ranked = candidates(ctx.browsers, asker.agent).map((r) => r.id);
      assert.ok(!ranked.includes(taken.id), "a human-controlled browser must never be a candidate");
      assert.equal(ranked[0], idle.id, "the longest-idle opted-in browser must rank first");

      const out = requestBrowser(ctx.browsers, asker.agent, { reason: "any will do" });
      assert.equal(out.state, "granted", "the best candidate was idle and opted in, so no answer was needed");
      assert.equal(out.state === "granted" ? out.browserId : "", idle.id);
      // Exactly one grant: asking everybody would have handed over more than was asked for.
      assert.equal(activeGrant(busy.id, asker.agent.id), null);
      assert.equal(activeGrant(taken.id, asker.agent.id), null);
    } finally {
      ctx.browsers.releaseControl(taken.id);
    }
  });
});
