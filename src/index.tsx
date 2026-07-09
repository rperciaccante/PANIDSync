import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./types";
import { accessGuard } from "./lib/access";
import {
  clearSessionCookie,
  dashGuard,
  loginPageHtml,
  makeSession,
  setSessionCookie,
} from "./lib/auth";
import { extractRecord, parseNdjson, readLogpushBody } from "./lib/logpush";
import {
  countByState,
  listMappings,
  upsertRecords,
} from "./lib/mappings";
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
import { Dashboard, LogsView, MockView, type PushLogRow } from "./ui/views";

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
    const extracted = records
      .map((r) => extractRecord(r, env.IP_FIELD || "SourceIP", dataset))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const { upserted, changed } = await upsertRecords(env, extracted);
    return c.json({
      ok: true,
      received: records.length,
      mapped: upserted,
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
// Login gate (in-worker auth — works on workers.dev where Access can't attach)
// ---------------------------------------------------------------------------
app.get("/login", (c) => {
  const next = c.req.query("next") || "/";
  // Already signed in? bounce to the dashboard.
  return c.html(loginPageHtml(undefined, next));
});

app.post("/login", async (c) => {
  const pw = c.env.DASHBOARD_PASSWORD;
  const body = await c.req.parseBody();
  const supplied = typeof body.password === "string" ? body.password : "";
  const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
  if (!pw) return c.redirect(next, 302); // gate disabled — nothing to check
  if (supplied && supplied === pw) {
    setSessionCookie(c, await makeSession(pw));
    return c.redirect(next, 302);
  }
  return c.html(loginPageHtml("Incorrect password.", next), 401);
});

app.get("/logout", (c) => {
  clearSessionCookie(c);
  return c.redirect("/login", 302);
});

// ---------------------------------------------------------------------------
// Protected UI + control API — in-worker login gate, plus optional CF Access
// JWT verification (accessGuard is a no-op unless ACCESS_ENABLED=true).
// ---------------------------------------------------------------------------
app.use("/", dashGuard(), accessGuard());
app.use("/mock", dashGuard(), accessGuard());
app.use("/logs", dashGuard(), accessGuard());
app.use("/api/mappings", dashGuard(), accessGuard());
app.use("/api/push", dashGuard(), accessGuard());
app.use("/api/mock/clear", dashGuard(), accessGuard());

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
