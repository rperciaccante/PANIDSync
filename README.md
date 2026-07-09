# PANIDSync

A Cloudflare Worker that ingests **Cloudflare Zero Trust Logpush** events, tracks
authenticated **user ↔ ID ↔ IP** mappings, shows them in a web dashboard, and
pushes **IP-to-User** mappings to a **Palo Alto Networks** firewall via the
[PAN-OS User-ID XML API](http://api-lab.paloaltonetworks.com/user-id.html).

It ships with a **built-in mock PAN receiver** so you can run the full pipeline
end-to-end without a live firewall — it decodes and displays the exact
`uid-message` payload it would have sent.

```
Cloudflare ZTNA ── Logpush ──▶ /api/logpush ──▶ D1 (mappings) ──▶ Dashboard
                                                      │
                                     manual push / cron ▼
                                        PAN-OS User-ID API  (or built-in mock)
```

## Features

- **Logpush ingest** (`POST /api/logpush`) — gzip NDJSON, shared-secret auth,
  ownership-challenge handling. Field extraction tolerates
  `zero_trust_network_sessions`, `access_requests`, and `gateway_http`.
- **D1-backed mapping store** — one row per source IP (PAN maps one IP to one
  user), with state tracking: `pending → pushed → stale → logged_out`.
- **PAN-OS User-ID client** — builds `<uid-message>` login/logout payloads and
  POSTs to `https://<firewall>/api/?type=user-id&action=set`.
- **Two push modes** — manual (dashboard button / API) **and** scheduled (cron,
  default every 5 min). Cron also logs out stale mappings.
- **Built-in mock receiver** (`POST /mock/user-id`, viewer at `/mock`) — shows
  the exact XML received.
- **Web dashboard** — mappings table with search/filter, push controls, push log.
- **Optional Cloudflare Access** JWT verification on top of a zone-level Access app.

## Project layout

```
migrations/0001_init.sql   D1 schema (mappings, push_log)
src/index.tsx              Hono app, routes, cron handler
src/lib/logpush.ts         gzip/NDJSON parse + field extraction
src/lib/mappings.ts        D1 upsert/query/state helpers
src/lib/pan.ts             uid-message builder + PAN send (+ self:mock path)
src/lib/mock.ts            mock capture storage + XML summary
src/lib/push.ts            login/logout orchestration + cron entry
src/lib/access.ts          optional Cloudflare Access JWT middleware
src/ui/views.tsx           SSR dashboard / mock viewer / push log
```

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars      # set LOGPUSH_SECRET (PAN_API_KEY optional for mock)
npm run d1:migrate:local            # create local D1 + apply schema
npm run dev                         # http://localhost:8787
```

Send a sample batch and push it (uses the built-in mock by default):

```bash
printf '%s\n' \
'{"Email":"alice@example.com","SourceIP":"203.0.113.10","UserID":"u-alice","Timestamp":"2026-07-09T10:00:00Z"}' \
| gzip | curl -s -X POST "http://localhost:8787/api/logpush?dataset=zero_trust_network_sessions" \
    -H 'authorization: Bearer <LOGPUSH_SECRET>' -H 'content-encoding: gzip' --data-binary @-

# open http://localhost:8787  → select rows → "Push selected (login)"
# open http://localhost:8787/mock  → see the exact uid-message payload
```

## Configuration

Non-secret settings live in `wrangler.jsonc` under `vars`:

| Var | Default | Meaning |
|---|---|---|
| `IP_FIELD` | `SourceIP` | Logpush field used as the client IP |
| `PAN_HOST` | `self:mock` | Firewall base URL, or `self:mock` for the built-in receiver |
| `PAN_VSYS` | _(empty)_ | Optional target vsys |
| `PAN_TIMEOUT_MINUTES` | `60` | User-ID mapping timeout (0 = never) |
| `PAN_USER_PREFIX` | _(empty)_ | Prefix for the PAN user name, e.g. `corp\\` |
| `STALE_AFTER_MINUTES` | `120` | Auto-logout mappings idle this long (0 = never) |
| `MOCK_ENABLED` | `true` | Enable `/mock/user-id` + `/mock` |
| `ACCESS_ENABLED` | `false` | Verify Cloudflare Access JWT in-worker |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | _(empty)_ | Access team + application AUD |

Secrets (**never commit**):

```bash
wrangler secret put LOGPUSH_SECRET     # required — Logpush Authorization header value
wrangler secret put PAN_API_KEY        # only when PAN_HOST is a real firewall
wrangler secret put DASHBOARD_PASSWORD # dashboard login gate (see below)
```

## Protecting the dashboard

The dashboard + control API show user PII, so they're gated. Two layers:

1. **In-worker login gate (works on `workers.dev`).** Set `DASHBOARD_PASSWORD`
   and the worker requires a password login (`/login`) that mints a 12h
   HMAC-signed cookie. `/api/logpush`, `/mock/user-id`, and `/health` stay open
   (ingest is guarded by `LOGPUSH_SECRET`). If `DASHBOARD_PASSWORD` is unset the
   gate **fails open** (dashboard public) — so set it before real data flows.
   Log out at `/logout`.
2. **Cloudflare Access (needs a custom domain).** Access can't attach to a
   `*.workers.dev` hostname. Put the worker on a custom domain in a zone you
   control, add an Access self-hosted app, and (optionally) set
   `ACCESS_ENABLED=true` + `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` for in-worker JWT
   verification. Add an Access **Bypass** policy for `/api/logpush` so Logpush
   still reaches the worker.

## Wiring up Cloudflare Logpush

Create a Logpush job for **Zero Trust network sessions** pointing at this Worker,
with the shared secret as the `Authorization` header:

```
https://<your-worker>/api/logpush?dataset=zero_trust_network_sessions?header_Authorization=Bearer%20<LOGPUSH_SECRET>
```

(Configure via the Zero Trust dashboard → Logs → Logpush, or the Logpush API.
The ingest route rejects any batch whose `Authorization` header doesn't match.)

## Targeting a real Palo Alto firewall

1. Generate a User-ID API key on the firewall (`/api/?type=keygen`).
2. `wrangler secret put PAN_API_KEY`.
3. Set `PAN_HOST` in `wrangler.jsonc` to `https://<firewall-host>`.
4. Push from the dashboard or wait for the cron. Payloads are the standard
   `type=user-id&action=set` request with a `cmd=<uid-message>` body.

> TLS note: Workers verify TLS and cannot skip verification. A firewall with a
> self-signed cert must present a chain the Worker trusts.

## Deploy

> **Deployment safety:** this repo ships with placeholder resource IDs. Verify
> the target account, worker name, route, and binding IDs before deploying.

```bash
npm run d1:create      # paste database_id into wrangler.jsonc
npm run kv:create      # paste id into wrangler.jsonc
export CLOUDFLARE_ACCOUNT_ID=<account-id>
npm run d1:migrate:remote
npm run deploy
```

Protect the dashboard by putting a **Cloudflare Access** application in front of
the Worker's hostname (the `/api/logpush` and `/mock/user-id` endpoints are meant
to stay reachable by Logpush / the firewall). Optionally set `ACCESS_ENABLED=true`
for in-worker JWT verification as defense in depth.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | open | Liveness |
| POST | `/api/logpush` | shared secret | Ingest Logpush batches |
| POST/GET | `/mock/user-id`, `/api/` | open | Mock PAN receiver |
| GET | `/` | Access | Mappings dashboard |
| GET | `/mock` | Access | Received mock payloads |
| GET | `/logs` | Access | Push audit log |
| GET | `/api/mappings` | Access | Mappings JSON |
| POST | `/api/push` | Access | Manual login/logout push |
| POST | `/api/mock/clear` | Access | Clear captured mock payloads |

## License

MIT — see [LICENSE](./LICENSE).
