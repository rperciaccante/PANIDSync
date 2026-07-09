export interface Env {
  // Bindings
  DB: D1Database;
  STATE: KVNamespace;

  // Secrets (wrangler secret put ...)
  LOGPUSH_SECRET?: string;
  PAN_API_KEY?: string;
  DASHBOARD_PASSWORD?: string;

  // Vars (wrangler.jsonc)
  IP_FIELD: string;
  PAN_HOST: string;
  PAN_VSYS: string;
  PAN_TIMEOUT_MINUTES: string;
  PAN_USER_PREFIX: string;
  STALE_AFTER_MINUTES: string;
  MOCK_ENABLED: string;
  ACCESS_ENABLED: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

/** A current IP -> user mapping row. */
export interface Mapping {
  id: number;
  source_ip: string;
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
