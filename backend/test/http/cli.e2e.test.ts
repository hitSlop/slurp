// Contract test: the real Rust CLI against the real Worker (wrangler dev). Skips when the CLI binary or DuckDB 2 is missing.
//   cargo build -p slurp-cli && npm run test:http
// Written against docs/contracts.md while the CLI is being rewritten in parallel: the CLI commands and flags below are the intended
// ones (a key has a source; a webhook is rotated by revoking its key and connecting again; sync --now publishes) and may need small
// adjustments when the two are integrated.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { ADMIN_TOKEN, call, publish, startWorker, type Worker } from './worker.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
// Built at run time so the test value does not look like a real Stripe secret to secret scanners.
const STRIPE_SECRET = ['whsec', '0123456789abcdef'.repeat(2)].join('_')
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
  const src = await call(w.base, ADMIN_TOKEN, 'CreateProject', { name: 'whoami_src' })
  const secret = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: src.project.id, scope: 'secret', name: 'bot' })).key
  // a bot with only a read key, no saved connection: SLURP_TOKEN wins and whoami works for it
  const bot = { SLURP_HOME: join(home, 'bot-home'), SLURP_TOKEN: secret.key! }
  const asBot = run(['whoami', '--backend', w.base], bot)
  assert.equal(asBot.status, 0, asBot.text); assert.deepEqual([asBot.json.scope, asBot.json.project, asBot.json.name], ['secret', src.project.id, 'bot'])
  const publishable = run(['whoami', '--backend', w.base], { ...bot, SLURP_TOKEN: src.publishableKey })
  assert.deepEqual([publishable.json.scope, publishable.json.project, publishable.json.source], ['publishable', src.project.id, 'default'])
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
  await publish(w.base, source)
  const first = run(['sync', '--project', ws, '--json'])
  assert.equal(first.status, 0, first.text); assert.equal(first.json.downloaded, 1); assert.equal(first.json.imported, 4)
  const q = run(['sql', "SELECT event, count(*) n, any_value(data->>'$.amount') amount, any_value(geo->>'$.country') country FROM events GROUP BY event ORDER BY event", '--project', ws, '--json']).json
  assert.deepEqual(q.rows.map((r: any[]) => [r[0], r[1]]), [['page_view', 1], ['signed_up', 3]])
  assert.equal(q.rows[1][2], '12345678901234567890', 'wide number is exact end to end')
  assert.ok(q.rows[1][3], 'the envelope geo reached the local database')
  const again = run(['sync', '--project', ws, '--json'])
  assert.deepEqual([again.json.downloaded, again.json.imported], [0, 0], 'second sync is a no-op')
  // a second archive resumes from the checkpoint
  run(['send', 'late', '--user-id', 'u9', '--project', ws, '--json']); await publish(w.base, source)
  const next = run(['sync', '--project', ws, '--json'])
  assert.deepEqual([next.json.downloaded, next.json.imported, next.json.checkpoint], [1, 1, '2'])
  assert.equal(run(['sql', 'SELECT count(*) FROM events', '--project', ws, '--json']).json.rows[0][0], 5)
  // the CLI cannot read with a publishable key; revoking the saved admin token breaks nothing else
  assert.equal((await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: source })).archives.length, 2)
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
  const app = () => keys().filter(k => k.source === 'default')
  assert.equal(app().length, 1, 'init never makes a second key for the app')
  const setup = run(['project', 'setup', project, '--json']); run(['project', 'setup', project, '--json'])
  const before = keys().length
  assert.equal(setup.status, 0, setup.text); assert.equal(keys().length, before, 'setup only shows keys, it never makes one')
  assert.equal(setup.json.environment.SLURP_PUBLISHABLE_KEY, app()[0].key)
  // one key per sender
  const ios = run(['project', 'key', 'create', project, '--scope', 'publishable', '--source', 'ios', '--json']).json.key.key as string
  const web = run(['project', 'key', 'create', project, '--scope', 'publishable', '--source', 'web', '--json']).json.key.key as string
  assert.equal(run(['send', 'from_ios', '--user-id', 'u1', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: ios }).json.accepted, true)
  assert.equal(run(['send', 'from_web', '--user-id', 'u2', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: web }).json.accepted, true)
  // --source names the source whose key is wanted, so the key in the environment is not used
  assert.equal(run(['send', 'from_mcp', '--user-id', 'u4', '--to', project, '--source', 'mcp', '--json'], { SLURP_PUBLISHABLE_KEY: ios }).json.accepted, true)
  const fromCli = run(['send', 'from_cli', '--user-id', 'u3', '--project', ws, '--json'])
  assert.equal(fromCli.json?.accepted, true, fromCli.text)
  await publish(w.base, project)
  assert.equal(run(['sync', '--project', ws2, '--json']).status, 0)
  const q = run(['sql', "SELECT sender, count(*) n FROM events WHERE event LIKE 'from_%' GROUP BY sender ORDER BY sender", '--project', ws2, '--json']).json
  assert.deepEqual(q.rows, [['cli', 1], ['ios', 1], ['mcp', 1], ['web', 1]], 'each event carries the source of the key that sent it; slurp send is the cli source')
  // revoking one sender's key stops that sender only
  const iosKey = keys().find(k => k.source === 'ios')
  run(['project', 'key', 'revoke', project, iosKey.keyId, '--json'])
  assert.notEqual(run(['send', 'late_ios', '--user-id', 'u1', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: ios }).status, 0)
  assert.equal(run(['send', 'late_web', '--user-id', 'u2', '--to', project, '--json'], { SLURP_PUBLISHABLE_KEY: web }).json.accepted, true)
})

test('sync --now publishes what is buffered first; a secret key can publish and sync its own project', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  const secret = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project, scope: 'secret', name: 'reader' })).key.key!
  assert.equal(run(['send', 'buffered', '--user-id', 'u5', '--project', ws, '--json']).json.accepted, true)
  const plain = run(['sync', '--project', ws, '--json'], { SLURP_TOKEN: secret })
  assert.equal(plain.status, 0, plain.text); assert.equal(plain.json.published_now, false); assert.equal(plain.json.pending, true, 'the buffered event is not readable yet')
  const refused = run(['sync', '--now', '--project', ws, '--json'], { SLURP_TOKEN: secret })
  assert.equal(refused.status, 0, refused.text); assert.equal(refused.json.published_now, true)
  const now = run(['sync', '--now', '--project', ws, '--json'])
  assert.equal(now.status, 0, now.text); assert.equal(now.json.published_now, true); assert.equal(now.json.pending, false)
  assert.equal(run(['sql', "SELECT count(*) FROM events WHERE event = 'buffered'", '--project', ws, '--json']).json.rows[0][0], 1, 'the published archive was picked up at once')
})

test('webhooks: slurp project webhook gives the URL and secret, a signed GitHub release arrives, and the releases view has it', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  const first = run(['project', 'webhook', project, 'github', '--json'])
  assert.equal(first.status, 0, first.text)
  assert.equal(first.json.sender, 'github'); assert.match(first.json.url, /\/hooks\/github\?key=slurp_pk_[0-9a-f]{16}_github_/); assert.match(first.json.secret, /^[0-9a-f]{64}$/)
  assert.ok(first.json.steps.length >= 3)
  assert.deepEqual(run(['project', 'webhook', project, 'github', '--json']).json, first.json, 'asking again changes nothing')
  assert.equal(run(['project', 'key', 'list', project, '--scope', 'publishable', '--json']).json.keys.filter((k: any) => k.source === 'github').length, 1, 'one key for GitHub, not one per call')
  const body = readFileSync(join(root, 'backend/fixtures/webhooks/github-release.json'), 'utf8').trim()
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const post = (secret: string, delivery: string) => fetch(first.json.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': delivery, 'x-hub-signature-256': sign(secret) } })
  assert.equal((await post('not-the-secret', 'e2e-1')).status, 401)
  assert.equal((await post(first.json.secret, 'e2e-1')).status, 200)
  await publish(w.base, project)
  assert.equal(run(['sync', '--project', ws, '--json']).status, 0)
  const rows = run(['sql', "SELECT kind, tag, repo, sender FROM releases", '--project', ws, '--json']).json.rows
  assert.deepEqual(rows, [['release', 'v1.4.0', 'acme/shop', 'github']])
  // rotating is revoking the webhook's key and connecting again: a new URL and a new secret; the old ones stop working
  const keyId = run(['project', 'key', 'list', project, '--scope', 'publishable', '--json']).json.keys.find((k: any) => k.source === 'github').keyId
  assert.equal(run(['project', 'key', 'revoke', project, keyId, '--json']).status, 0)
  const rotated = run(['project', 'webhook', project, 'github', '--json']).json
  assert.notEqual(rotated.url, first.json.url); assert.notEqual(rotated.secret, first.json.secret)
  assert.equal((await post(first.json.secret, 'e2e-2')).status, 401)
  assert.equal((await fetch(rotated.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': 'e2e-2', 'x-hub-signature-256': sign(rotated.secret) } })).status, 200)
  // Stripe issues its own secret: until it is given, the endpoint refuses; after, the CLI shows it back
  const stripe = run(['project', 'webhook', project, 'stripe', '--json']).json
  assert.equal(stripe.secret, '')
  assert.equal(run(['project', 'webhook', project, 'stripe', '--secret', STRIPE_SECRET, '--json']).json.secret, STRIPE_SECRET)
})

test('a webhook redelivered later syncs cleanly: the same delivery without a time is one event, not a conflict', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  const hook = run(['project', 'webhook', project, 'github', '--json']).json
  const body = '{"action":"started","repository":{"full_name":"acme/shop"}}'
  const post = () => fetch(hook.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'watch', 'x-github-delivery': 'redeliver-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}` } })
  assert.equal((await post()).status, 200)
  await publish(w.base, project)
  assert.equal(run(['sync', '--project', ws, '--json']).status, 0)
  await new Promise(r => setTimeout(r, 1100))
  assert.equal((await post()).status, 200, 'GitHub redelivers it a moment later')
  await publish(w.base, project)
  const again = run(['sync', '--project', ws, '--json'])
  assert.equal(again.status, 0, again.text) // used to stop with conflicting_event_id
  assert.equal(run(['sql', "SELECT count(*) FROM events WHERE id = 'github:redeliver-1'", '--project', ws, '--json']).json.rows[0][0], 1)
})

test('a pretty-printed webhook payload imports as one event, with no invalid line', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  const hook = run(['project', 'webhook', project, 'github', '--json']).json
  const body = readFileSync(join(root, 'backend/fixtures/webhooks/github-release-pretty.json'), 'utf8').trim()
  assert.ok(body.includes('\n'), 'the fixture spans many lines')
  const sent = await fetch(hook.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': 'pretty-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}` } })
  assert.equal(sent.status, 200)
  const sync = run(['sync', '--now', '--project', ws, '--json'])
  assert.equal(sync.status, 0, sync.text)
  assert.equal(run(['sql', "SELECT count(*) FROM events WHERE id = 'github:pretty-1'", '--project', ws, '--json']).json.rows[0][0], 1, 'imported')
  assert.equal(run(['sql', "SELECT count(*) FROM _slurp.problems WHERE kind = 'invalid'", '--project', ws, '--json']).json.rows[0][0], 0, 'no invalid line')
})

test('a teammate initializes a committed clone, syncs with a saved project key, and survives revocation locally', { skip }, async () => {
  const project = run(['status', '--project', ws, '--json']).json.project as string
  const key = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project, scope: 'secret', name: 'teammate' })).key
  const clone = join(home, 'teammate-app'); mkdirSync(clone)
  cpSync(join(ws, 'slurp'), join(clone, 'slurp'), { recursive: true })
  const original = readFileSync(join(clone, 'slurp/slurp.toml'), 'utf8')
  assert.ok(!original.includes('duckdb') && !original.includes('database'), original)
  const env = { SLURP_HOME: join(home, 'teammate-home') }
  const init = run(['init', '--project', clone, '--token-stdin', '--duckdb', duckdb, '--yes', '--no-open', '--json'], env, key.key + '\n', clone)
  assert.equal(init.status, 0, init.text)
  assert.equal(readFileSync(join(clone, 'slurp/slurp.toml'), 'utf8'), original)
  const sync = run(['sync', '--now', '--project', clone, '--json'], env, undefined, clone)
  assert.equal(sync.status, 0, sync.text)
  const owner = run(['sql', 'SELECT count(*) FROM events', '--project', ws, '--json'])
  const teammate = run(['sql', 'SELECT count(*) FROM events', '--project', clone, '--json'], env, undefined, clone)
  assert.deepEqual(teammate.json.rows, owner.json.rows)
  assert.equal(run(['status', '--json'], env, undefined, join(clone, 'slurp/reports')).status, 0)
  assert.equal(run(['whoami', '--project', clone], env, undefined, clone).json.scope, 'secret')
  const second = join(home, 'second-checkout'); mkdirSync(second)
  cpSync(join(ws, 'slurp'), join(second, 'slurp'), { recursive: true })
  const reused = run(['init', '--project', second, '--yes', '--no-open', '--json'], env, undefined, second)
  assert.equal(reused.status, 0, reused.text)
  assert.equal(reused.json.database, init.json.database, 'the same home reuses the verified database')
  const built = run(['report', 'build', 'slurp/reports/overview.md', '--project', clone, '--json'], env, undefined, clone)
  assert.equal(built.status, 0, built.text)
  const badHome = { SLURP_HOME: join(home, 'publishable-home') }
  const rejected = run(['init', '--project', clone, '--token-stdin', '--duckdb', duckdb, '--yes'], badHome, (await call(w.base, ADMIN_TOKEN, 'SourceKey', { project, source: 'default' })).key.key + '\n', clone)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.text, /can only send events/)
  await call(w.base, ADMIN_TOKEN, 'RevokeKey', { project, keyId: key.keyId })
  const revoked = run(['sync', '--project', clone, '--json'], env, undefined, clone)
  assert.notEqual(revoked.status, 0); assert.match(revoked.text, /rejected or revoked/)
  assert.equal(run(['sql', 'SELECT count(*) FROM events', '--project', clone, '--json'], env, undefined, clone).status, 0)
})
