import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./types";
import { accessGuard } from "./lib/access";
import { extractRecord, parseNdjson, readLogpushBody } from "./lib/logpush";
import {
  countByState,
  listMappings,
  upsertRecords,
} from "./lib/mappings";
import {
  addExclusion,
  deleteExclusion,
  isExcluded,
  listExclusions,
  loadExclusions,
} from "./lib/exclusions";
import {
  pushLogins,
  pushLogoutsByIds,
  runScheduledPush,
} from "./lib/push";
import {
  clearMockCaptures,
  getMockCaptures,
  MOCK_PAN_RESPONSE,
  storeMockCapture,
  summarizeUidMessage,
} from "./lib/mock";
import {
  Dashboard,
  ExclusionsView,
  LogsView,
  MockView,
  SettingsView,
  type PushLogRow,
} from "./ui/views";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Health (open)
// ---------------------------------------------------------------------------
app.get("/health", (c) =>
  c.json({ ok: true, service: "panidsync", time: new Date().toISOString() }),
);

// ---------------------------------------------------------------------------
// Logpush ingest (open, guarded by shared secret) — POST /api/logpush
// ---------------------------------------------------------------------------
app.post("/api/logpush", async (c) => {
  try {
    const env = c.env;
    const secret = env.LOGPUSH_SECRET;

    // Cloudflare Logpush sends the configured header on every batch.
    if (secret) {
      const auth =
        c.req.header("authorization") || c.req.header("x-logpush-secret") || "";
      const provided = auth.replace(/^Bearer\s+/i, "").trim();
      if (provided !== secret) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    const text = await readLogpushBody(c.req.raw);

    // Logpush HTTP ownership-challenge: some setups POST a tiny JSON body with a
    // challenge token that must be echoed back. Handle it gracefully.
    if (text && text.length < 512 && text.trim().startsWith("{")) {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        const token = obj.content ?? obj.challenge ?? obj.text;
        if (token && !Array.isArray(obj) && !("Timestamp" in obj)) {
          return c.json({ content: token });
        }
      } catch {
        /* fall through to log parsing */
      }
    }

    const dataset = c.req.query("dataset") || "zero_trust_network_sessions";
    const records = parseNdjson(text);
    const parsed = records
      .map((r) => extractRecord(r, env.IP_FIELD || "SourceIP", dataset))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Bypass list: drop records whose source IP or identity is excluded (e.g.
    // Cloudflare/WARP egress ranges, or known-bad users) before they ever map.
    const exclusions = await loadExclusions(env);
    const extracted = parsed.filter(
      (r) => !isExcluded(exclusions, r.sourceIp, r.userEmail),
    );
    const excluded = parsed.length - extracted.length;

    const { upserted, changed } = await upsertRecords(env, extracted);
    return c.json({
      ok: true,
      received: records.length,
      mapped: upserted,
      excluded,
      pending: changed,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Mock PAN User-ID receiver (open) — POST /mock/user-id + GET /mock/user-id
// Emulates https://<firewall>/api/?type=user-id&action=set and echoes back the
// exact uid-message it received (also stored for the Mock Receiver page).
// ---------------------------------------------------------------------------
async function handleMockUserId(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  if ((env.MOCK_ENABLED || "true").toLowerCase() !== "true") {
    return c.text('<response status="error"><msg>mock disabled</msg></response>', 403, {
      "content-type": "application/xml",
    });
  }
  let cmd = "";
  const ct = c.req.header("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    cmd = typeof form.cmd === "string" ? form.cmd : "";
  } else {
    cmd = c.req.query("cmd") || (await c.req.text());
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    if (k === "authorization" || k === "cookie") return;
    headers[k] = v;
  });

  await storeMockCapture(env, {
    ts: new Date().toISOString(),
    source: "http",
    method: c.req.method,
    query: new URL(c.req.url).searchParams.toString(),
    headers,
    cmd,
    entries: summarizeUidMessage(cmd),
  });

  return c.text(MOCK_PAN_RESPONSE, 200, { "content-type": "application/xml" });
}
app.post("/mock/user-id", (c) => handleMockUserId(c));
app.get("/mock/user-id", (c) => handleMockUserId(c));
// Real PAN uses /api/ as the path; mirror it so PAN_HOST can point at this worker.
app.post("/api/", async (c) => {
  if (c.req.query("type") === "user-id") return await handleMockUserId(c);
  return c.json({ error: "unsupported api request" }, 400);
});

// ---------------------------------------------------------------------------
// Protected UI + control API.
//
// Primary gate: Cloudflare Access enabled on the workers.dev route (one-click
// Access for Workers) blocks unauthenticated requests at the edge before they
// reach the worker. accessGuard() adds in-worker JWT verification as
// defense-in-depth (validates Cf-Access-Jwt-Assertion against the team JWKS;
// no-op unless ACCESS_ENABLED=true and ACCESS_TEAM_DOMAIN/ACCESS_AUD are set).
//
// Ingest (/api/logpush), /health, and the mock receiver are intentionally NOT
// guarded here — exclude them from Access with a path Bypass policy (or an
// Access service token on the Logpush job). Ingest stays protected by
// LOGPUSH_SECRET.
// ---------------------------------------------------------------------------
app.use("/", accessGuard());
app.use("/mock", accessGuard());
app.use("/logs", accessGuard());
app.use("/exclusions", accessGuard());
app.use("/settings", accessGuard());
app.use("/api/mappings", accessGuard());
app.use("/api/push", accessGuard());
app.use("/api/mock/clear", accessGuard());
app.use("/api/exclusions", accessGuard());
app.use("/api/exclusions/delete", accessGuard());

app.get("/", async (c) => {
  const env = c.env;
  const search = c.req.query("q") || "";
  const state = c.req.query("state") || "all";
  const [mappings, counts] = await Promise.all([
    listMappings(env, { search, state }),
    countByState(env),
  ]);
  return c.html(
    <Dashboard
      mappings={mappings}
      counts={counts}
      panHost={env.PAN_HOST || "self:mock"}
      panIpSource={(env.PAN_IP_SOURCE || "internal").toLowerCase()}
      mockEnabled={(env.MOCK_ENABLED || "true").toLowerCase() === "true"}
      search={search}
      state={state}
    />,
  );
});

app.get("/mock", async (c) => {
  const captures = await getMockCaptures(c.env);
  return c.html(
    <MockView
      captures={captures}
      enabled={(c.env.MOCK_ENABLED || "true").toLowerCase() === "true"}
    />,
  );
});

app.get("/logs", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT ts, action, trigger, entry_count, ok, status_code, pan_host, error
       FROM push_log ORDER BY ts DESC LIMIT 200`,
  ).all<PushLogRow>();
  return c.html(<LogsView rows={res.results ?? []} />);
});

app.get("/exclusions", async (c) => {
  const rows = await listExclusions(c.env);
  return c.html(<ExclusionsView rows={rows} />);
});

app.get("/settings", async (c) => {
  const env = c.env;
  const cidrs = (await listExclusions(env)).filter((r) => r.kind === "cidr");
  return c.html(
    <SettingsView
      cidrs={cidrs}
      config={{
        panHost: env.PAN_HOST || "self:mock",
        panIpSource: (env.PAN_IP_SOURCE || "internal").toLowerCase(),
        panVsys: env.PAN_VSYS || "",
        panUserPrefix: env.PAN_USER_PREFIX || "",
        timeoutMinutes: env.PAN_TIMEOUT_MINUTES || "60",
        staleMinutes: env.STALE_AFTER_MINUTES || "120",
        ipField: env.IP_FIELD || "SourceIP",
        mockEnabled: (env.MOCK_ENABLED || "true").toLowerCase() === "true",
      }}
    />,
  );
});

app.post("/api/exclusions", async (c) => {
  try {
    const body = await c.req.json<{ kind?: string; value?: string; reason?: string }>();
    if (!body.value || !body.value.trim())
      return c.json({ error: "value is required" }, 400);
    const { purged } = await addExclusion(
      c.env,
      body.kind || "cidr",
      body.value,
      body.reason?.trim() || null,
    );
    return c.json({ ok: true, purged });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/exclusions/delete", async (c) => {
  try {
    const body = await c.req.json<{ id?: number }>();
    if (!body.id) return c.json({ error: "id is required" }, 400);
    await deleteExclusion(c.env, body.id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/mappings", async (c) => {
  const mappings = await listMappings(c.env, {
    search: c.req.query("q") || "",
    state: c.req.query("state") || "all",
  });
  return c.json({ ok: true, mappings });
});

app.post("/api/push", async (c) => {
  try {
    const body = await c.req.json<{ action?: string; ids?: number[]; all?: boolean }>();
    const action = body.action === "logout" ? "logout" : "login";
    const origin = new URL(c.req.url).origin;

    if (action === "logout") {
      if (!body.ids || body.ids.length === 0)
        return c.json({ error: "no ids provided for logout" }, 400);
      const s = await pushLogoutsByIds(c.env, {
        trigger: "manual",
        ids: body.ids,
        origin,
      });
      return c.json(s);
    }

    const s = await pushLogins(c.env, {
      trigger: "manual",
      ids: body.all ? undefined : body.ids,
      includePushed: false,
      origin,
    });
    return c.json(s);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/mock/clear", async (c) => {
  await clearMockCaptures(c.env);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  // Cron trigger: scheduled push to PAN.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduledPush(env).then((s) => {
        console.log(
          `[cron] logins=${s.loginCount} logouts=${s.logoutCount} ok=${s.ok}`,
        );
      }),
    );
  },
};
