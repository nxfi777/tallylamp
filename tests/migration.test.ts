import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetDbForTests, closeDb } from "../src/db.js";

/**
 * The shape of `credentials` and `oauth_clients` before the connector-grant work. A real
 * upgrade opens a database that looks exactly like this.
 */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '{}',
  scopes_json TEXT NOT NULL, max_browsers INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL, resource TEXT, principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '2');
`;

let dir: string;
let file: string;

describe("upgrading an existing database", () => {
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tallylamp-migrate-"));
    file = path.join(dir, "tallylamp.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_SCHEMA);
    // A live dashboard agent token, and a legacy OAuth token bound to the admin principal.
    legacy
      .prepare(`INSERT INTO credentials(id, principal_type, principal_id, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("c1", "agent", "agt_live", "hash-agent", "tl_ag_abcd", new Date().toISOString());
    legacy
      .prepare(`INSERT INTO credentials(id, principal_type, principal_id, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("c2", "admin", "admin", "hash-legacy-oauth", "tl_oa_wxyz", new Date().toISOString());
    legacy.close();
  });
  after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens without throwing", () => {
    // Regression: an index on a column that only the migration adds used to abort the
    // whole schema exec here, taking the process down on every boot after upgrade.
    assert.doesNotThrow(() => resetDbForTests(file));
  });

  it("adds the new columns and indexes", () => {
    const db = resetDbForTests(file);
    const cols = (db.prepare(`PRAGMA table_info(credentials)`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["kind", "audience", "client_id", "grant_id"]) assert.ok(cols.includes(c), `missing ${c}`);
    const idx = (db.prepare(`PRAGMA index_list(credentials)`).all() as Array<{ name: string }>).map((i) => i.name);
    assert.ok(idx.includes("idx_credentials_grant"));
  });

  it("leaves existing dashboard tokens alone", () => {
    const db = resetDbForTests(file);
    const row = db.prepare(`SELECT revoked_at, kind FROM credentials WHERE id = 'c1'`).get() as {
      revoked_at: string | null;
      kind: string;
    };
    assert.equal(row.revoked_at, null, "a live tl_ag_ token must survive the upgrade");
    assert.equal(row.kind, "access");
  });

  it("revokes legacy admin-bound OAuth tokens", () => {
    const db = resetDbForTests(file);
    const row = db.prepare(`SELECT revoked_at FROM credentials WHERE id = 'c2'`).get() as { revoked_at: string | null };
    assert.notEqual(row.revoked_at, null, "an OAuth token minted as admin must not survive");
  });

  it("is idempotent", () => {
    assert.doesNotThrow(() => resetDbForTests(file));
    assert.doesNotThrow(() => resetDbForTests(file));
  });
});
