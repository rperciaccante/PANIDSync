-- PANIDSync initial schema
-- One row per current IP -> user mapping (PAN User-ID: an IP maps to one user).

CREATE TABLE IF NOT EXISTS mappings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ip       TEXT NOT NULL UNIQUE,       -- client IP seen in the Logpush record
  user_email      TEXT,                       -- authenticated user email
  user_id         TEXT,                       -- Cloudflare UserID/UserUID if present
  device_id       TEXT,
  device_name     TEXT,
  session_id      TEXT,
  dataset         TEXT,                       -- source Logpush dataset name
  event_time      TEXT,                       -- Timestamp from the log record (ISO)
  first_seen      TEXT NOT NULL,              -- first time we saw this IP->user (ISO)
  last_seen       TEXT NOT NULL,              -- most recent Logpush activity (ISO)
  pushed_user     TEXT,                       -- exact name last sent to PAN
  push_state      TEXT NOT NULL DEFAULT 'pending', -- pending | pushed | stale | logged_out
  last_pushed_at  TEXT,                       -- ISO of last successful PAN push
  timeout_minutes INTEGER,                    -- timeout used on last push
  active          INTEGER NOT NULL DEFAULT 1, -- 1 = eligible for login push, 0 = logged out
  raw             TEXT                         -- JSON of the source record (debug)
);

CREATE INDEX IF NOT EXISTS idx_mappings_user_email ON mappings (user_email);
CREATE INDEX IF NOT EXISTS idx_mappings_push_state ON mappings (push_state);
CREATE INDEX IF NOT EXISTS idx_mappings_last_seen  ON mappings (last_seen);
CREATE INDEX IF NOT EXISTS idx_mappings_active     ON mappings (active);

-- Audit trail of every push (login/logout) sent to PAN.
CREATE TABLE IF NOT EXISTS push_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,                -- ISO time of the push attempt
  action        TEXT NOT NULL,               -- login | logout | login+logout
  trigger       TEXT NOT NULL,               -- manual | cron | api
  pan_host      TEXT,
  entry_count   INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 0,   -- 1 success, 0 failure
  status_code   INTEGER,
  request_xml   TEXT,                          -- the uid-message sent
  response_body TEXT,                          -- raw PAN (or mock) response
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_log_ts ON push_log (ts);
