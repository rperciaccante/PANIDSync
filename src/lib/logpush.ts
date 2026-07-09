import type { ExtractedRecord } from "../types";

/** First non-empty string value found among the candidate keys. */
function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Read a Logpush HTTP batch body. Cloudflare sends newline-delimited JSON,
 * usually gzip-compressed. We decompress when the payload is gzipped (either
 * flagged by Content-Encoding or detected via the gzip magic bytes).
 */
export async function readLogpushBody(req: Request): Promise<string> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length === 0) return "";

  const enc = (req.headers.get("content-encoding") || "").toLowerCase();
  const isGzip = enc.includes("gzip") || (buf[0] === 0x1f && buf[1] === 0x8b);

  if (!isGzip) return new TextDecoder().decode(buf);

  const ds = new DecompressionStream("gzip");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  const text = await new Response(stream).text();
  return text;
}

/** Parse NDJSON (one JSON object per line). Bad lines are skipped. */
export function parseNdjson(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object") out.push(obj as Record<string, unknown>);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Normalize one Logpush record into an ExtractedRecord. Returns null when the
 * record lacks the minimum we need (an IP plus some user identity).
 *
 * Field-name candidates are intentionally broad so the same ingest works for
 * zero_trust_network_sessions, access_requests, and gateway_http.
 */
export function extractRecord(
  obj: Record<string, unknown>,
  ipField: string,
  dataset: string | null,
): ExtractedRecord | null {
  const sourceIp = pick(obj, [
    ipField,
    "SourceIP",     // zero_trust_network_sessions
    "IPAddress",    // access_requests
    "SessionOriginIP",
    "OriginIP",
    "ClientIP",
    "SrcIP",
    "UserIP",
    "source_ip",
  ]);
  const userEmail = pick(obj, [
    "Email",
    "UserEmail",
    "user_email",
    "ActorEmail",
    "Identity",
  ]);
  const userId = pick(obj, ["UserID", "UserUID", "UserId", "user_id"]);

  if (!sourceIp) return null;
  if (!userEmail && !userId) return null;
  // access_requests: skip denied logins — a denied user is not authenticated.
  if (obj.Allowed === false) return null;

  return {
    sourceIp,
    userEmail,
    userId,
    deviceId: pick(obj, ["DeviceID", "DeviceId", "device_id"]),
    deviceName: pick(obj, ["DeviceName", "device_name"]),
    sessionId: pick(obj, ["SessionID", "SessionId", "session_id"]),
    dataset,
    eventTime: pick(obj, [
      "Timestamp",
      "SessionStartTime", // zero_trust_network_sessions
      "CreatedAt",        // access_requests
      "Datetime",
      "EventTimeUTC",
      "timestamp",
    ]),
    raw: obj,
  };
}
