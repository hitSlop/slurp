/**
 * The operator's dashboard at `/dashboard`: the projects and what is wrong with them. The page itself is static and holds no data.
 * It asks for the admin token, keeps it for the life of the tab only (sessionStorage), and reads `/v1/admin/status` with it, so
 * nothing about your projects is visible to anyone without the token. The script writes with `textContent` only: a project title
 * is free text and is never parsed as HTML.
 */
const SCRIPT = `
const KEY = 'slurp_admin_token'
const $ = id => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
const get = () => { try { return sessionStorage.getItem(KEY) } catch { return null } }
const put = t => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY) } catch {} }
const bytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'
const ago = iso => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'
}
let timer = null

function show(signedIn, message) {
  $('login').hidden = signedIn
  $('view').hidden = !signedIn
  $('error').textContent = message || ''
  $('error').hidden = !message
  if (!signedIn && timer) { clearInterval(timer); timer = null }
}

function render(r) {
  const bad = r.summary.errors + r.summary.warnings
  $('dot').className = 'dot ' + (r.summary.errors ? 'error' : r.summary.warnings ? 'warn' : 'ok')
  $('headline').textContent = bad === 0 ? 'Everything is working' : r.summary.errors + ' problem' + (r.summary.errors === 1 ? '' : 's') + (r.summary.warnings ? ', ' + r.summary.warnings + ' to watch' : '')
  $('meta').textContent = 'Release ' + r.release + (r.build ? ' · build ' + r.build.slice(0, 8) : '') + ' · updated ' + new Date(r.generatedAt).toLocaleTimeString()
  const issues = $('issues'); issues.replaceChildren()
  for (const i of r.issues) {
    const li = el('li', 'issue ' + i.level)
    li.append(el('strong', '', i.project), el('span', '', ' ' + i.message))
    issues.append(li)
  }
  issues.hidden = r.issues.length === 0
  const body = $('rows'); body.replaceChildren()
  for (const p of r.projects) {
    const tr = el('tr')
    const name = el('td'); name.append(el('span', 'dot ' + p.status), el('strong', '', p.name))
    if (p.title) name.append(el('div', 'sub', p.title))
    tr.append(name,
      el('td', '', p.sources.join(', ') || '—'),
      el('td', '', p.lastArchiveAt ? ago(p.lastArchiveAt) : (p.pending ? 'waiting' : 'none yet')),
      el('td', 'num', p.archives + ' · ' + p.events.toLocaleString() + ' events · ' + bytes(p.bytes)),
      el('td', 'num', p.bufferedBytes ? bytes(p.bufferedBytes) : '—'))
    body.append(tr)
  }
  $('empty').hidden = r.projects.length > 0
  $('table').hidden = r.projects.length === 0
}

async function load() {
  const token = get()
  if (!token) return show(false)
  let res
  try { res = await fetch('/v1/admin/status', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' }) }
  catch { return show(true, 'Could not reach the Worker. Retrying…') }
  if (res.status === 401 || res.status === 403) { put(null); return show(false, 'That token was not accepted.') }
  if (!res.ok) return show(true, 'The Worker answered ' + res.status + '. Retrying…')
  show(true)
  render(await res.json())
  if (!timer) timer = setInterval(load, 30000)
}

$('form').addEventListener('submit', e => { e.preventDefault(); const t = $('token').value.trim(); $('token').value = ''; if (t) { put(t); load() } })
$('refresh').addEventListener('click', load)
$('signout').addEventListener('click', () => { put(null); show(false) })
load()
`

export function dashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Slurp dashboard</title>
<style>
:root{--bg:#fff;--fg:#17191c;--muted:#535c66;--rule:#e4e7eb;--code:#f6f9fc;--accent:#e8002a;--ok:#1a9d5c;--warn:#c98200;--error:#d6291f}
@media(prefers-color-scheme:dark){:root{--bg:#101215;--fg:#eceff2;--muted:#9aa4af;--rule:#262b31;--code:#171b20;--warn:#e8a000;--error:#ff5b50}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:40px 20px}
h1{font-size:26px;margin:0}p{color:var(--muted)}a{color:var(--accent)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:10px;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.error{background:var(--error)}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 24px}.bar .grow{flex:1}
.meta{color:var(--muted);font-size:14px}
button,input{font:inherit;color:var(--fg);background:var(--code);border:1px solid var(--rule);border-radius:6px;padding:7px 12px}
button{cursor:pointer}input{min-width:260px}
#error{border:1px solid var(--rule);border-left:3px solid var(--error);padding:10px 14px;border-radius:4px}
ul.issues{list-style:none;padding:0;margin:0 0 28px}
.issue{border:1px solid var(--rule);border-left:3px solid var(--warn);padding:10px 14px;border-radius:4px;margin:8px 0}
.issue.error{border-left-color:var(--error)}.issue span{color:var(--muted)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--muted);font-weight:600}.num{font-variant-numeric:tabular-nums}
.sub{color:var(--muted);font-size:13px;margin-left:20px}
[hidden]{display:none!important}
</style></head><body><main>
<h1>Slurp dashboard</h1>
<div id="error" role="alert" hidden></div>
<section id="login" hidden>
<p>Enter the <code>ADMIN_TOKEN</code> for this Worker. It stays in this tab only and is sent to this Worker and nowhere else.</p>
<form id="form"><input id="token" type="password" autocomplete="off" placeholder="Admin token" aria-label="Admin token"> <button type="submit">Sign in</button></form>
</section>
<section id="view" hidden>
<div class="bar"><span id="dot" class="dot"></span><strong id="headline"></strong><span class="grow"></span><button id="refresh" type="button">Refresh</button><button id="signout" type="button">Sign out</button></div>
<p class="meta" id="meta"></p>
<ul class="issues" id="issues" hidden></ul>
<h2>Projects</h2>
<p id="empty" hidden>No projects yet. Run <code>slurp init --name "My app"</code> in your app's folder.</p>
<div class="scroll"><table id="table" hidden><thead><tr><th>Project</th><th>Sources</th><th>Last archive</th><th>Archived</th><th>Buffered</th></tr></thead><tbody id="rows"></tbody></table></div>
</section>
<p class="meta"><a href="/">Setup</a> · <a href="/v1/health">Health</a></p>
</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`
}
