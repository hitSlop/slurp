// Segment's analytics-swift (the SDK iOS and macOS apps use; Slurp has no Swift SDK of its own), unmodified, against the real Worker.
// sdks/compat/swift is a small SwiftPM program that configures the SDK as docs/sdks.md says (apiHost and cdnHost both "<host>/v1")
// and prints what the SDK itself saw. Skips, saying why, when `swift` or the network is unavailable; CI sets
// SLURP_COMPAT_SWIFT_REQUIRED=1, which makes that a failure.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test, type TestContext } from 'node:test'
import { archived, call, ADMIN_TOKEN, envelopes, newProject, randomName as name, records, startWorker, type Worker } from './worker.ts'

const here = dirname(fileURLToPath(import.meta.url))
const compat = join(here, '../../../sdks/compat/swift')
let w: Worker, binary: string | undefined, why = ''
const scratch = mkdtempSync(join(tmpdir(), 'slurp-compat-swift-'))

before(async () => {
  try { await setup() } finally {
    if (!binary && process.env.SLURP_COMPAT_SWIFT_REQUIRED) throw new Error(`the analytics-swift test is required here but cannot run: ${why}`)
  }
})
async function setup() {
  if (spawnSync('swift', ['--version'], { encoding: 'utf8' }).status !== 0) { why = 'swift is not available'; return }
  // --force-resolved-versions: build exactly what Package.resolved pins (analytics-swift and its two dependencies).
  const args = ['build', '-c', 'release', '--package-path', compat, '--force-resolved-versions']
  const built = spawnSync('swift', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (built.status !== 0) {
    const out = `${built.stdout}\n${built.stderr}`.trim()
    why = `could not build the Swift harness: ${out.slice(-400)}`
    // Only a missing network skips; a compile error is a bug in the harness and must be seen.
    if (!/fetch|clone|resolve|network|internet|offline|timed out|could not connect|certificate|github\.com/i.test(out)) throw new Error(why)
    return
  }
  binary = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' }).stdout.trim() + '/slurp-compat-swift'
  w = await startWorker()
}
after(async () => { if (w) await w.stop(); rmSync(scratch, { recursive: true, force: true }) })

const closedPort = () => new Promise<number>((resolve, reject) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) })
  s.on('error', reject)
})
const dir = () => mkdtempSync(join(scratch, 'storage-'))
interface Summary { scenario: string; pendingAtStart: number; pendingAtEnd: number; settingsApiKey: string | null; requests: { method: string; host: string; path: string }[]; errors: string[]; forbidden: string[]; notes: string[]; library: string; afterEachFlush?: { batchPosts: number; pending: number }[] }
/** One process of the harness: it starts the SDK, runs the scenario, flushes, prints a summary and exits (the app being closed). */
function run(url: string, key: string, scenario: string, storage: string): Summary {
  const r = spawnSync(binary!, [url, key, scenario, storage], { encoding: 'utf8', timeout: 180_000, env: { PATH: process.env.PATH!, HOME: process.env.HOME! } })
  assert.equal(r.status, 0, `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}: ${r.stderr}\n${r.stdout}`)
  const summary = JSON.parse(r.stdout.trim().split('\n').pop()!) as Summary
  assert.deepEqual(summary.forbidden, [], 'the SDK never tried to reach Segment')
  assert.deepEqual(summary.notes, [], 'the harness waited for everything it needed')
  return summary
}
async function project(t: TestContext, prefix: string) {
  if (!binary) { t.skip(why); return null }
  return newProject(w.base, name(prefix))
}
const by = (lines: any[], type: string, event?: string) => lines.filter(l => l.type === type && (event === undefined || l.event === event))
const posts = (s: Summary) => s.requests.filter(r => r.method === 'POST')
/** The three events every scenario captures, as stored. */
function assertThree(lines: any[], senders: string[]) {
  assert.equal(lines.length, 3)
  assert.ok(lines.every(l => l.user_id === 'user_42') && senders.every(s => s === 'default'), 'identified, and sent as the key\'s source')
  assert.deepEqual(by(lines, 'identify')[0].data, { plan: 'pro', email: 'ada@example.com' })
  assert.deepEqual([by(lines, 'track', 'signed_up')[0].data.plan, by(lines, 'track', 'signed_up')[0].data.total], ['pro', 49])
  assert.deepEqual(by(lines, 'track', 'screen')[0].data, { tab: 'main', name: 'Home', category: 'App' }, 'a screen is a track named screen')
  assert.equal(new Set(lines.map(l => l.id)).size, 3, 'each event has its own messageId')
  for (const l of lines) {
    assert.equal(l.context.compat, 'segment')
    assert.deepEqual([l.context.library.name, l.context.library.version], ['analytics-swift', '1.10.4'])
    assert.ok(typeof l.timestamp === 'string')
    assert.ok(!('session_id' in l), 'Segment SDKs send no session')
  }
}

test('analytics-swift: identify, track and screen are delivered and archived as the key\'s source, a screen as a track named screen', async t => {
  const p = await project(t, 'sw_deliver'); if (!p) return
  const s = run(w.base, p.pk, 'deliver', dir())
  assert.equal(s.pendingAtEnd, 0)
  assert.deepEqual(s.errors, [])
  const arcs = await archived(w.base, p)
  assertThree(records(arcs), envelopes(arcs).map(e => e.sender))
  assert.equal(s.library, '1.10.4')
})

test('analytics-swift reads its settings from the Worker and never contacts Segment', async t => {
  const p = await project(t, 'sw_settings'); if (!p) return
  const s = run(w.base, p.pk, 'deliver', dir())
  const host = new URL(w.base).host
  assert.ok(s.requests.length >= 2)
  assert.ok(s.requests.every(r => r.host === new URL(w.base).hostname), `every request went to the Worker: ${JSON.stringify(s.requests)}`)
  assert.ok(s.requests.some(r => r.method === 'GET' && r.path === `/v1/projects/${p.pk}/settings`), 'the settings came from /v1/projects/<key>/settings on the Worker')
  assert.equal(s.settingsApiKey, p.pk, 'the SDK holds settings the Worker served (its built-in defaults carry no apiKey)')
  assert.ok(posts(s).every(r => r.path === '/v1/b'), 'events went to /v1/b')
  assert.deepEqual(s.errors, [], `no settings or upload failure on ${host}`)
})

test('analytics-swift keeps events captured while the Worker is unreachable on disk, and a later launch delivers them', async t => {
  const p = await project(t, 'sw_offline'); if (!p) return
  const storage = dir()
  const dead = `http://127.0.0.1:${await closedPort()}`
  const first = run(dead, p.pk, 'queue-offline', storage)
  // The SDK writes batch files as it flushes, so how many files hold the three events is up to timing; at least one must remain.
  assert.ok(first.pendingAtEnd >= 1, 'a batch is still on disk when the first launch ends')
  assert.ok(first.errors.some(e => /Could not connect/.test(e)), `the SDK reported connection failures: ${first.errors}`)
  assert.equal((await archived(w.base, p)).length, 0, 'nothing reached the Worker')
  // The next launch does not flush by itself (the interval is 30 s by default and the count policy waits for a new event):
  // the harness flushes, as an app does on its first foreground or interval.
  const second = run(w.base, p.pk, 'deliver-queued', storage)
  assert.equal(second.pendingAtStart, first.pendingAtEnd, 'the queue survived the restart')
  assert.equal(second.pendingAtEnd, 0)
  assert.equal(posts(second).length, first.pendingAtEnd, 'one request per queued batch')
  const arcs = await archived(w.base, p)
  assertThree(records(arcs), envelopes(arcs).map(e => e.sender))
})

test('analytics-swift with a revoked key: the Worker answers 400, so each batch is sent once and dropped instead of retried for ever', async t => {
  const p = await project(t, 'sw_revoked'); if (!p) return
  const keys = (await call(w.base, ADMIN_TOKEN, 'ListKeys', { project: p.id, scope: 'publishable' })).keys
  await call(w.base, ADMIN_TOKEN, 'RevokeKey', { project: p.id, keyId: keys.find(k => k.key === p.pk)!.keyId })
  const storage = dir()
  const s = run(w.base, p.pk, 'flush3', storage)
  // analytics-swift (1.10.4) drops a batch only on 400 and resends every queued batch at every flush after a 401, for ever. The
  // Segment endpoints therefore refuse a bad write key with 400: the first flush sends each batch once, and nothing is sent again.
  assert.ok(s.errors.some(e => /400/.test(e)), `the SDK reported the 400: ${s.errors}`)
  const sent = s.afterEachFlush![0].batchPosts
  assert.ok(sent >= 1)
  assert.deepEqual(s.afterEachFlush!.map(f => f.pending), [0, 0, 0], 'the refused batches are dropped')
  assert.deepEqual(s.afterEachFlush!.map(f => f.batchPosts), [sent, sent, sent], 'and later flushes send nothing more')
  assert.equal((await archived(w.base, p)).length, 0, 'nothing was stored')
  // A new key for the same source starts with an empty queue: analytics-swift keeps its queue in a folder named after the write key
  // (the harness keeps that layout under its storage directory). The refused batches were dropped, so nothing is left behind either.
  const fresh = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: p.id, scope: 'publishable', source: 'default' })).key.key!
  const rotated = run(w.base, fresh, 'flush3', storage)
  assert.equal(rotated.pendingAtStart, 0, 'the new key does not see the old queue')
  assert.equal(rotated.pendingAtEnd, 0)
  assert.equal(readdirSync(join(storage, p.pk)).filter(f => f.endsWith('.temp')).length, 0, 'the refused batches were dropped, not left on disk')
  const arcs = await archived(w.base, p)
  assertThree(records(arcs), envelopes(arcs).map(e => e.sender)) // exactly the three new events
})
