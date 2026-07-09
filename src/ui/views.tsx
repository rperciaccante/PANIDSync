import type { FC } from "hono/jsx";
import type { Mapping } from "../types";
import type { MockCapture } from "../lib/mock";

const STYLE = `
:root{--bg:#0e1116;--panel:#161b22;--panel2:#1c2430;--border:#2b3441;--fg:#e6edf3;--muted:#8b949e;--accent:#f38020;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--blue:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--blue);text-decoration:none}
header{display:flex;align-items:center;gap:16px;padding:14px 22px;background:var(--panel);border-bottom:1px solid var(--border)}
header h1{font-size:16px;margin:0;font-weight:600}
header .logo{width:10px;height:10px;border-radius:50%;background:var(--accent)}
nav{margin-left:auto;display:flex;gap:6px}
nav a{padding:6px 12px;border-radius:6px;color:var(--muted)}
nav a.active,nav a:hover{background:var(--panel2);color:var(--fg)}
main{max-width:1200px;margin:0 auto;padding:22px}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 18px;min-width:120px}
.tile .n{font-size:24px;font-weight:700}
.tile .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
input,select,button{font:inherit;color:var(--fg);background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:7px 10px}
input[type=text]{min-width:220px}
button{cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#111;font-weight:600}
button.ghost{background:transparent}
button:disabled{opacity:.5;cursor:not-allowed}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px;white-space:nowrap}
th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--panel2)}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge.pending{background:rgba(210,153,34,.18);color:var(--warn)}
.badge.pushed{background:rgba(63,185,80,.18);color:var(--ok)}
.badge.stale{background:rgba(139,148,158,.18);color:var(--muted)}
.badge.logged_out{background:rgba(248,81,73,.16);color:var(--bad)}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cfg{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:18px;font-size:13px}
.cfg code{color:var(--accent)}
pre{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#c9d1d9}
.cap{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.cap h3{margin:0 0 8px;font-size:13px}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:14px;display:none}
.flash.ok{background:rgba(63,185,80,.15);border:1px solid var(--ok);color:var(--ok)}
.flash.err{background:rgba(248,81,73,.15);border:1px solid var(--bad);color:var(--bad)}
.empty{padding:40px;text-align:center;color:var(--muted)}
`;

export const Layout: FC<{ title: string; active: string; children?: unknown }> = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{props.title} · PANIDSync</title>
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    </head>
    <body>
      <header>
        <span class="logo" />
        <h1>PANIDSync</h1>
        <span class="muted" style="font-size:12px">Zero Trust → Palo Alto User-ID</span>
        <nav>
          <a href="/" class={props.active === "dash" ? "active" : ""}>Mappings</a>
          <a href="/mock" class={props.active === "mock" ? "active" : ""}>Mock Receiver</a>
          <a href="/logs" class={props.active === "logs" ? "active" : ""}>Push Log</a>
        </nav>
      </header>
      <main>{props.children}</main>
    </body>
  </html>
);

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export const Dashboard: FC<{
  mappings: Mapping[];
  counts: Record<string, number>;
  panHost: string;
  mockEnabled: boolean;
  search: string;
  state: string;
}> = (props) => (
  <Layout title="Mappings" active="dash">
    <div class="tiles">
      <div class="tile"><div class="n">{props.counts.total ?? 0}</div><div class="l">Total</div></div>
      <div class="tile"><div class="n">{props.counts.pending ?? 0}</div><div class="l">Pending</div></div>
      <div class="tile"><div class="n">{props.counts.pushed ?? 0}</div><div class="l">Pushed</div></div>
      <div class="tile"><div class="n">{props.counts.stale ?? 0}</div><div class="l">Stale</div></div>
      <div class="tile"><div class="n">{props.counts.logged_out ?? 0}</div><div class="l">Logged out</div></div>
    </div>

    <div class="cfg">
      PAN target: <code>{props.panHost}</code>
      {props.panHost === "self:mock" ? (
        <span class="muted"> — using built-in mock receiver (see <a href="/mock">Mock Receiver</a>)</span>
      ) : null}
    </div>

    <div id="flash" class="flash" />

    <form class="toolbar" method="get" action="/">
      <input type="text" name="q" placeholder="search email / IP / user id" value={props.search} />
      <select name="state">
        {["all", "pending", "pushed", "stale", "logged_out"].map((s) => (
          <option value={s} selected={props.state === s}>{s}</option>
        ))}
      </select>
      <button type="submit" class="ghost">Filter</button>
      <span style="flex:1" />
      <button type="button" class="ghost" onclick="selectAll()">Select all</button>
      <button type="button" class="primary" onclick="push('login')">Push selected (login)</button>
      <button type="button" onclick="pushAll()">Push all pending</button>
      <button type="button" class="ghost" onclick="push('logout')">Logout selected</button>
    </form>

    {props.mappings.length === 0 ? (
      <div class="empty">No mappings yet. Point a Logpush job at <code>/api/logpush</code>.</div>
    ) : (
      <table>
        <thead>
          <tr>
            <th style="width:28px"><input type="checkbox" onclick="toggleAll(this)" /></th>
            <th>User</th><th>Source IP</th><th>User ID</th><th>Device</th>
            <th>State</th><th>Last seen</th><th>Pushed as</th>
          </tr>
        </thead>
        <tbody>
          {props.mappings.map((m) => (
            <tr>
              <td><input type="checkbox" class="rowchk" value={m.id} /></td>
              <td>{m.user_email ?? <span class="muted">—</span>}</td>
              <td class="mono">{m.source_ip}</td>
              <td class="mono muted">{m.user_id ?? "—"}</td>
              <td class="muted">{m.device_name ?? m.device_id ?? "—"}</td>
              <td><span class={`badge ${m.push_state}`}>{m.push_state}</span></td>
              <td class="muted">{fmtTime(m.last_seen)}</td>
              <td class="mono muted">{m.pushed_user ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}

    <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
  </Layout>
);

export const MockView: FC<{ captures: MockCapture[]; enabled: boolean }> = (props) => (
  <Layout title="Mock Receiver" active="mock">
    <div class="cfg">
      Built-in mock PAN User-ID receiver. Endpoint: <code>POST /mock/user-id</code>.
      {props.enabled ? "" : " (Currently disabled via MOCK_ENABLED=false.)"}
      <span class="muted"> Shows the exact <code>uid-message</code> payload received from the sender.</span>
      <button type="button" class="ghost" style="margin-left:12px" onclick="clearMock()">Clear</button>
    </div>
    <div id="flash" class="flash" />
    {props.captures.length === 0 ? (
      <div class="empty">No payloads received yet. Push some mappings from the <a href="/">Mappings</a> page.</div>
    ) : (
      props.captures.map((c) => (
        <div class="cap">
          <h3>
            {fmtTime(c.ts)} · <span class="muted">{c.source}</span> ·{" "}
            {c.entries.length} entr{c.entries.length === 1 ? "y" : "ies"}
          </h3>
          <div class="muted mono" style="font-size:12px;margin-bottom:8px">?{c.query}</div>
          <pre>{c.cmd}</pre>
        </div>
      ))
    )}
    <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
  </Layout>
);

export const LogsView: FC<{ rows: PushLogRow[] }> = (props) => (
  <Layout title="Push Log" active="logs">
    {props.rows.length === 0 ? (
      <div class="empty">No pushes recorded yet.</div>
    ) : (
      <table>
        <thead>
          <tr><th>Time</th><th>Action</th><th>Trigger</th><th>Entries</th><th>Result</th><th>Status</th><th>Host</th></tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr>
              <td class="muted">{fmtTime(r.ts)}</td>
              <td>{r.action}</td>
              <td class="muted">{r.trigger}</td>
              <td>{r.entry_count}</td>
              <td>
                <span class={`badge ${r.ok ? "pushed" : "logged_out"}`}>{r.ok ? "ok" : "fail"}</span>
                {r.error ? <span class="muted"> {r.error}</span> : null}
              </td>
              <td class="muted">{r.status_code ?? "—"}</td>
              <td class="mono muted">{r.pan_host ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Layout>
);

export interface PushLogRow {
  ts: string;
  action: string;
  trigger: string;
  entry_count: number;
  ok: number;
  status_code: number | null;
  pan_host: string | null;
  error: string | null;
}

const CLIENT_JS = `
function selectedIds(){return [...document.querySelectorAll('.rowchk:checked')].map(c=>+c.value)}
function toggleAll(cb){document.querySelectorAll('.rowchk').forEach(c=>c.checked=cb.checked)}
function selectAll(){document.querySelectorAll('.rowchk').forEach(c=>c.checked=true)}
function flash(msg,ok){var f=document.getElementById('flash');if(!f)return;f.textContent=msg;f.className='flash '+(ok?'ok':'err');f.style.display='block';setTimeout(()=>{f.style.display='none'},5000)}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));return{r,j}}
async function push(action){const ids=selectedIds();if(!ids.length){return flash('Select at least one row first.',false)}
  const {r,j}=await post('/api/push',{action,ids});
  if(r.ok){flash((action==='logout'?'Logged out ':'Pushed ')+(j.loginCount||j.logoutCount||0)+' mapping(s).',j.ok!==false);setTimeout(()=>location.reload(),900)}else{flash(j.error||'Push failed',false)}}
async function pushAll(){const {r,j}=await post('/api/push',{action:'login',all:true});
  if(r.ok){flash('Pushed '+(j.loginCount||0)+' pending mapping(s).',j.ok!==false);setTimeout(()=>location.reload(),900)}else{flash(j.error||'Push failed',false)}}
async function clearMock(){const {r}=await post('/api/mock/clear');if(r.ok){location.reload()}}
`;
