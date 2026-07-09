import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Optional Cloudflare Access JWT verification. This is belt-and-suspenders on
 * top of a zone-level Access application (the recommended primary gate). Enable
 * by setting ACCESS_ENABLED=true plus ACCESS_TEAM_DOMAIN and ACCESS_AUD.
 *
 * Verifies the RS256 signature of the Cf-Access-Jwt-Assertion token against the
 * team's public keys, and checks issuer + audience.
 */

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const base = teamDomain.startsWith("http")
    ? teamDomain.replace(/\/$/, "")
    : `https://${teamDomain}`;
  const url = `${base}/cdn-cgi/access/certs`;
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { keys: Jwk[] };
  jwksCache.set(url, { keys: data.keys, fetchedAt: Date.now() });
  return data.keys;
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return { ok: false, error: "malformed token" };
    const header = JSON.parse(b64urlToString(h)) as { kid: string; alg: string };
    const payload = JSON.parse(b64urlToString(p)) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      email?: string;
    };

    if (payload.exp && Date.now() / 1000 > payload.exp)
      return { ok: false, error: "token expired" };

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return { ok: false, error: "aud mismatch" };

    const keys = await getJwks(teamDomain);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, error: "unknown kid" };

    const key = await importKey(jwk);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return { ok: false, error: "bad signature" };
    return { ok: true, email: payload.email };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hono middleware. No-op unless ACCESS_ENABLED=true and vars are set. */
export function accessGuard() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const env = c.env;
    if ((env.ACCESS_ENABLED || "").toLowerCase() !== "true") return next();
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return next();

    const token =
      c.req.header("cf-access-jwt-assertion") ||
      (c.req.header("cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];

    if (!token) return c.json({ error: "Cloudflare Access token missing" }, 401);

    const res = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    if (!res.ok) return c.json({ error: `Access denied: ${res.error}` }, 403);
    c.set("accessEmail" as never, res.email as never);
    return next();
  };
}
