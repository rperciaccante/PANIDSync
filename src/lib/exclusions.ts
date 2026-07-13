import type { Env } from "../types";

/** A row in the exclusion (bypass) list. */
export interface Exclusion {
  id: number;
  kind: string; // 'cidr' | 'email'
  value: string;
  reason: string | null;
  created_at: string;
}

interface Cidr {
  base: number; // network address (masked), unsigned 32-bit
  mask: number; // unsigned 32-bit netmask
  raw: string;
}

/** Parse a dotted-quad IPv4 string to an unsigned 32-bit int, or null. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/** Parse "a.b.c.d" or "a.b.c.d/len" into a Cidr, or null if invalid. */
export function parseCidr(value: string): Cidr | null {
  const [ip, bitsRaw] = value.trim().split("/");
  const addr = ipv4ToInt(ip);
  if (addr === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (addr & mask) >>> 0, mask, raw: value.trim() };
}

function ipInCidr(ip: number, c: Cidr): boolean {
  return ((ip & c.mask) >>> 0) === c.base;
}

/** In-memory form of the exclusion list, ready for fast matching. */
export interface ExclusionSet {
  cidrs: Cidr[];
  emails: Set<string>;
  domains: string[]; // e.g. "cloudflareaccess.com" matches user@any.cloudflareaccess.com
}

export async function loadExclusions(env: Env): Promise<ExclusionSet> {
  const res = await env.DB.prepare(
    `SELECT kind, value FROM exclusions`,
  ).all<{ kind: string; value: string }>();
  const cidrs: Cidr[] = [];
  const emails = new Set<string>();
  const domains: string[] = [];
  for (const r of res.results ?? []) {
    if (r.kind === "email") {
      emails.add(r.value.trim().toLowerCase());
    } else if (r.kind === "domain") {
      domains.push(r.value.trim().toLowerCase().replace(/^@/, ""));
    } else {
      const c = parseCidr(r.value);
      if (c) cidrs.push(c);
    }
  }
  return { cidrs, emails, domains };
}

/** The domain part of an email, lowercased, or null. */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/** True when this IP or identity should be bypassed (never mapped/pushed). */
export function isExcluded(
  ex: ExclusionSet,
  sourceIp: string | null,
  userEmail: string | null,
): boolean {
  if (userEmail) {
    const e = userEmail.trim().toLowerCase();
    if (ex.emails.has(e)) return true;
    const dom = emailDomain(e);
    if (dom) {
      for (const d of ex.domains) {
        if (dom === d || dom.endsWith("." + d)) return true;
      }
    }
  }
  if (sourceIp) {
    const ip = ipv4ToInt(sourceIp);
    if (ip !== null) {
      for (const c of ex.cidrs) {
        if (ipInCidr(ip, c)) return true;
      }
    }
  }
  return false;
}

export async function listExclusions(env: Env): Promise<Exclusion[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM exclusions ORDER BY kind, value`,
  ).all<Exclusion>();
  return res.results ?? [];
}

/**
 * Add an exclusion and immediately purge any existing mappings it matches
 * (this is how a "known bad identity" gets cleared/hidden). Returns the number
 * of existing mappings removed.
 */
export async function addExclusion(
  env: Env,
  kindRaw: string,
  valueRaw: string,
  reason: string | null,
): Promise<{ purged: number }> {
  const kind =
    kindRaw === "email" ? "email" : kindRaw === "domain" ? "domain" : "cidr";
  let value = valueRaw.trim();
  if (kind === "email") value = value.toLowerCase();
  if (kind === "domain") value = value.toLowerCase().replace(/^@/, "");
  if (!value) throw new Error("value is required");
  if (kind === "cidr" && !parseCidr(value)) {
    throw new Error(`invalid IPv4 address or CIDR: ${value}`);
  }
  if (kind === "email" && !value.includes("@")) {
    throw new Error(`invalid email: ${value}`);
  }
  if (kind === "domain" && (value.includes("@") || !value.includes("."))) {
    throw new Error(`invalid domain: ${value}`);
  }

  await env.DB.prepare(
    `INSERT INTO exclusions (kind, value, reason, created_at)
       VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason`,
  )
    .bind(kind, value, reason, new Date().toISOString())
    .run();

  const purged = await purgeMatching(env, kind, value);
  return { purged };
}

export async function deleteExclusion(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM exclusions WHERE id = ?1`).bind(id).run();
}

/** Delete mappings matching a single exclusion (email exact, or CIDR membership). */
async function purgeMatching(
  env: Env,
  kind: string,
  value: string,
): Promise<number> {
  if (kind === "email") {
    const r = await env.DB.prepare(
      `DELETE FROM mappings WHERE lower(user_email) = ?1`,
    )
      .bind(value.toLowerCase())
      .run();
    return r.meta?.changes ?? 0;
  }

  if (kind === "domain") {
    const d = value.toLowerCase();
    const r = await env.DB.prepare(
      `DELETE FROM mappings
         WHERE lower(user_email) LIKE ?1 OR lower(user_email) LIKE ?2`,
    )
      .bind(`%@${d}`, `%.${d}`)
      .run();
    return r.meta?.changes ?? 0;
  }

  const c = parseCidr(value);
  if (!c) return 0;
  // SQLite has no native CIDR test, so evaluate membership in JS.
  const res = await env.DB.prepare(
    `SELECT id, source_ip FROM mappings`,
  ).all<{ id: number; source_ip: string }>();
  const ids: number[] = [];
  for (const row of res.results ?? []) {
    const ip = ipv4ToInt(row.source_ip);
    if (ip !== null && ipInCidr(ip, c)) ids.push(row.id);
  }
  if (ids.length === 0) return 0;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  const r = await env.DB.prepare(
    `DELETE FROM mappings WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();
  return r.meta?.changes ?? ids.length;
}
