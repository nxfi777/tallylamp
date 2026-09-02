import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config, dbPath } from "./config.js";

let db: DatabaseSync | undefined;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  scopes_json TEXT NOT NULL,
  max_browsers INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS browsers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  created_via TEXT NOT NULL,
  created_at TEXT NOT NULL,
  persistent INTEGER NOT NULL DEFAULT 1,
  ephemeral_ttl_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'stopped',
  profile_path TEXT NOT NULL,
  seed_id TEXT,
  current_url TEXT,
  current_title TEXT,
  chrome_version TEXT,
  sandbox_status TEXT,
  gpu_status TEXT,
  last_activity_at TEXT,
  client_name TEXT,
  client_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  labels_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS control_leases (
  browser_id TEXT PRIMARY KEY,
  controller_type TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  forced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS viewer_tickets (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_from_browser_id TEXT,
  created_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  browser_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credentials_hash ON credentials(token_hash);
CREATE INDEX IF NOT EXISTS idx_browsers_owner ON browsers(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_browser ON activity_events(browser_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(path.dirname(dbPath()), { recursive: true });
  mkdirSync(path.join(config.dataDir, "profiles"), { recursive: true });
  mkdirSync(path.join(config.dataDir, "downloads"), { recursive: true });
  mkdirSync(path.join(config.dataDir, "seeds"), { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec(SCHEMA);
  db.exec(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')`);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function resetDbForTests(file = ":memory:"): DatabaseSync {
  db?.close();
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
