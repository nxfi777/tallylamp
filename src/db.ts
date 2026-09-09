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
  revoked_at TEXT,
  expires_at TEXT,
  kind TEXT NOT NULL DEFAULT 'access',
  audience TEXT,
  client_id TEXT,
  grant_id TEXT
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  client_name TEXT,
  client_host TEXT,
  source TEXT NOT NULL DEFAULT 'dcr',
  agent_id TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  audience TEXT,
  grant_id TEXT
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

-- A deliberately small, declarative inventory of the sites a browser profile is expected to
-- be signed into. This never stores cookies or tokens, and a report is not proof: the timestamp
-- tells callers how fresh the last observation was. The origin is canonical and unique per browser.
CREATE TABLE IF NOT EXISTS browser_site_access (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('confirmed', 'expected', 'needs_sign_in')),
  reported_by_type TEXT NOT NULL,
  reported_by_id TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  last_confirmed_at TEXT,
  inherited_from_seed_id TEXT,
  UNIQUE(browser_id, origin)
);

-- Manual removals must survive detector and service restarts.
CREATE TABLE IF NOT EXISTS browser_site_detection_dismissals (
  browser_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY(browser_id, origin)
);

-- The access manifest is frozen with the seed. A clone receives expected, never confirmed,
-- because sites are free to invalidate a copied session even when every profile byte survived.
CREATE TABLE IF NOT EXISTS seed_site_access (
  seed_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK(source_state IN ('confirmed', 'expected', 'needs_sign_in')),
  last_confirmed_at TEXT,
  PRIMARY KEY(seed_id, origin)
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

-- A live permission for one agent to drive a browser it does not own. Deliberately not a
-- column on browsers: lending is many-to-one, always expires, and has to be revocable
-- without touching the browser. A grant is a credential transfer -- the profile carries the
-- logins -- so it is scoped, dated and audited like one.
CREATE TABLE IF NOT EXISTS browser_grants (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(browser_id, grantee_id)
);

-- The queue in front of a grant. A request outlives the turn that made it, so an agent that
-- goes away and comes back is still in line, and one that never comes back expires.
CREATE TABLE IF NOT EXISTS browser_requests (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requester_name TEXT,
  reason TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  eta_sec INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decided_reason TEXT
);

-- A live permission for ONE browser to reach ONE private address, over a socket dialled
-- outward by the machine that address lives on. The egress proxy refuses private
-- destinations by design, so this is the narrow, expiring, revocable exception to that --
-- and the authority is required to be one the proxy would have refused, so a binding can
-- never shadow a public site the profile is logged into.
CREATE TABLE IF NOT EXISTS browser_tunnels (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  connected_at TEXT,
  last_seen_at TEXT,
  bytes_up INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0
);

`;

// Indexes run AFTER migrate(): an index on a column that only the migration adds would
// abort the whole SCHEMA exec on an existing database, and take the process down with it.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_credentials_hash ON credentials(token_hash);
CREATE INDEX IF NOT EXISTS idx_credentials_principal ON credentials(principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_credentials_grant ON credentials(grant_id);
CREATE INDEX IF NOT EXISTS idx_browsers_owner ON browsers(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_browser ON activity_events(browser_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
CREATE INDEX IF NOT EXISTS idx_grants_browser ON browser_grants(browser_id);
CREATE INDEX IF NOT EXISTS idx_grants_grantee ON browser_grants(grantee_id);
CREATE INDEX IF NOT EXISTS idx_requests_browser ON browser_requests(browser_id, state);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON browser_requests(requester_id, state);
CREATE INDEX IF NOT EXISTS idx_tunnels_browser ON browser_tunnels(browser_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tunnels_authority ON browser_tunnels(browser_id, host, port) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_browser_site_access_browser ON browser_site_access(browser_id);
CREATE INDEX IF NOT EXISTS idx_seed_site_access_seed ON seed_site_access(seed_id);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(path.dirname(dbPath()), { recursive: true });
  mkdirSync(path.join(config.dataDir, "profiles"), { recursive: true });
  mkdirSync(path.join(config.dataDir, "downloads"), { recursive: true });
  mkdirSync(path.join(config.dataDir, "seeds"), { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  db.exec(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '5')`);
  db.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
  return db;
}

/** Additive column migrations. Every entry is safe to re-apply: applied only when missing. */
const COLUMN_MIGRATIONS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ["credentials", "expires_at", "TEXT"],
  ["credentials", "kind", "TEXT NOT NULL DEFAULT 'access'"],
  ["credentials", "audience", "TEXT"],
  ["credentials", "client_id", "TEXT"],
  ["credentials", "grant_id", "TEXT"],
  ["oauth_clients", "client_name", "TEXT"],
  ["oauth_clients", "client_host", "TEXT"],
  ["oauth_clients", "source", "TEXT NOT NULL DEFAULT 'dcr'"],
  ["oauth_clients", "agent_id", "TEXT"],
  ["oauth_clients", "fetched_at", "TEXT"],
  ["oauth_codes", "scope", "TEXT"],
  ["oauth_codes", "audience", "TEXT"],
  ["oauth_codes", "grant_id", "TEXT"],
  // Off by default, and deliberately so: `lendable` is the per-browser consent to hand this
  // profile over WITHOUT the owner answering, on the strength of it having gone idle. A
  // browser holding a banking login must never be lent because its owner stopped talking.
  ["browsers", "lendable", "INTEGER NOT NULL DEFAULT 0"],
];

function migrate(database: DatabaseSync): void {
  const seen = new Map<string, Set<string>>();
  for (const [table, column, decl] of COLUMN_MIGRATIONS) {
    let cols = seen.get(table);
    if (!cols) {
      cols = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      seen.set(table, cols);
    }
    if (cols.has(column)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    cols.add(column);
  }
  // Any OAuth token minted by an older build was bound to the admin principal with
  // full scopes and no audience. Those are not recoverable as connector grants.
  database.exec(
    `UPDATE credentials SET revoked_at = COALESCE(revoked_at, datetime('now'))
     WHERE principal_type = 'admin' AND token_prefix LIKE 'tl_oa%'`,
  );
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
  migrate(db);
  db.exec(INDEXES);
  return db;
}
