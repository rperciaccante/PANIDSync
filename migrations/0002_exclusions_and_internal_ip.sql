-- PANIDSync 0002
-- 1) Capture the client's *internal* IP alongside the public source IP.
-- 2) Add an exclusion (bypass) list so known-bad source IPs (e.g. Cloudflare /
--    WARP egress ranges) and known-bad identities never become PAN mappings.

-- Client internal/LAN IP (zero_trust_network_sessions.SourceInternalIP). This is
-- the address a firewall behind the tunnel actually sees in traffic.
ALTER TABLE mappings ADD COLUMN internal_ip TEXT;

CREATE TABLE IF NOT EXISTS exclusions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,               -- 'cidr' (IPv4 or IPv4/len) | 'email'
  value      TEXT NOT NULL,               -- e.g. 104.28.0.0/16 or user@corp.com
  reason     TEXT,                         -- why it's excluded (free text)
  created_at TEXT NOT NULL,
  UNIQUE (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_exclusions_kind ON exclusions (kind);

-- Seed: Cloudflare anycast + WARP egress ranges. Source IPs inside these are
-- Cloudflare infrastructure, never a client's real device IP, so they must not
-- be pushed to a Palo Alto firewall as User-ID mappings.
INSERT OR IGNORE INTO exclusions (kind, value, reason, created_at) VALUES
  ('cidr','104.28.0.0/16','Cloudflare WARP egress','2026-07-10T00:00:00Z'),
  ('cidr','104.16.0.0/13','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','104.24.0.0/14','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','172.64.0.0/13','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','162.158.0.0/15','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','198.41.128.0/17','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','173.245.48.0/20','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','103.21.244.0/22','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','103.22.200.0/22','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','103.31.4.0/22','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','141.101.64.0/18','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','108.162.192.0/18','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','190.93.240.0/20','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','188.114.96.0/20','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','197.234.240.0/22','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','131.0.72.0/22','Cloudflare','2026-07-10T00:00:00Z'),
  ('cidr','0.0.0.0/32','Invalid / unroutable placeholder','2026-07-10T00:00:00Z');
