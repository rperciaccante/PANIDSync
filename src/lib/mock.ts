import type { Env } from "../types";

const KEY = "mock:payloads";
const MAX = 25;

export interface MockCapture {
  ts: string;
  source: string; // "internal" (self:mock) or "http" (external POST)
  method: string;
  query: string;
  headers: Record<string, string>;
  cmd: string; // the decoded uid-message XML
  entries: { action: string; name: string; ip: string; timeout?: string }[];
}

/** Very small, dependency-free extraction of login/logout entries from a
 *  uid-message XML string (enough to display what was received). */
export function summarizeUidMessage(xml: string): MockCapture["entries"] {
  const entries: MockCapture["entries"] = [];
  for (const section of ["login", "logout"]) {
    const secRe = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, "gi");
    let secMatch: RegExpExecArray | null;
    while ((secMatch = secRe.exec(xml))) {
      const body = secMatch[1];
      const entryRe = /<entry\b([^>]*)\/?>/gi;
      let em: RegExpExecArray | null;
      while ((em = entryRe.exec(body))) {
        const attrs = em[1];
        const name = /name="([^"]*)"/i.exec(attrs)?.[1] ?? "";
        const ip = /\bip="([^"]*)"/i.exec(attrs)?.[1] ?? "";
        const timeout = /timeout="([^"]*)"/i.exec(attrs)?.[1];
        entries.push({ action: section, name, ip, ...(timeout ? { timeout } : {}) });
      }
    }
  }
  return entries;
}

export async function storeMockCapture(env: Env, capture: MockCapture): Promise<void> {
  const existing = await getMockCaptures(env);
  existing.unshift(capture);
  const trimmed = existing.slice(0, MAX);
  await env.STATE.put(KEY, JSON.stringify(trimmed));
}

export async function getMockCaptures(env: Env): Promise<MockCapture[]> {
  const raw = await env.STATE.get(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as MockCapture[];
  } catch {
    return [];
  }
}

export async function clearMockCaptures(env: Env): Promise<void> {
  await env.STATE.delete(KEY);
}

/** PAN-shaped success response the real firewall returns for a user-id set. */
export const MOCK_PAN_RESPONSE =
  '<response status="success"><msg><line>User-ID mapping accepted (mock)</line></msg></response>';
