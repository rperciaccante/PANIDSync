-- PANIDSync 0003
-- Seed a domain-suffix exclusion for Cloudflare Access service identities
-- (e.g. warp_connector@<team>.cloudflareaccess.com). These are not real users
-- and must not become PAN User-ID mappings.

INSERT OR IGNORE INTO exclusions (kind, value, reason, created_at) VALUES
  ('domain','cloudflareaccess.com','Cloudflare Access service identities','2026-07-10T00:00:00Z');
