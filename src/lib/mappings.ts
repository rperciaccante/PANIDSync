import type { Env, ExtractedRecord, Mapping } from "../types";

const nowIso = () => new Date().toISOString();

/**
 * Upsert a batch of extracted records. Keyed on source_ip (PAN maps one IP to
 * one user). When the same IP shows a different user, the user is updated and
 * the row is flagged 'pending' so the next push re-logs-in the correct user.
 * Returns the number of rows that ended up needing a (re)push.
 */
export async function upsertRecords(
  env: Env,
  records: ExtractedRecord[],
): Promise<{ upserted: number; changed: number }> {
  if (records.length === 0) return { upserted: 0, changed: 0 };
  const ts = nowIso();
  let changed = 0;

  const stmts = records.map((r) => {
    const raw = JSON.stringify(r.raw);
    // ON CONFLICT(source_ip): refresh last_seen + identity; if the user changed,
    // reset push_state to 'pending' and reactivate.
    return env.DB.prepare(
      `INSERT INTO mappings
         (source_ip, user_email, user_id, device_id, device_name, session_id,
          dataset, event_time, first_seen, last_seen, push_state, active, raw)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 'pending', 1, ?10)
       ON CONFLICT(source_ip) DO UPDATE SET
         user_id     = excluded.user_id,
         device_id   = excluded.device_id,
         device_name = excluded.device_name,
         session_id  = excluded.session_id,
         dataset     = excluded.dataset,
         event_time  = excluded.event_time,
         last_seen   = excluded.last_seen,
         raw         = excluded.raw,
         active      = 1,
         push_state  = CASE
                         WHEN mappings.user_email IS NOT excluded.user_email
                           THEN 'pending'
                         WHEN mappings.push_state = 'logged_out'
                           THEN 'pending'
                         ELSE mappings.push_state
                       END,
         user_email  = excluded.user_email`,
    ).bind(
      r.sourceIp,
      r.userEmail,
      r.userId,
      r.deviceId,
      r.deviceName,
      r.sessionId,
      r.dataset,
      r.eventTime,
      ts,
      raw,
    );
  });

  await env.DB.batch(stmts);
  // Count of rows currently needing a push (cheap approximation of "changed").
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM mappings WHERE push_state = 'pending'`,
  ).first<{ c: number }>();
  changed = row?.c ?? 0;

  return { upserted: records.length, changed };
}

export async function listMappings(
  env: Env,
  opts: { search?: string; state?: string; limit?: number } = {},
): Promise<Mapping[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.search) {
    where.push(`(user_email LIKE ?${binds.length + 1} OR source_ip LIKE ?${binds.length + 1} OR user_id LIKE ?${binds.length + 1})`);
    binds.push(`%${opts.search}%`);
  }
  if (opts.state && opts.state !== "all") {
    where.push(`push_state = ?${binds.length + 1}`);
    binds.push(opts.state);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const stmt = env.DB.prepare(
    `SELECT * FROM mappings ${clause} ORDER BY last_seen DESC LIMIT ${limit}`,
  ).bind(...binds);
  const res = await stmt.all<Mapping>();
  return res.results ?? [];
}

export async function getMappingsByIds(env: Env, ids: number[]): Promise<Mapping[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  const res = await env.DB.prepare(
    `SELECT * FROM mappings WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<Mapping>();
  return res.results ?? [];
}

/** Rows eligible for a login push: active, have a user, not already pushed. */
export async function getPushable(env: Env, includePushed = false): Promise<Mapping[]> {
  const states = includePushed ? "('pending','pushed','stale')" : "('pending','stale')";
  const res = await env.DB.prepare(
    `SELECT * FROM mappings
      WHERE active = 1 AND user_email IS NOT NULL
        AND push_state IN ${states}
      ORDER BY last_seen DESC`,
  ).all<Mapping>();
  return res.results ?? [];
}

/** Active rows whose last_seen is older than the stale threshold. */
export async function getStale(env: Env, staleAfterMinutes: number): Promise<Mapping[]> {
  if (staleAfterMinutes <= 0) return [];
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT * FROM mappings
      WHERE active = 1 AND push_state = 'pushed' AND last_seen < ?1
      ORDER BY last_seen ASC`,
  )
    .bind(cutoff)
    .all<Mapping>();
  return res.results ?? [];
}

export async function markPushed(
  env: Env,
  ids: number[],
  pushedUsers: Map<number, string>,
  timeoutMinutes: number,
): Promise<void> {
  if (ids.length === 0) return;
  const ts = nowIso();
  const stmts = ids.map((id) =>
    env.DB.prepare(
      `UPDATE mappings
          SET push_state = 'pushed', last_pushed_at = ?1,
              pushed_user = ?2, timeout_minutes = ?3
        WHERE id = ?4`,
    ).bind(ts, pushedUsers.get(id) ?? null, timeoutMinutes, id),
  );
  await env.DB.batch(stmts);
}

export async function markLoggedOut(env: Env, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  await env.DB.prepare(
    `UPDATE mappings
        SET push_state = 'logged_out', active = 0
      WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();
}

export async function countByState(env: Env): Promise<Record<string, number>> {
  const res = await env.DB.prepare(
    `SELECT push_state, COUNT(*) AS c FROM mappings GROUP BY push_state`,
  ).all<{ push_state: string; c: number }>();
  const out: Record<string, number> = { total: 0 };
  for (const r of res.results ?? []) {
    out[r.push_state] = r.c;
    out.total += r.c;
  }
  return out;
}
