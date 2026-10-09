import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, statfs, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { config } from "./config.js";
import { getDb } from "./db.js";
import type { BrowserManager, BrowserRow } from "./browsers.js";
import { Err } from "./errors.js";
import { packArchive, unpackArchive } from "./archive.js";

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const OMIT = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]);
const TRANSIENT = ["control_leases", "sessions", "viewer_tickets", "oauth_codes", "browser_tunnels", "link_pairings", "browser_requests", "browser_guests", "guest_sessions", "deleted_profile_snapshots"];
type Manifest = {
  format: "tallylamp"; version: 1; release: string; platform: string; createdAt: string;
  browsers: Array<{ id: string; name: string; slug: string; kind: string }>;
  profiles: string[];
};
export type ExportOptions = { browsers?: string[]; exclude?: string[] };

function identifiers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10000 || value.some(x => typeof x !== "string" || !ID.test(x))) {
    throw Err.invalid("browser selections must be arrays of browser IDs or slugs");
  }
  return value;
}

function selectBrowsers(options: ExportOptions): BrowserRow[] {
  const rows = getDb().prepare("SELECT * FROM browsers ORDER BY created_at, id").all() as BrowserRow[];
  const resolve = (keys: string[]) => new Set(keys.map(key => {
    const row = rows.find(r => r.id === key || r.slug === key);
    if (!row) throw Err.invalid(`unknown browser: ${key}`);
    return row.id;
  }));
  const include = identifiers(options.browsers);
  const excluded = resolve(identifiers(options.exclude) ?? []);
  const included = include === undefined ? null : resolve(include);
  return rows.filter(r => (!included || included.has(r.id)) && !excluded.has(r.id));
}

/** Check one tree at a time; do not retain a file list or follow links out of storage. */
async function checkTree(dir: string, omitChromeLocks = false): Promise<void> {
  const root = await lstat(dir);
  if (!root.isDirectory()) throw new Error(`expected a data directory: ${dir}`);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (omitChromeLocks && OMIT.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await checkTree(child);
    else if (!entry.isFile()) throw new Error(`cannot export a link or special file: ${child}`);
  }
}

async function prepareTree(source: string, emptyDest: string, required: boolean, omitChromeLocks = false): Promise<string> {
  try {
    const root = await realpath(config.dataDir);
    const actual = await realpath(source);
    const relative = path.relative(root, actual);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("profile path is outside Tallylamp data storage");
    }
    await checkTree(actual, omitChromeLocks);
    return actual;
  } catch (e) {
    if (!required && (e as NodeJS.ErrnoException).code === "ENOENT") { await mkdir(emptyDest); return await realpath(emptyDest); }
    else throw e;
  }
}

/** A gzip tar stream, without duplicating local profile bytes or buffering the archive. */
export async function exportInstance(manager: BrowserManager, output: Writable,
  options: ExportOptions = {}, ready: () => void = () => undefined): Promise<void> {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["browsers", "exclude"].includes(key))) {
    throw Err.invalid("export options must contain only browsers and exclude selections");
  }
  const rows = selectBrowsers(options);
  const abort = new AbortController();
  const disconnected = () => { if (!output.writableFinished) abort.abort(new Error("export download disconnected")); };
  output.once("close", disconnected);
  try { await manager.withExport(rows.filter(r => r.kind !== "linked").map(r => r.id), async () => {
    const stage = await mkdtemp(path.join(config.dataDir, ".export-"));
    try {
      const root = await realpath(config.dataDir);
      const sources: Array<{ source: string; target: string }> = [];
      const bind = (source: string, target: string) => sources.push({ source: path.relative(root, source).split(path.sep).join("/"), target });
      for (const dir of ["profiles", "downloads", "seeds"]) await mkdir(path.join(stage, dir));
      // VACUUM INTO includes committed WAL pages. Copying just the .sqlite file does not.
      const database = path.join(stage, "tallylamp.sqlite");
      getDb().exec(`VACUUM INTO '${database.replaceAll("'", "''")}'`);
      const snapshot = new DatabaseSync(database);
      let profiles: Array<{ id: string; path: string }>;
      try {
        profiles = snapshot.prepare("SELECT id, path FROM seeds ORDER BY id").all() as Array<{ id: string; path: string }>;
        snapshot.exec("CREATE TEMP TABLE exported_browsers(id TEXT PRIMARY KEY)");
        for (const row of rows) snapshot.prepare("INSERT INTO exported_browsers VALUES (?)").run(row.id);
        snapshot.exec("DELETE FROM browsers WHERE id NOT IN (SELECT id FROM exported_browsers)");
        for (const table of ["browser_site_access", "browser_site_detection_dismissals", "activity_events", "browser_grants", "linked_access", "browser_links"]) {
          snapshot.exec(`DELETE FROM ${table} WHERE browser_id NOT IN (SELECT id FROM browsers)`);
        }
        snapshot.exec("UPDATE seeds SET created_from_browser_id = NULL WHERE created_from_browser_id NOT IN (SELECT id FROM browsers)");
        for (const table of TRANSIENT) snapshot.exec(`DELETE FROM ${table}`);
        snapshot.exec("UPDATE browsers SET profile_path = 'profiles/' || id, status = 'stopped'");
        for (const profile of profiles) {
          if (!ID.test(profile.id)) throw new Error("invalid saved profile ID");
          snapshot.prepare("UPDATE seeds SET path = ? WHERE id = ?").run(`seeds/${profile.id}`, profile.id);
        }
        snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
      } finally { snapshot.close(); }
      bind(await realpath(database), "tallylamp.sqlite");
      for (const row of rows) {
        abort.signal.throwIfAborted();
        if (!ID.test(row.id)) throw new Error("invalid browser ID");
        if (row.kind === "linked") continue;
        if (row.worker_id) {
          await manager.workers.copyForExport(row, stage, abort.signal);
          await checkTree(path.join(stage, "profiles", row.id), true);
          await checkTree(path.join(stage, "downloads", row.id));
          for (const prefix of ["profiles", "downloads"]) bind(await realpath(path.join(stage, prefix, row.id)), `${prefix}/${row.id}`);
        } else {
          // An untouched browser can legitimately have no profile yet.
          bind(await prepareTree(row.profile_path, path.join(stage, "profiles", row.id), Boolean(row.chrome_version || row.last_activity_at), true), `profiles/${row.id}`);
          bind(await prepareTree(path.join(config.dataDir, "downloads", row.id), path.join(stage, "downloads", row.id), Boolean(row.chrome_version || row.last_activity_at)), `downloads/${row.id}`);
        }
      }
      for (const profile of profiles!) {
        abort.signal.throwIfAborted();
        bind(await prepareTree(profile.path, path.join(stage, "seeds", profile.id), true, true), `seeds/${profile.id}`);
      }
      const manifest: Manifest = {
        format: "tallylamp", version: 1, release: config.release, platform: process.platform,
        createdAt: new Date().toISOString(),
        browsers: rows.map(({ id, name, slug, kind }) => ({ id, name, slug, kind })),
        profiles: profiles!.map(p => p.id),
      };
      await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      bind(await realpath(path.join(stage, "manifest.json")), "manifest.json");
      abort.signal.throwIfAborted();
      ready();
      await packArchive({ root, sources }, output, abort.signal);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }); } finally { output.off("close", disconnected); }
}

function validateManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (!m || m.format !== "tallylamp" || m.version !== 1 || !Array.isArray(m.browsers) || !Array.isArray(m.profiles) ||
      m.browsers.some(b => !b || typeof b.id !== "string" || !ID.test(b.id) || !["managed", "linked"].includes(b.kind)) ||
      m.profiles.some(id => typeof id !== "string" || !ID.test(id)) ||
      new Set(m.browsers.map(b => b.id)).size !== m.browsers.length || new Set(m.profiles).size !== m.profiles.length) {
    throw new Error("unsupported or invalid Tallylamp archive manifest");
  }
  return m;
}

/** Restore offline into a NEW directory, publishing only after all validation succeeds. */
export async function importInstance(archive: string, destination: string,
  maxBytes = 64 * 1024 ** 3): Promise<Manifest> {
  const dest = path.resolve(destination);
  try { await lstat(dest); throw new Error("import destination already exists; choose a new data directory"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maximum import size must be a positive number of bytes");
  await mkdir(path.dirname(dest), { recursive: true });
  const disk = await statfs(path.dirname(dest));
  const limit = Math.min(maxBytes, Math.max(0, disk.bavail * disk.bsize - 256 * 1024 ** 2));
  const stage = await mkdtemp(path.join(path.dirname(dest), ".tallylamp-import-"));
  try {
    await unpackArchive({ file: path.resolve(archive), cwd: stage, roots: ["profiles", "downloads", "seeds"],
      files: ["manifest.json", "tallylamp.sqlite"], maxBytes: limit });
    const manifestFile = path.join(stage, "manifest.json");
    if ((await lstat(manifestFile)).size > 1024 * 1024) throw new Error("archive manifest is too large");
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")));
    for (const prefix of ["profiles", "downloads", "seeds"]) {
      const expected = new Set(prefix === "seeds" ? manifest.profiles : manifest.browsers.filter(b => b.kind === "managed").map(b => b.id));
      const actual = await readdir(path.join(stage, prefix)).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" && expected.size === 0) return [];
        throw e;
      });
      if (actual.length !== expected.size || actual.some(id => !expected.has(id))) throw new Error("archive storage does not match its manifest");
    }
    for (const b of manifest.browsers) {
      if (b.kind === "linked") continue;
      for (const prefix of ["profiles", "downloads"]) {
        if (!(await lstat(path.join(stage, prefix, b.id))).isDirectory()) throw new Error("archive is missing browser data");
      }
    }
    for (const id of manifest.profiles) {
      if (!(await lstat(path.join(stage, "seeds", id))).isDirectory()) throw new Error("archive is missing a saved profile");
    }
    const database = new DatabaseSync(path.join(stage, "tallylamp.sqlite"));
    try {
      const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("archive database is corrupt");
      const version = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (version?.value !== "7") throw new Error("unsupported archive database version");
      const browserIds = database.prepare("SELECT id, kind FROM browsers ORDER BY id").all();
      const profileIds = database.prepare("SELECT id FROM seeds ORDER BY id").all();
      const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (JSON.stringify(browserIds) !== JSON.stringify(manifest.browsers.map(({ id, kind }) => ({ id, kind })).sort(byId)) ||
          JSON.stringify(profileIds) !== JSON.stringify(manifest.profiles.map(id => ({ id })).sort(byId))) {
        throw new Error("archive database does not match its manifest");
      }
      database.exec("BEGIN IMMEDIATE");
      for (const b of manifest.browsers) database.prepare("UPDATE browsers SET profile_path = ?, worker_id = NULL, status = 'stopped', launch_threads = NULL, peak_threads = NULL WHERE id = ?")
        .run(path.join(dest, "profiles", b.id), b.id);
      for (const id of manifest.profiles) database.prepare("UPDATE seeds SET path = ? WHERE id = ?").run(path.join(dest, "seeds", id), id);
      database.exec("UPDATE browser_site_access SET state = 'expected' WHERE state = 'confirmed'");
      for (const table of [...TRANSIENT, "workers", "worker_join_tokens"]) database.exec(`DELETE FROM ${table}`);
      // OAuth grants are bound to the old URL. Raw agent tokens and standing permissions survive.
      database.exec("DELETE FROM credentials WHERE grant_id IS NOT NULL; DELETE FROM oauth_clients; DELETE FROM meta WHERE key = 'admin_secret_hash';");
      database.prepare("UPDATE browser_links SET token_hash = NULL, connected_at = NULL, revoked_at = ?").run(new Date().toISOString());
      database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    } finally { database.close(); }
    // Refuse overwrites even if another process created the destination while we unpacked.
    await mkdir(dest, { mode: 0o700 });
    try { await rename(stage, dest); }
    catch (e) { await rmdir(dest); throw e; }
    return manifest;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
