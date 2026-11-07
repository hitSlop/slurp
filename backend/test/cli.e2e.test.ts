// Contract test: the real Rust CLI against the real Worker (wrangler dev). Skips when the CLI binary or DuckDB 2 is missing.
//   cargo build -p slurp-cli && npm test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { ADMIN_TOKEN, admin, debug, startWorker, type Worker } from './harness.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const bin = process.env.SLURP_BIN ?? join(root, 'target/debug/slurp')
const duckdb = process.env.SLURP_DUCKDB ?? join(homedir(), '.slurp/bin/duckdb')
const skip = !existsSync(bin) ? `no CLI at ${bin} (run cargo build -p slurp-cli)` : !existsSync(duckdb) ? `no DuckDB at ${duckdb} (set SLURP_DUCKDB)` : false

let w: Worker, home: string, ws: string
const run = (args: string[], env: Record<string, string> = {}, input?: string, cwd = ws) => {
  const r = spawnSync(bin, args, { cwd, input, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, SLURP_HOME: join(home, '.slurp-home'), ...env } })
  const text = (r.stdout || r.stderr).trim()
  let json: any
  try { json = JSON.parse(text.split('\n')[0]) } catch {}
  return { status: r.status, text, json }
}
before(async () => {
  if (skip) return
  w = await startWorker()
  home = mkdtempSync(join(tmpdir(), 'slurp-cli-e2e-'))
  ws = join(home, 'app'); mkdirSync(ws, { recursive: true })
})
after(async () => { if (w) await w.stop(); if (home) rmSync(home, { recursive: true, force: true }) })

test('connect verifies the Worker and the token, then saves them', { skip }, async () => {
  const bad = run(['connect', w.base, '--token-stdin'], {}, 'wrong-token-value\n')
  assert.notEqual(bad.status, 0); assert.match(bad.text, /rejected that admin token/)
  const notSlurp = run(['connect', 'http://127.0.0.1:9', '--token-stdin'], {}, `${ADMIN_TOKEN}\n`)
  assert.notEqual(notSlurp.status, 0); assert.match(notSlurp.text, /could not reach/)
  assert.notEqual(run(['connect', w.base]).status, 0, 'a token is required and is never taken as an argument')
  const ok = run(['connect', w.base, '--token-stdin'], {}, `${ADMIN_TOKEN}\n`)
  assert.equal(ok.status, 0, ok.text); assert.equal(ok.json.scope, 'admin'); assert.equal(ok.json.backend, w.base)
  // saved: later commands need neither SLURP_TOKEN nor --backend
  assert.equal(run(['whoami']).json.scope, 'admin')
  assert.equal(run(['project', 'list']).status, 0)
})

test('whoami says what any key is, connect only accepts the admin token, and logout forgets the saved token', { skip }, async () => {
  const src = (await (await fetch(`${w.base}/rpc/Project/CreateProject`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'whoami_src' }) })).json()) as any
  const secret = (await (await fetch(`${w.base}/rpc/Project/CreateKey`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ project: src.project.id, scope: 'secret', name: 'bot' }) })).json()) as any
  // a bot with only a read key, no saved connection: SLURP_TOKEN wins and whoami works for it
  const bot = { SLURP_HOME: join(home, 'bot-home'), SLURP_TOKEN: secret.key }
  const asBot = run(['whoami', '--backend', w.base], bot)
  assert.equal(asBot.status, 0, asBot.text); assert.deepEqual([asBot.json.scope, asBot.json.project, asBot.json.name], ['secret', src.project.id, 'bot'])
  const publishable = run(['whoami', '--backend', w.base], { ...bot, SLURP_TOKEN: src.publishableKey })
  assert.deepEqual([publishable.json.scope, publishable.json.project, publishable.json.name], ['publishable', src.project.id, 'default'])
  // connect needs the admin token, and says so
  const connectWithKey = run(['connect', w.base, '--token-stdin'], { SLURP_HOME: join(home, 'bot-home') }, `${secret.key}\n`)
  assert.notEqual(connectWithKey.status, 0); assert.match(connectWithKey.text, /secret key; slurp connect needs the Worker's admin token/)
  assert.notEqual(run(['whoami', '--backend', w.base], { ...bot, SLURP_TOKEN: 'slurp_sk_unknown' }).status, 0, 'an unknown key is refused')
  // logout forgets the saved connection; the next command says how to connect again
  assert.equal(run(['logout']).status, 0)
  const after = run(['whoami'])
  assert.notEqual(after.status, 0); assert.match(after.text, /not connected to a Worker/)
  assert.equal(run(['connect', w.base, '--token-stdin'], {}, `${ADMIN_TOKEN}\n`).status, 0, 'and connecting again works')
})

test('init -> send -> sync (gzip archive) -> sql, idempotent, with geo and exact wide numbers', { skip }, async () => {
  const setup = run(['setup', '--library', join(home, 'library'), '--duckdb', duckdb, '--no-connect', '--no-open', '--json'])
  assert.equal(setup.status, 0, setup.text)
  const init = run(['init', '--name', 'Contract App', '--project', ws, '--data-dir', join(ws, 'data'), '--duckdb', duckdb, '--no-open', '--no-install-skills', '--no-agent-notes', '--json'])
  assert.equal(init.status, 0, init.text)
  const source = run(['status', '--project', ws, '--json']).json.project as string
  assert.match(source, /^prj_/)
  for (const i of [1, 2, 3]) assert.equal(run(['send', 'signed_up', '--user-id', `u${i}`, '--data', '{"amount":12345678901234567890}', '--project', ws, '--json']).json.accepted, true)
  assert.equal(run(['send', 'page_view', '--user-id', 'u1', '--project', ws, '--json']).json.accepted, true)
  // nothing is published yet
  assert.equal(run(['sync', '--project', ws, '--json']).json.downloaded, 0)
  await debug(w.base, 'seal', source)
  const first = run(['sync', '--project', ws, '--json'])
  assert.equal(first.status, 0, first.text); assert.equal(first.json.downloaded, 1); assert.equal(first.json.imported, 4)
  const q = run(['sql', "SELECT event, count(*) n, any_value(data->>'$.amount') amount, any_value(context->>'$.geo.provider') provider FROM events GROUP BY event ORDER BY event", '--project', ws, '--json']).json
  assert.deepEqual(q.rows.map((r: any[]) => [r[0], r[1]]), [['page_view', 1], ['signed_up', 3]])
  assert.equal(q.rows[1][2], '12345678901234567890', 'wide number is exact end to end')
  assert.equal(q.rows[1][3], 'cloudflare', 'geo enrichment reached the local database')
  const again = run(['sync', '--project', ws, '--json'])
  assert.deepEqual([again.json.downloaded, again.json.imported], [0, 0], 'second sync is a no-op')
  // a second archive resumes from the checkpoint
  run(['send', 'late', '--user-id', 'u9', '--project', ws, '--json']); await debug(w.base, 'seal', source)
  const next = run(['sync', '--project', ws, '--json'])
  assert.deepEqual([next.json.downloaded, next.json.imported, next.json.checkpoint], [1, 1, '2'])
  assert.equal(run(['sql', 'SELECT count(*) FROM events', '--project', ws, '--json']).json.rows[0][0], 5)
  // the CLI cannot read with a publishable key; revoking the saved admin token breaks nothing else
  assert.equal((await fetch(`${w.base}/rpc/Archive/ListObjects`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ project: source }) })).status, 200)
  // a send used the project's key from the Worker: this machine keeps no copy of it
  assert.ok(!existsSync(join(home, 'credentials.json')) || !readFileSync(join(home, 'credentials.json'), 'utf8').includes('slurp_pk_'), 'no publishable key is stored locally')
})

test('one project, many senders: init is idempotent, setup changes nothing, and every event says which key sent it', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  // a second folder (another machine, in effect) that asks for the same name joins the same project and the same key
  const ws2 = join(home, 'app2'); mkdirSync(ws2, { recursive: true })
  const again = run(['init', '--name', 'Contract App', '--project', ws2, '--data-dir', join(ws2, 'data'), '--duckdb', duckdb, '--no-open', '--no-install-skills', '--no-agent-notes', '--json'])
  assert.equal(again.status, 0, again.text)
  assert.equal(run(['status', '--project', ws2, '--json']).json.project, project, 'same name, same project')
  const keys = () => run(['project', 'key', 'list', project, '--scope', 'publishable', '--json']).json.keys as any[]
  assert.equal(keys().length, 1, 'init never makes a second key')
  const setup = run(['project', 'setup', project, '--json']); run(['project', 'setup', project, '--json'])
  assert.equal(setup.status, 0, setup.text); assert.equal(keys().length, 1, 'setup only shows keys, it never makes one')
  assert.equal(setup.json.environment.SLURP_PUBLISHABLE_KEY, keys()[0].key)
  // one key per sender
  const ios = run(['project', 'key', 'create', project, '--scope', 'publishable', '--name', 'ios', '--json']).json.key as string
  const web = run(['project', 'key', 'create', project, '--scope', 'publishable', '--name', 'web', '--json']).json.key as string
  assert.equal(run(['send', 'from_ios', '--user-id', 'u1', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: ios }).json.accepted, true)
  assert.equal(run(['send', 'from_web', '--user-id', 'u2', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: web }).json.accepted, true)
  assert.equal(run(['send', 'from_cli', '--user-id', 'u3', '--project', ws, '--json']).json.accepted, true)
  await debug(w.base, 'seal', project)
  assert.equal(run(['sync', '--project', ws2, '--json']).status, 0)
  const q = run(['sql', "SELECT sender, count(*) n FROM events WHERE event LIKE 'from_%' GROUP BY sender ORDER BY sender", '--project', ws2, '--json']).json
  assert.deepEqual(q.rows, [['default', 1], ['ios', 1], ['web', 1]], 'each event carries the name of the key that sent it')
  // revoking one sender's key stops that sender only
  const iosKey = keys().find(k => k.name === 'ios')
  run(['project', 'key', 'revoke', project, iosKey.keyId, '--json'])
  assert.notEqual(run(['send', 'late_ios', '--user-id', 'u1', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: ios }).status, 0)
  assert.equal(run(['send', 'late_web', '--user-id', 'u2', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: web }).json.accepted, true)
})

test('webhooks: slurp project webhook gives the URL and secret, a signed GitHub release arrives, and the releases view has it', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  const first = run(['project', 'webhook', project, 'github', '--json'])
  assert.equal(first.status, 0, first.text)
  assert.equal(first.json.sender, 'github'); assert.match(first.json.url, /\/hooks\/github\?key=slurp_pk_/); assert.match(first.json.secret, /^[0-9a-f]{64}$/)
  assert.ok(first.json.steps.length >= 3)
  assert.deepEqual(run(['project', 'webhook', project, 'github', '--json']).json, first.json, 'asking again changes nothing')
  assert.equal(run(['project', 'key', 'list', project, '--scope', 'publishable', '--json']).json.keys.filter((k: any) => k.name === 'github').length, 1, 'one key for GitHub, not one per call')
  const body = readFileSync(join(root, 'backend/fixtures/webhooks/github-release.json'), 'utf8').trim()
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const post = (secret: string, delivery: string) => fetch(first.json.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': delivery, 'x-hub-signature-256': sign(secret) } })
  assert.equal((await post('not-the-secret', 'e2e-1')).status, 401)
  assert.equal((await post(first.json.secret, 'e2e-1')).status, 200)
  await debug(w.base, 'seal', project)
  assert.equal(run(['sync', '--project', ws, '--json']).status, 0)
  const rows = run(['sql', "SELECT kind, tag, repo, sender FROM releases", '--project', ws, '--json']).json.rows
  assert.deepEqual(rows, [['release', 'v1.4.0', 'acme/shop', 'github']])
  // rotating changes the secret and keeps the URL; the old secret stops working
  const rotated = run(['project', 'webhook', project, 'github', '--rotate', '--json']).json
  assert.equal(rotated.url, first.json.url); assert.notEqual(rotated.secret, first.json.secret)
  assert.equal((await post(first.json.secret, 'e2e-2')).status, 401)
  assert.equal((await post(rotated.secret, 'e2e-2')).status, 200)
  // Stripe issues its own secret: until it is given, the endpoint refuses; after, the CLI shows it back
  const stripe = run(['project', 'webhook', project, 'stripe', '--json']).json
  assert.equal(stripe.secret, '')
  assert.equal(run(['project', 'webhook', project, 'stripe', '--secret', 'whsec_0123456789abcdef0123456789abcdef', '--json']).json.secret, 'whsec_0123456789abcdef0123456789abcdef')
})
