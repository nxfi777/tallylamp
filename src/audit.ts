import { getDb, nowIso } from "./db.js";
import { log } from "./log.js";

export function audit(input: {
  actorType: string;
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_events(at, actor_type, actor_id, action, target_type, target_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    input.actorType,
    input.actorId,
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    JSON.stringify(input.detail ?? {}),
  );
  log.info("audit", { action: input.action, actorType: input.actorType, target: input.targetId });
}

export function activity(browserId: string, kind: string, summary: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO activity_events(at, browser_id, kind, summary) VALUES (?, ?, ?, ?)`).run(
    nowIso(),
    browserId,
    kind,
    summary,
  );
  db.prepare(`DELETE FROM activity_events WHERE browser_id = ? AND id NOT IN (
    SELECT id FROM activity_events WHERE browser_id = ? ORDER BY id DESC LIMIT 80
  )`).run(browserId, browserId);
}

export function listActivity(browserId: string, limit = 40) {
  return getDb()
    .prepare(`SELECT at, kind, summary FROM activity_events WHERE browser_id = ? ORDER BY id DESC LIMIT ?`)
    .all(browserId, limit);
}

export function listAudit(limit = 80) {
  return getDb()
    .prepare(
      `SELECT at, actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_events ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}
