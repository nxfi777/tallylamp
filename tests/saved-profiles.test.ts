import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { json, startTestServer, type TestCtx } from "./helpers.js";
import { reportSiteAccess, listSiteAccess } from "../src/site-access.js";
import { createAgent, DEFAULT_AGENT_SCOPES } from "../src/auth.js";
import { answerRequest, requestBrowser } from "../src/lending.js";

let ctx: TestCtx;
const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
const create = (name: string, seedId?: string) => ctx.browsers.create({ name, seedId, principal: admin, via: "dashboard" });
const marker = (id: string) => path.join(ctx.browsers.row(id).profile_path, "fixture.txt");

describe("reusable saved profiles", () => {
  before(async () => { ctx = await startTestServer(); });
  afterEach(async () => {
    delete process.env.TALLYLAMP_MAX_BROWSERS;
    for (const row of ctx.browsers.list()) if (ctx.browsers.runtime(row.id)) await ctx.browsers.stop(row.id);
  });
  after(async () => ctx.close());

  it("saves a running source, resumes it, and clones independent profiles with metadata and site inventory", async () => {
    const source = create("Source");
    writeFileSync(marker(source.id), "original");
    await ctx.browsers.ensureRunning(source.id);
    reportSiteAccess(source.id, { origin: "https://example.com", state: "confirmed" }, admin);
    const response = await json(`${ctx.url}/api/v1/seeds`, {
      method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: source.id, name: "Reusable research", metadata: { project: "Research", purpose: "References" } }),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const { seed } = response.body as { seed: { id: string; resumed: boolean } };
    assert.equal(seed.resumed, true);
    assert.ok(ctx.browsers.runtime(source.id));
    const first = create("First", seed.id);
    const second = create("Second", seed.id);
    assert.notEqual(first.profile_path, second.profile_path);
    assert.deepEqual(JSON.parse(first.metadata_json), { project: "Research", purpose: "References" });
    assert.equal(first.persistent, 1);
    assert.equal(listSiteAccess(first.id)[0].state, "expected");
    writeFileSync(marker(first.id), "first browser only");
    assert.equal(readFileSync(marker(second.id), "utf8"), "original");
    assert.equal(readFileSync(marker(source.id), "utf8"), "original");
    assert.equal(readFileSync(path.join(ctx.browsers.listSeeds().find(s => s.id === seed.id)!.path, "fixture.txt"), "utf8"), "original");
  });

  it("updating a saved profile changes future copies only and keeps its id", async () => {
    const source = create("Update source");
    writeFileSync(marker(source.id), "v1");
    const saved = await ctx.browsers.snapshotSeed(source.id, "Version one", admin);
    assert.equal(saved.resumed, false);
    assert.equal(ctx.browsers.runtime(source.id), undefined);
    const oldCopy = create("Old copy", saved.id);
    writeFileSync(marker(source.id), "v2");
    const update = await json(`${ctx.url}/api/v1/seeds/${saved.id}`, {
      method: "PUT", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: source.id, name: "Version two", metadata: { project: "Updated" } }),
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal((update.body as { seed: { id: string } }).seed.id, saved.id);
    const newCopy = create("New copy", saved.id);
    assert.equal(readFileSync(marker(oldCopy.id), "utf8"), "v1");
    assert.equal(readFileSync(marker(newCopy.id), "utf8"), "v2");
    assert.deepEqual(JSON.parse(newCopy.metadata_json), { project: "Updated" });
    assert.equal(existsSync(saved.path), false, "old snapshot is cleaned up after publication");
  });

  it("reserves the resume slot, refuses conflicting lifecycle operations, and publishes nothing on copy failure", async () => {
    const source = create("Failure source");
    await ctx.browsers.ensureRunning(source.id);
    process.env.TALLYLAMP_MAX_BROWSERS = "1";
    const before = ctx.browsers.listSeeds().length;
    const manager = ctx.browsers as unknown as { copyProfile: (from: string, to: string) => Promise<void> };
    const original = manager.copyProfile;
    let release!: () => void;
    let entered!: () => void;
    const copying = new Promise<void>(resolve => { entered = resolve; });
    manager.copyProfile = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error("fixture copy failure"); };
    const save = ctx.browsers.snapshotSeed(source.id, "Failed snapshot", admin);
    try {
      await copying;
      await assert.rejects(ctx.browsers.ensureRunning(source.id), /being saved/);
      await assert.rejects(ctx.browsers.stop(source.id), /being saved/);
      await assert.rejects(ctx.browsers.destroy(source.id, admin), /being saved/);
      await assert.rejects(ctx.browsers.snapshotSeed(source.id, "Duplicate", admin), /busy/);
      const intruder = create("Other start");
      await assert.rejects(ctx.browsers.ensureRunning(intruder.id), /fleet is full/);
      release();
      await assert.rejects(save, /fixture copy failure/);
      assert.ok(ctx.browsers.runtime(source.id), "source resumes even when copying fails");
      assert.equal(ctx.browsers.listSeeds().length, before);
    } finally { release?.(); manager.copyProfile = original; }
  });

  it("requires explicit write authorization to publish or overwrite saved authenticated profiles", async () => {
    const source = create("Private source");
    const response = await json(`${ctx.url}/api/v1/seeds`, {
      method: "POST", headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: source.id, name: "Unauthorized" }),
    });
    assert.equal(response.status, 403);
    await assert.rejects(ctx.browsers.snapshotSeed(source.id, "", admin), /profile name/);
    await assert.rejects(ctx.browsers.snapshotSeed(source.id, "Missing", admin, { seedId: "missing" }), /not found/);
  });

  it("lets an authorized agent update a loaded shared profile, but refuses unrelated IDs and human control", async () => {
    const sharedSource = create("Shared source");
    const shared = await ctx.browsers.snapshotSeed(sharedSource.id, "Shared", admin);
    const other = await ctx.browsers.snapshotSeed(sharedSource.id, "Other", admin);
    const writer = createAgent({ name: "Writer", scopes: [...DEFAULT_AGENT_SCOPES, "seed:use", "seed:write"] });
    const loaded = ctx.browsers.create({ principal: writer.agent, via: "mcp", seedId: shared.id });
    const update = await ctx.browsers.saveProfile(loaded.id, writer.agent, { updateOnly: true });
    assert.equal(update.profile.id, shared.id);
    await assert.rejects(ctx.browsers.saveProfile(loaded.id, writer.agent, { profileId: other.id, updateOnly: true }), /only the saved profile linked/);
    ctx.browsers.acquireControl(loaded.id, "human", "admin", true);
    await assert.rejects(ctx.browsers.saveProfile(loaded.id, writer.agent), /human/i);
  });

  it("does not allow an agent to export a borrowed browser, even with profile write permission", async () => {
    const owner = createAgent({ name: "Owner", scopes: [...DEFAULT_AGENT_SCOPES, "browser:lend"] });
    const borrower = createAgent({ name: "Borrower", scopes: [...DEFAULT_AGENT_SCOPES, "browser:borrow", "seed:write"] });
    const source = ctx.browsers.create({ principal: owner.agent, via: "mcp" });
    const pending = requestBrowser(ctx.browsers, borrower.agent, { browserId: source.id });
    assert.equal(pending.state, "pending");
    await answerRequest(ctx.browsers, owner.agent, { requestId: pending.requestId!, decision: "grant" });
    ctx.browsers.assertAccess(borrower.agent, source, "control");
    await assert.rejects(ctx.browsers.saveProfile(source.id, borrower.agent), /borrowed browsers cannot be copied/);
  });
});
