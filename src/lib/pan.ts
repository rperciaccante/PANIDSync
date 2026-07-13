import type { Env, Mapping, PushResult } from "../types";
import {
  MOCK_PAN_RESPONSE,
  storeMockCapture,
  summarizeUidMessage,
} from "./mock";

function xmlEscapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Compose the PAN user name from an optional prefix + the mapping identity. */
export function panUserName(m: Mapping, prefix: string): string {
  const base = m.user_email || m.user_id || "unknown";
  return prefix ? `${prefix}${base}` : base;
}

/**
 * The IP to send to PAN for this mapping, per PAN_IP_SOURCE. In "internal" mode
 * (default) this is the client's SourceInternalIP — the address a firewall
 * behind the tunnel actually sees; returns null when no internal IP is known
 * (such rows are skipped rather than pushed with a wrong/public IP).
 */
export function panMapIp(m: Mapping, env: Env): string | null {
  const mode = (env.PAN_IP_SOURCE || "internal").toLowerCase();
  if (mode === "source") return m.source_ip || null;
  return m.internal_ip || null;
}

export interface UidEntry {
  name: string;
  ip: string;
  timeout?: number; // minutes; omit to use firewall default
}

/** Build a PAN-OS <uid-message> for login and/or logout entries. */
export function buildUidMessage(opts: {
  login?: UidEntry[];
  logout?: UidEntry[];
}): string {
  const parts: string[] = ['<uid-message>', '  <type>update</type>', '  <payload>'];

  if (opts.login && opts.login.length) {
    parts.push("    <login>");
    for (const e of opts.login) {
      const t = e.timeout !== undefined ? ` timeout="${e.timeout}"` : "";
      parts.push(
        `      <entry name="${xmlEscapeAttr(e.name)}" ip="${xmlEscapeAttr(e.ip)}"${t}/>`,
      );
    }
    parts.push("    </login>");
  }

  if (opts.logout && opts.logout.length) {
    parts.push("    <logout>");
    for (const e of opts.logout) {
      parts.push(
        `      <entry name="${xmlEscapeAttr(e.name)}" ip="${xmlEscapeAttr(e.ip)}"/>`,
      );
    }
    parts.push("    </logout>");
  }

  parts.push("  </payload>", "</uid-message>");
  return parts.join("\n");
}

/**
 * Send a uid-message to the firewall (or the built-in mock). Never throws;
 * always resolves to a PushResult describing what happened.
 */
export async function sendUserId(
  env: Env,
  xml: string,
  action: string,
  origin: string | null,
): Promise<PushResult> {
  const panHost = env.PAN_HOST || "self:mock";
  const base: Omit<PushResult, "ok" | "statusCode" | "responseBody" | "error"> = {
    action,
    entryCount: (xml.match(/<entry\b/g) || []).length,
    requestXml: xml,
    panHost,
  };

  // ---- Built-in mock path (no external firewall) --------------------------
  if (panHost === "self:mock") {
    await storeMockCapture(env, {
      ts: new Date().toISOString(),
      source: "internal",
      method: "INTERNAL",
      query: `type=user-id&action=set${env.PAN_VSYS ? `&vsys=${env.PAN_VSYS}` : ""}`,
      headers: {},
      cmd: xml,
      entries: summarizeUidMessage(xml),
    });
    return {
      ...base,
      ok: true,
      statusCode: 200,
      responseBody: MOCK_PAN_RESPONSE,
      error: null,
    };
  }

  // ---- Real firewall (or a worker URL acting as the mock) -----------------
  try {
    const url = new URL("/api/", panHost.startsWith("http") ? panHost : `https://${panHost}`);
    url.searchParams.set("type", "user-id");
    url.searchParams.set("action", "set");
    if (env.PAN_VSYS) url.searchParams.set("vsys", env.PAN_VSYS);
    if (env.PAN_API_KEY) url.searchParams.set("key", env.PAN_API_KEY);

    const body = new URLSearchParams();
    body.set("cmd", xml);

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await resp.text();
    const ok = resp.ok && /status="success"/i.test(text);
    return {
      ...base,
      ok,
      statusCode: resp.status,
      responseBody: text,
      error: ok ? null : `PAN returned status=${resp.status}`,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      statusCode: null,
      responseBody: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  void origin;
}
