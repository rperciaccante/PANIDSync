import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * In-worker authentication gate for the dashboard + control API.
 *
 * Cloudflare Access can't attach to a *.workers.dev hostname, so when the worker
 * is served on workers.dev this provides a real login gate: a password check
 * that mints a short-lived HMAC-signed cookie. Ingest (`/api/logpush`) and the
 * mock receiver stay open by design (ingest is guarded by LOGPUSH_SECRET).
 *
 * Enabled only when DASHBOARD_PASSWORD is set; otherwise it fails open (so a
 * fresh deploy isn't locked out before the secret is configured).
 */

const COOKIE = "panidsync_session";
const TTL_SECONDS = 12 * 60 * 60; // 12h

const enc = new TextEncoder();

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return bytesToHex(sig);
}

/** Constant-time-ish string compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSession(password: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const sig = await hmac(password, String(exp));
  return `${exp}.${sig}`;
}

export async function verifySession(cookieVal: string, password: string): Promise<boolean> {
  const [expStr, sig] = cookieVal.split(".");
  if (!expStr || !sig) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(password, expStr);
  return safeEqual(sig, expected);
}

function getCookie(c: Context, name: string): string | null {
  const raw = c.req.header("cookie") || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const isSecure = (c: Context): boolean => new URL(c.req.url).protocol === "https:";

export function setSessionCookie(c: Context, value: string): void {
  const secure = isSecure(c) ? " Secure;" : "";
  c.header(
    "set-cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${TTL_SECONDS}`,
  );
}

export function clearSessionCookie(c: Context): void {
  c.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Middleware guarding dashboard + control API. */
export function dashGuard() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const pw = c.env.DASHBOARD_PASSWORD;
    if (!pw) {
      console.warn("[auth] DASHBOARD_PASSWORD not set — dashboard is UNPROTECTED");
      return next();
    }
    const cookie = getCookie(c, COOKIE);
    if (cookie && (await verifySession(cookie, pw))) return next();

    // API routes get a 401; browser routes redirect to the login page.
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) {
      return c.json({ error: "unauthorized — log in at /login" }, 401);
    }
    return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
  };
}

export function loginPageHtml(error?: string, next = "/"): string {
  const err = error
    ? `<p style="color:#f85149;margin:0 0 12px">${error}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · PANIDSync</title>
<style>body{margin:0;background:#0e1116;color:#e6edf3;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;height:100vh}
form{background:#161b22;border:1px solid #2b3441;border-radius:12px;padding:28px 26px;width:300px}
h1{font-size:16px;margin:0 0 4px}.s{color:#8b949e;font-size:12px;margin:0 0 18px}
label{display:block;font-size:12px;color:#8b949e;margin:0 0 6px}
input{width:100%;box-sizing:border-box;background:#1c2430;border:1px solid #2b3441;border-radius:6px;color:#e6edf3;padding:9px 10px;font:inherit}
button{margin-top:14px;width:100%;background:#f38020;border:none;border-radius:6px;color:#111;font-weight:600;padding:10px;font:inherit;cursor:pointer}
.logo{width:10px;height:10px;border-radius:50%;background:#f38020;display:inline-block;margin-right:6px}</style></head>
<body><form method="post" action="/login">
<h1><span class="logo"></span>PANIDSync</h1><p class="s">Sign in to view mappings</p>
${err}
<input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
<label for="p">Password</label>
<input id="p" name="password" type="password" autofocus autocomplete="current-password">
<button type="submit">Sign in</button>
</form></body></html>`;
}
