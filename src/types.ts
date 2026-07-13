export interface Env {
  // Bindings
  DB: D1Database;
  STATE: KVNamespace;

  // Secrets (wrangler secret put ...)
  LOGPUSH_SECRET?: string;
  PAN_API_KEY?: string;

  // Cloudflare Access config. ACCESS_TEAM_DOMAIN/ACCESS_AUD are set as secrets
  // (kept out of the public repo) once the Access app exists.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  // Vars (wrangler.jsonc)
  IP_FIELD: string;
  // Which IP is sent to PAN as the User-ID mapping key: "internal" (the
  // client's SourceInternalIP — what a firewall behind the tunnel sees) or
  // "source" (the public source IP). Default "internal".
  PAN_IP_SOURCE: string;
  PAN_HOST: string;
  PAN_VSYS: string;
  PAN_TIMEOUT_MINUTES: string;
  PAN_USER_PREFIX: string;
  STALE_AFTER_MINUTES: string;
  MOCK_ENABLED: string;
  ACCESS_ENABLED: string;
}

/** A current IP -> user mapping row. */
export interface Mapping {
  id: number;
  source_ip: string;
  internal_ip: string | null;
  user_email: string | null;
  user_id: string | null;
  device_id: string | null;
  device_name: string | null;
  session_id: string | null;
  dataset: string | null;
  event_time: string | null;
  first_seen: string;
  last_seen: string;
  pushed_user: string | null;
  push_state: "pending" | "pushed" | "stale" | "logged_out";
  last_pushed_at: string | null;
  timeout_minutes: number | null;
  active: number;
  raw: string | null;
}

/** Normalized fields extracted from a single Logpush record. */
export interface ExtractedRecord {
  sourceIp: string;
  internalIp: string | null;
  userEmail: string | null;
  userId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  sessionId: string | null;
  dataset: string | null;
  eventTime: string | null;
  raw: unknown;
}

export interface PushResult {
  ok: boolean;
  action: string;
  entryCount: number;
  statusCode: number | null;
  requestXml: string;
  responseBody: string;
  error: string | null;
  panHost: string;
}
