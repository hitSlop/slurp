// Contract test: the real Rust CLI against the real Worker (wrangler dev). Skips when the CLI binary or DuckDB 2 is missing.
//   cargo build -p slurp-cli && npm test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  assert.equal(ok.status, 0, ok.text); assert.equal(ok.json.user.id, 'admin'); assert.equal(ok.json.backend, w.base)
  // saved: later commands need neither SLURP_TOKEN nor --backend
  assert.equal(run(['whoami']).json.id, 'admin')
  assert.equal(run(['source', 'list']).status, 0)
})

test('init -> send -> sync (gzip archive) -> sql, idempotent, with geo and exact wide numbers', { skip }, async () => {
  const setup = run(['setup', '--library', join(home, 'library'), '--duckdb', duckdb, '--no-connect', '--no-open', '--json'])
  assert.equal(setup.status, 0, setup.text)
  const init = run(['init', '--name', 'Contract App', '--workspace', ws, '--data-dir', join(ws, 'data'), '--duckdb', duckdb, '--no-open', '--no-install-skills', '--no-agent-notes', '--json'])
  assert.equal(init.status, 0, init.text)
  const source = run(['status', '--workspace', ws, '--json']).json.source as string
  assert.match(source, /^src_/)
  for (const i of [1, 2, 3]) assert.equal(run(['send', 'signed_up', '--user-id', `u${i}`, '--data', '{"amount":12345678901234567890}', '--workspace', ws, '--json']).json.accepted, true)
  assert.equal(run(['send', 'page_view', '--user-id', 'u1', '--workspace', ws, '--json']).json.accepted, true)
  // nothing is published yet
  assert.equal(run(['sync', '--workspace', ws, '--json']).json.downloaded, 0)
  await debug(w.base, 'seal', source)
  const first = run(['sync', '--workspace', ws, '--json'])
  assert.equal(first.status, 0, first.text); assert.equal(first.json.downloaded, 1); assert.equal(first.json.imported, 4)
  const q = run(['sql', "SELECT event, count(*) n, any_value(data->>'$.amount') amount, any_value(context->>'$.geo.provider') provider FROM events GROUP BY event ORDER BY event", '--workspace', ws, '--json']).json
  assert.deepEqual(q.rows.map((r: any[]) => [r[0], r[1]]), [['page_view', 1], ['signed_up', 3]])
  assert.equal(q.rows[1][2], '12345678901234567890', 'wide number is exact end to end')
  assert.equal(q.rows[1][3], 'cloudflare', 'geo enrichment reached the local database')
  const again = run(['sync', '--workspace', ws, '--json'])
  assert.deepEqual([again.json.downloaded, again.json.imported], [0, 0], 'second sync is a no-op')
  // a second archive resumes from the checkpoint
  run(['send', 'late', '--user-id', 'u9', '--workspace', ws, '--json']); await debug(w.base, 'seal', source)
  const next = run(['sync', '--workspace', ws, '--json'])
  assert.deepEqual([next.json.downloaded, next.json.imported, next.json.checkpoint], [1, 1, '2'])
  assert.equal(run(['sql', 'SELECT count(*) FROM events', '--workspace', ws, '--json']).json.rows[0][0], 5)
  // the CLI cannot read with a publishable key; revoking the saved admin token breaks nothing else
  assert.equal((await fetch(`${w.base}/rpc/Archive/ListObjects`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ source }) })).status, 200)
})
