import type { Env, Mapping, PushResult } from "../types";
import {
  getMappingsByIds,
  getPushable,
  getStale,
  markLoggedOut,
  markPushed,
} from "./mappings";
import {
  buildUidMessage,
  panMapIp,
  panUserName,
  sendUserId,
  type UidEntry,
} from "./pan";

const intVar = (v: string | undefined, dflt: number): number => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
};

async function recordPush(
  env: Env,
  r: PushResult,
  trigger: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_log
       (ts, action, trigger, pan_host, entry_count, ok, status_code,
        request_xml, response_body, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      new Date().toISOString(),
      r.action,
      trigger,
      r.panHost,
      r.entryCount,
      r.ok ? 1 : 0,
      r.statusCode,
      r.requestXml,
      r.responseBody,
      r.error,
    )
    .run();
}

export interface PushSummary {
  loginCount: number;
  logoutCount: number;
  ok: boolean;
  results: PushResult[];
}

/**
 * Push login mappings to PAN.
 * @param ids  when provided, only push these mapping ids; otherwise push all
 *             pushable rows.
 */
export async function pushLogins(
  env: Env,
  opts: { trigger: string; ids?: number[]; includePushed?: boolean; origin?: string | null },
): Promise<PushSummary> {
  const timeout = intVar(env.PAN_TIMEOUT_MINUTES, 60);
  const prefix = env.PAN_USER_PREFIX || "";

  let rows: Mapping[];
  if (opts.ids && opts.ids.length) {
    rows = (await getMappingsByIds(env, opts.ids)).filter(
      (m) => m.active === 1 && (m.user_email || m.user_id),
    );
  } else {
    rows = await getPushable(env, opts.includePushed ?? false);
  }

  if (rows.length === 0) {
    return { loginCount: 0, logoutCount: 0, ok: true, results: [] };
  }

  const pushedUsers = new Map<number, string>();
  const pushedIds: number[] = [];
  const entries: UidEntry[] = [];
  for (const m of rows) {
    const ip = panMapIp(m, env);
    if (!ip) continue; // no usable IP (e.g. internal mode, no internal IP) — skip
    const name = panUserName(m, prefix);
    pushedUsers.set(m.id, name);
    pushedIds.push(m.id);
    entries.push({ name, ip, timeout });
  }

  if (entries.length === 0) {
    return { loginCount: 0, logoutCount: 0, ok: true, results: [] };
  }

  const xml = buildUidMessage({ login: entries });
  const result = await sendUserId(env, xml, "login", opts.origin ?? null);
  await recordPush(env, result, opts.trigger);

  if (result.ok) {
    await markPushed(env, pushedIds, pushedUsers, timeout);
  }

  return {
    loginCount: result.ok ? entries.length : 0,
    logoutCount: 0,
    ok: result.ok,
    results: [result],
  };
}

/** Log out stale mappings (no fresh activity within STALE_AFTER_MINUTES). */
export async function pushStaleLogouts(
  env: Env,
  opts: { trigger: string; origin?: string | null },
): Promise<PushSummary> {
  const staleAfter = intVar(env.STALE_AFTER_MINUTES, 120);
  const rows = await getStale(env, staleAfter);
  if (rows.length === 0) {
    return { loginCount: 0, logoutCount: 0, ok: true, results: [] };
  }

  const prefix = env.PAN_USER_PREFIX || "";
  const logoutIds: number[] = [];
  const entries: UidEntry[] = [];
  for (const m of rows) {
    const ip = panMapIp(m, env);
    if (!ip) continue;
    entries.push({ name: m.pushed_user || panUserName(m, prefix), ip });
    logoutIds.push(m.id);
  }
  if (entries.length === 0) {
    return { loginCount: 0, logoutCount: 0, ok: true, results: [] };
  }

  const xml = buildUidMessage({ logout: entries });
  const result = await sendUserId(env, xml, "logout", opts.origin ?? null);
  await recordPush(env, result, opts.trigger);

  if (result.ok) {
    await markLoggedOut(env, logoutIds);
  }

  return {
    loginCount: 0,
    logoutCount: result.ok ? entries.length : 0,
    ok: result.ok,
    results: [result],
  };
}

/** Explicit logout for chosen mapping ids (manual UI action). */
export async function pushLogoutsByIds(
  env: Env,
  opts: { trigger: string; ids: number[]; origin?: string | null },
): Promise<PushSummary> {
  const rows = await getMappingsByIds(env, opts.ids);
  const prefix = env.PAN_USER_PREFIX || "";
  const logoutIds: number[] = [];
  const entries: UidEntry[] = [];
  for (const m of rows) {
    const ip = panMapIp(m, env);
    if (!ip) continue;
    entries.push({ name: m.pushed_user || panUserName(m, prefix), ip });
    logoutIds.push(m.id);
  }
  if (entries.length === 0) {
    return { loginCount: 0, logoutCount: 0, ok: true, results: [] };
  }
  const xml = buildUidMessage({ logout: entries });
  const result = await sendUserId(env, xml, "logout", opts.origin ?? null);
  await recordPush(env, result, opts.trigger);
  if (result.ok) {
    await markLoggedOut(env, logoutIds);
  }
  return {
    loginCount: 0,
    logoutCount: result.ok ? entries.length : 0,
    ok: result.ok,
    results: [result],
  };
}

/** Cron entry point: push new logins, then expire stale mappings. */
export async function runScheduledPush(env: Env): Promise<PushSummary> {
  const logins = await pushLogins(env, { trigger: "cron" });
  const logouts = await pushStaleLogouts(env, { trigger: "cron" });
  return {
    loginCount: logins.loginCount,
    logoutCount: logouts.logoutCount,
    ok: logins.ok && logouts.ok,
    results: [...logins.results, ...logouts.results],
  };
}
