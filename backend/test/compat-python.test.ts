// The real Python SDKs, unmodified, against the real Worker: segment-analytics-python (change the host) and sentry-sdk (change the
// DSN). Skips, saying why, when Python or the network is unavailable (CI sets SLURP_COMPAT_REQUIRED=1, which makes that a failure). SLURP_COMPAT_VENV points at a venv that already has
// sdks/compat/python/requirements.txt installed (otherwise one is created in a temporary folder).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test, type TestContext } from 'node:test'
import { archived, envelopes, newProject, randomName as name, records, startWorker, type Worker } from './harness.ts'

const here = dirname(fileURLToPath(import.meta.url))
const compat = join(here, '../../sdks/compat/python')
let w: Worker, python: string | undefined, why = '', scratch: string | undefined

before(async () => {
  try { await setup() } finally {
    if (!python && process.env.SLURP_COMPAT_REQUIRED) throw new Error(`the Python SDK tests are required here but cannot run: ${why}`)
  }
})
async function setup() {
  const system = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if (system.status !== 0) { why = 'python3 is not available'; return }
  if (process.env.SLURP_COMPAT_VENV) python = join(process.env.SLURP_COMPAT_VENV, 'bin/python')
  else {
    scratch = mkdtempSync(join(tmpdir(), 'slurp-compat-py-'))
    const made = spawnSync('python3', ['-m', 'venv', join(scratch, 'venv')], { encoding: 'utf8' })
    const installed = made.status === 0 && spawnSync(join(scratch, 'venv/bin/pip'), ['install', '-q', '-r', join(compat, 'requirements.txt')], { encoding: 'utf8' })
    if (!installed || installed.status !== 0) { why = `could not install the Python SDKs (needs network): ${(installed && installed.stderr || made.stderr).trim().slice(-200)}`; return }
    python = join(scratch, 'venv/bin/python')
  }
  w = await startWorker()
}
after(async () => { if (w) await w.stop(); if (scratch) rmSync(scratch, { recursive: true, force: true }) })

async function run(t: TestContext, scenario: string, key?: string) {
  if (!python) { t.skip(why); return null }
  const p = await newProject(w.base, name(`py_${scenario.replace(/-/g, '_')}`))
  // cwd is the script's folder: Sentry treats code under the working directory as the application's own (in_app).
  const r = spawnSync(python, [join(compat, 'run.py'), scenario], { cwd: compat, encoding: 'utf8', env: { PATH: process.env.PATH!, BASE: w.base, KEY: key ?? p.pk } })
  assert.equal(r.status, 0, r.stderr)
  const summary = JSON.parse(r.stdout.trim().split('\n').pop()!)
  const arcs = await archived(w.base, p)
  return { summary, lines: records(arcs), senders: envelopes(arcs).map(e => e.sender) }
}
const by = (lines: any[], type: string, event?: string) => lines.filter(l => l.type === type && (event === undefined || l.event === event))

for (const scenario of ['segment', 'segment-gzip']) {
  test(`segment-analytics-python ${scenario === 'segment' ? '' : 'with gzip '}lands identify, track and page as the project's events`, async t => {
    const got = await run(t, scenario)
    if (!got) return
    assert.deepEqual(got.summary.errors, [], 'the SDK reported no errors')
    const { lines } = got
    assert.equal(lines.length, 4)
    assert.ok(lines.every(l => l.user_id === 'user_42') && got.senders.every(s => s === 'default'))
    assert.deepEqual(by(lines, 'identify')[0].data, { plan: 'pro', email: 'ada@example.com' })
    assert.equal(by(lines, 'track', 'signed_up')[0].data.total, 49)
    assert.equal(by(lines, 'track', 'exported')[0].anonymous_id, 'anon-1')
    assert.deepEqual(by(lines, 'track', 'page')[0].data, { path: '/docs/start', name: 'Getting started', category: 'Docs' }, 'a page view is a track named page')
    for (const l of lines) assert.deepEqual([l.context.library.name, l.context.library.version, l.context.compat], ['analytics-python', '2.4.0', 'segment'])
    // The adapter re-serializes JSON (documented): a number beyond double precision is rounded, not rejected.
    assert.equal(Number(by(lines, 'track', 'signed_up')[0].data.wide), 12345678901234567890)
  })
}

test('segment-analytics-python with a wrong write key: the SDK reports the 401 once and drops the batch instead of retrying', async t => {
  const got = await run(t, 'segment-wrong-key')
  if (!got) return
  assert.equal(got.summary.errors.length, 1)
  assert.match(got.summary.errors[0].error, /401/)
  assert.equal(got.summary.errors[0].items, 4)
  assert.equal(got.lines.length, 0, 'nothing was stored')
})

test('sentry-sdk for Python: a real exception and a message arrive whole, with the user, release and tags', async t => {
  const got = await run(t, 'sentry')
  if (!got) return
  const { lines } = got
  const error = by(lines, 'track', 'error')[0], message = by(lines, 'track', 'message')[0]
  assert.ok(error && message, `events: ${lines.map(l => l.event)}`)
  assert.equal(lines.length, 2, 'only the two events: sessions and client reports are accepted and dropped')
  assert.ok(lines.every(l => l.user_id === 'user_42') && got.senders.every(s => s === 'default'))
  assert.equal(error.data.exception.values[0].type, 'ZeroDivisionError')
  assert.ok(error.data.exception.values[0].stacktrace.frames.some((f: any) => f.function === 'charge' && f.in_app === true), 'the traceback names the function that failed')
  assert.deepEqual([error.data.release, error.data.environment, error.data.tags.feature], ['shop@1.4.0', 'test', 'checkout'])
  assert.deepEqual([message.data.message, message.data.level], ['checkout is slow', 'warning'])
  for (const l of [error, message]) assert.deepEqual([l.context.library.name, l.context.library.version, l.context.compat], ['sentry.python', '2.74.0', 'sentry'])
})
