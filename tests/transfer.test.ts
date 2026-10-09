import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable } from "node:stream";
import * as tar from "tar";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { getDb } from "../src/db.js";
import { exportInstance, importInstance } from "../src/transfer.js";
import { allocatePort } from "../src/chrome.js";
import { startWorker } from "../src/worker.js";
import { reportSiteAccess } from "../src/site-access.js";

const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
let ctx: TestCtx;
let temp: string;
let archive: string;
let browserId: string;
let cloudId: string;
let seedId: string;

describe("portable instance transfer", () => {
  before(async () => {
    ctx = await startTestServer();
    // resetDbForTests initializes the schema without getDb's production version marker.
    getDb().exec("INSERT INTO meta(key, value) VALUES ('schema_version', '7')");
    temp = mkdtempSync(path.join(os.tmpdir(), "tallylamp-transfer-"));
    archive = path.join(temp, "export.tar.gz");
    const local = (await ctx.browsers.create({ principal: admin, via: "control_api", name: "Laptop", workerId: null,
      metadata: { project: "personal", purpose: "Saved sessions" } }));
    const cloud = (await ctx.browsers.create({ principal: admin, via: "control_api", name: "Kraken", workerId: null }));
    browserId = local.id;
    cloudId = cloud.id;
    mkdirSync(path.join(local.profile_path, "Default"), { recursive: true });
    writeFileSync(path.join(local.profile_path, "Default", "Cookies"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(path.join(local.profile_path, "Default", "Preferences"), '{"extensions":{"test":"saved"}}');
    reportSiteAccess(local.id, { origin: "https://example.com", state: "confirmed" }, admin);
    seedId = (await ctx.browsers.snapshotSeed(local.id, "Personal profile", admin)).id;
    const downloads = path.join(ctx.dataDir, "downloads", local.id);
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "report.txt"), "downloaded report");
    linkSync(path.join(downloads, "report.txt"), path.join(downloads, "report-copy.txt"));
    writeFileSync(path.join(downloads, "SingletonLock"), "a real downloaded file");
    symlinkSync("/unavailable/chrome-lock", path.join(local.profile_path, "SingletonLock"));
    await ctx.browsers.ensureRunning(local.id);
    await ctx.browsers.ensureRunning(cloud.id);
  });
  after(async () => { await ctx.close(); rmSync(temp, { recursive: true, force: true }); });

  it("requires an administrator and validates selections before stopping anything", async () => {
    for (const [headers, status] of [[{}, 401], [{ Authorization: `Bearer ${ctx.agentToken}` }, 403]] as const) {
      const r = await json(`${ctx.url}/api/v1/export`, { method: "POST", headers });
      assert.equal(r.status, status);
    }
    for (const body of [{ exclude: ["missing-browser"] }, { browsers: "all" }, { exclude: ["../x"] }]) {
      const r = await json(`${ctx.url}/api/v1/export`, { method: "POST", headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(r.status, 400);
    }
    assert.ok(ctx.browsers.runtime(browserId));
  });

  it("round trips WAL database, profile bytes, saved profiles, downloads and raw agent credentials", async () => {
    const response = await fetch(`${ctx.url}/api/v1/export`, { method: "POST",
      headers: { Cookie: ctx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ exclude: ["kraken"] }) });
    assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve("")));
    assert.equal(response.headers.get("content-type"), "application/gzip");
    assert.equal(response.headers.get("cache-control"), "no-store");
    await pipeline(Readable.fromWeb(response.body!), createWriteStream(archive));
    assert.equal(ctx.browsers.runtime(browserId), undefined);
    assert.ok(ctx.browsers.runtime(cloudId), "excluded Kraken keeps running");
    const dest = path.join(temp, "laptop-data");
    const manifest = await importInstance(archive, dest);
    assert.deepEqual(manifest.browsers.map(b => b.id), [browserId]);
    assert.deepEqual(manifest.profiles, [seedId]);
    const restored = new DatabaseSync(path.join(dest, "tallylamp.sqlite"));
    try {
      const browser = restored.prepare("SELECT * FROM browsers WHERE id = ?").get(browserId)!;
      assert.equal(browser.profile_path, path.join(dest, "profiles", browserId));
      assert.equal(browser.worker_id, null);
      assert.equal(browser.status, "stopped");
      assert.equal(JSON.parse(browser.metadata_json as string).project, "personal");
      const profile = restored.prepare("SELECT path FROM seeds WHERE id = ?").get(seedId)!;
      assert.equal(profile.path, path.join(dest, "seeds", seedId));
      assert.deepEqual(readFileSync(path.join(browser.profile_path as string, "Default", "Cookies")), Buffer.from([0, 1, 2, 255]));
      assert.equal(readFileSync(path.join(profile.path as string, "Default", "Preferences"), "utf8"), '{"extensions":{"test":"saved"}}');
      assert.equal(readFileSync(path.join(dest, "downloads", browserId, "report.txt"), "utf8"), "downloaded report");
      assert.equal(readFileSync(path.join(dest, "downloads", browserId, "report-copy.txt"), "utf8"), "downloaded report");
      assert.equal(readFileSync(path.join(dest, "downloads", browserId, "SingletonLock"), "utf8"), "a real downloaded file");
      assert.equal(restored.prepare("SELECT state FROM browser_site_access WHERE browser_id = ?").get(browserId)!.state, "expected");
      assert.equal(getDb().prepare("SELECT state FROM browser_site_access WHERE browser_id = ?").get(browserId)!.state, "confirmed");
      assert.equal(existsSync(path.join(dest, "profiles", browserId, "SingletonLock")), false);
      assert.equal(restored.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 0);
      assert.equal(restored.prepare("SELECT count(*) AS n FROM workers").get()!.n, 0);
      assert.deepEqual(restored.prepare("SELECT token_hash FROM credentials WHERE grant_id IS NULL ORDER BY id").all(),
        getDb().prepare("SELECT token_hash FROM credentials WHERE grant_id IS NULL ORDER BY id").all());
    } finally { restored.close(); }
    assert.ok(existsSync(path.join(ctx.dataDir, "profiles", browserId, "Default", "Cookies")), "export retains source data");
    assert.ok(!readdirSync(ctx.dataDir).some(name => name.startsWith(".export-")));
  });

  it("blocks concurrent starts, saves and deletion while allowing an excluded browser", async () => {
    await ctx.browsers.withExport([browserId], async () => {
      assert.equal(ctx.browsers.transferInProgress, true);
      await assert.rejects(ctx.browsers.ensureRunning(browserId), /export/);
      await assert.rejects(ctx.browsers.snapshotSeed(browserId, "busy", admin), /export/);
      await assert.rejects(ctx.browsers.destroy(browserId, admin), /export/);
      await assert.rejects(ctx.browsers.withExport([], async () => undefined), /export/);
      assert.ok(await ctx.browsers.ensureRunning(cloudId));
    });
    assert.equal(ctx.browsers.transferInProgress, false);
  });

  it("refuses an existing destination without changing its contents", async () => {
    const dest = path.join(temp, "existing");
    mkdirSync(dest);
    writeFileSync(path.join(dest, "keep"), "original");
    await assert.rejects(importInstance(archive, dest), /already exists/);
    assert.equal(readFileSync(path.join(dest, "keep"), "utf8"), "original");
  });

  it("rejects corrupt archives and decompressed sizes above the limit without publishing", async () => {
    const broken = path.join(temp, "truncated.tar.gz");
    const bytes = readFileSync(archive);
    writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));
    for (const [file, max, name] of [[broken, 1024 ** 3, "broken"], [archive, 1, "oversized"]] as const) {
      const dest = path.join(temp, name);
      await assert.rejects(importInstance(file, dest, max));
      assert.equal(existsSync(dest), false);
    }
    assert.ok(!readdirSync(temp).some(name => name.startsWith(".tallylamp-import-")));
  });

  it("rejects symlinks and traversal paths in uploaded archives", async () => {
    const source = path.join(temp, "unsafe");
    mkdirSync(source);
    writeFileSync(path.join(source, "regular"), "must not escape");
    symlinkSync("../outside", path.join(source, "link"));
    for (const file of ["link", "regular"]) {
      const packed = path.join(temp, `${file}.tar.gz`);
      await tar.c({ file: packed, cwd: source, gzip: true, onWriteEntry: entry => { entry.path = file === "regular" ? "../outside" : "profiles/browser/link"; } }, [file]);
      const dest = path.join(temp, `unsafe-${file}`);
      await assert.rejects(importInstance(packed, dest), /unsafe/);
      assert.equal(existsSync(dest), false);
      assert.equal(existsSync(path.join(temp, "outside")), false);
    }
  });

  it("reports missing saved profile data and releases export locks", async () => {
    const db = getDb();
    const row = db.prepare("SELECT path FROM seeds WHERE id = ?").get(seedId)!;
    db.prepare("UPDATE seeds SET path = ? WHERE id = ?").run(path.join(ctx.dataDir, "seeds", "missing"), seedId);
    const output = new PassThrough();
    try { await assert.rejects(exportInstance(ctx.browsers, output), /ENOENT/); }
    finally { db.prepare("UPDATE seeds SET path = ? WHERE id = ?").run(row.path!, seedId); }
    output.destroy();
    assert.equal(ctx.browsers.transferInProgress, false);
    assert.ok(!readdirSync(ctx.dataDir).some(name => name.startsWith(".export-")));
  });

  it("cleans up and releases locks when the download disconnects", async () => {
    const output = new PassThrough();
    await assert.rejects(exportInstance(ctx.browsers, output, { browsers: [browserId] }, () => output.destroy()));
    assert.equal(ctx.browsers.transferInProgress, false);
    assert.ok(!readdirSync(ctx.dataDir).some(name => name.startsWith(".export-")));
  });

  it("terminates an active archive writer before removing its staging data", async () => {
    const fixture = path.join(ctx.dataDir, "profiles", browserId, "large-fixture");
    writeFileSync(fixture, "sparse fixture");
    truncateSync(fixture, 64 * 1024 ** 2);
    const output = new PassThrough();
    output.once("data", () => output.destroy());
    try { await assert.rejects(exportInstance(ctx.browsers, output, { browsers: [browserId] })); }
    finally { rmSync(fixture); }
    assert.equal(ctx.browsers.transferInProgress, false);
    assert.ok(!readdirSync(ctx.dataDir).some(name => name.startsWith(".export-")));
  });

  it("includes worker profiles and downloads without deleting their source", async () => {
    const workerDir = path.join(temp, "worker");
    mkdirSync(workerDir);
    const port = await allocatePort();
    const worker = await startWorker({ dataDir: workerDir, host: "127.0.0.1", port,
      join: ctx.browsers.workers.createJoinToken(admin).token, selfUrl: `http://127.0.0.1:${port}`, name: "remote" });
    try {
      await ctx.browsers.workers.poll();
      const browser = (await ctx.browsers.create({ principal: admin, via: "control_api", name: "Worker browser", workerId: worker.identity.workerId }));
      await ctx.browsers.ensureRunning(browser.id);
      const profile = path.join(workerDir, "profiles", browser.id);
      const downloads = path.join(workerDir, "downloads", browser.id);
      mkdirSync(profile, { recursive: true });
      mkdirSync(downloads, { recursive: true });
      writeFileSync(path.join(profile, "worker-cookie"), "remote session");
      writeFileSync(path.join(downloads, "remote.txt"), "remote download");
      const packed = path.join(temp, "worker.tar.gz");
      await exportInstance(ctx.browsers, createWriteStream(packed), { browsers: [browser.id] });
      const dest = path.join(temp, "restored-worker");
      await importInstance(packed, dest);
      assert.equal(readFileSync(path.join(dest, "profiles", browser.id, "worker-cookie"), "utf8"), "remote session");
      assert.equal(readFileSync(path.join(dest, "downloads", browser.id, "remote.txt"), "utf8"), "remote download");
      assert.ok(existsSync(path.join(profile, "worker-cookie")));
      assert.ok(existsSync(path.join(downloads, "remote.txt")));
    } finally { await worker.close(); }
  });
});
