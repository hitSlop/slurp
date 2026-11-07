import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RetentionGapError } from '../src/slurp.gen.ts'
import { admin, debug, evt, newProject, post, readArchives, startWorker, stats } from './harness.ts'

const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`
const ids = (arcs: { lines: any[] }[]) => arcs.flatMap(a => a.lines.map(l => l.id))

test('crash after the seal intent: replay seals the same frozen rows once, late events go to the next archive', async () => {
  const w = await startWorker()
  try {
    const s = await newProject(w.base, name('crash'))
    for (let i = 0; i < 5; i++) await post(w.base, s.pk, evt(`early${i}`))
    const rotated = await debug(w.base, 'rotate', s.id)         // intent persisted, R2 put "never happened"
    assert.deepEqual(Object.keys(rotated).sort(), ['gen', 'seq'])
    for (let i = 0; i < 3; i++) await post(w.base, s.pk, evt(`late${i}`)) // arrive while the seal is pending
    assert.equal((await stats(w.base, s.id)).sealing.seq, 1)
    const first = await debug(w.base, 'seal', s.id)              // replay: finishes the frozen generation
    assert.equal(first.seq, 1); assert.equal(first.events, 5)
    assert.equal((await debug(w.base, 'seal', s.id)).events, 3)  // the late events seal separately
    assert.equal(await debug(w.base, 'seal', s.id), null)        // nothing left, idempotent
    const arcs = await readArchives(w.base, s.id, s.sk)
    assert.deepEqual(ids(arcs).sort(), [...Array(5).keys()].map(i => `early${i}`).concat([...Array(3).keys()].map(i => `late${i}`)).sort())
    assert.equal(new Set(ids(arcs)).size, 8, 'no duplicates')
    assert.deepEqual(arcs.map(a => a.name.slice(0, 20)), ['00000000000000000001', '00000000000000000002'])
  } finally { await w.stop() }
})

test('sealing drops the frozen table instead of deleting rows (DELETE bills per row, DROP bills none)', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '0' })
  try {
    const cost = async (batches: number) => {
      const s = await newProject(w.base, name('rows'))
      const setup = (await stats(w.base, s.id)).rows // the project's own key rows are written before any event
      for (let i = 0; i < batches; i++) await post(w.base, s.pk, evt(`r${i}`))
      const before = (await stats(w.base, s.id)).rows
      assert.equal(before - setup, batches, 'one row per request with group commit off, no secondary index')
      await debug(w.base, 'seal', s.id)
      return (await stats(w.base, s.id)).rows - before
    }
    const small = await cost(4), large = await cost(120)
    console.log(`rows written by a seal: ${small} (4 batches) vs ${large} (120 batches)`)
    assert.equal(large, small, 'seal cost is constant: it must not scale with the number of buffered batches')
  } finally { await w.stop() }
})

test('backpressure: a full buffer answers 429 with Retry-After, and sealing frees space', async () => {
  const w = await startWorker({ BUFFER_CAP_BYTES: '3000', GROUP_COMMIT_MS: '0' })
  try {
    const s = await newProject(w.base, name('cap'))
    const big = Array.from({ length: 8 }, (_, i) => evt(`b${i}`, { data: { pad: 'x'.repeat(60) } })).join('\n')
    assert.equal((await post(w.base, s.pk, big)).status, 200)
    const full = await post(w.base, s.pk, big.replace(/"id":"b/g, '"id":"c'))
    assert.equal(full.status, 429); assert.ok(Number(full.headers.get('retry-after')) > 0)
    await debug(w.base, 'seal', s.id)
    assert.equal((await post(w.base, s.pk, big.replace(/"id":"b/g, '"id":"c'))).status, 200)
  } finally { await w.stop() }
})

test('the alarm seals on its own', async () => {
  const w = await startWorker({ SEAL_INTERVAL_MS: '1500', GROUP_COMMIT_MS: '10' })
  try {
    const s = await newProject(w.base, name('alarm'))
    const ack = await (await post(w.base, s.pk, evt('t1'))).json() as any
    assert.equal(ack.publication.state, 'pending'); assert.ok(ack.publication.estimatedAt)
    const deadline = Date.now() + 15_000
    while ((await stats(w.base, s.id)).manifest === 0) { assert.ok(Date.now() < deadline, 'alarm never sealed'); await new Promise(r => setTimeout(r, 300)) }
    assert.equal(ids(await readArchives(w.base, s.id, s.sk))[0], 't1')
    assert.equal((await stats(w.base, s.id)).alarm, null, 'no alarm armed while idle')
  } finally { await w.stop() }
})

test('retention sweep removes old archives and reports a gap for stale checkpoints', async () => {
  const w = await startWorker({ RETENTION_DAYS: '0.00002' }) // about 1.7 s
  try {
    const s = await newProject(w.base, name('ret'))
    await post(w.base, s.pk, evt('old')); await debug(w.base, 'seal', s.id)
    const [obj] = (await w.clients.archive.listObjects({ project: s.id }, admin)).objects
    assert.equal((await fetch(obj.url)).status, 200)
    await new Promise(r => setTimeout(r, 2500))
    await debug(w.base, 'sweep', s.id)
    assert.equal((await fetch(obj.url)).status, 404, 'R2 object deleted')
    assert.equal((await w.clients.archive.listObjects({ project: s.id }, admin)).objects.length, 0)
    await assert.rejects(w.clients.archive.listObjects({ project: s.id, after: '0' }, admin), RetentionGapError)
    await post(w.base, s.pk, evt('new')); await debug(w.base, 'seal', s.id)
    assert.deepEqual((await w.clients.archive.listObjects({ project: s.id, after: '1' }, admin)).objects.map(o => o.seq), ['2'])
  } finally { await w.stop() }
})

test('an identical retry is never acknowledged before the original is durable', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '400' })
  try {
    const s = await newProject(w.base, name('dupflight'))
    const body = evt('same')
    await debug(w.base, 'fail-flush', s.id)                      // the next group commit fails once
    const [first, retry] = await Promise.all([post(w.base, s.pk, body), (async () => { await new Promise(r => setTimeout(r, 100)); return post(w.base, s.pk, body) })()])
    assert.equal(first.status, 503, 'the original reports the failed commit')
    assert.equal(retry.status, 503, 'the in-flight retry must not claim success for events that were never stored')
    assert.equal((await stats(w.base, s.id)).pending, false)
    const again = await post(w.base, s.pk, body)                  // a later retry is a fresh attempt and succeeds
    assert.equal(again.status, 200); assert.equal(again.headers.get('slurp-duplicate'), null)
    const dup = await post(w.base, s.pk, body)                    // once stored, retries are acknowledged as duplicates
    assert.equal(dup.status, 200); assert.equal(dup.headers.get('slurp-duplicate'), '1')
    await debug(w.base, 'seal', s.id)
    assert.deepEqual(ids(await readArchives(w.base, s.id, s.sk)), ['same'], 'stored exactly once')
  } finally { await w.stop() }
})

test('a concurrent identical retry waits for the commit and then reports a duplicate', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '300' })
  try {
    const s = await newProject(w.base, name('dupok'))
    const body = evt('twice')
    const [a, b] = await Promise.all([post(w.base, s.pk, body), (async () => { await new Promise(r => setTimeout(r, 50)); return post(w.base, s.pk, body) })()])
    assert.deepEqual([a.status, b.status], [200, 200])
    assert.equal(b.headers.get('slurp-duplicate'), '1')
    await debug(w.base, 'seal', s.id)
    assert.deepEqual(ids(await readArchives(w.base, s.id, s.sk)), ['twice'])
  } finally { await w.stop() }
})

test('retention keeps sweeping after the project goes quiet, with no further ingest', async () => {
  const w = await startWorker({ RETENTION_DAYS: '0.00004', SEAL_INTERVAL_MS: '600', GROUP_COMMIT_MS: '10' }) // expires about 3.5 s after sealing
  try {
    const s = await newProject(w.base, name('idle'))
    await post(w.base, s.pk, evt('old'))
    const deadline = Date.now() + 20_000
    while ((await stats(w.base, s.id)).manifest === 0) { assert.ok(Date.now() < deadline, 'never sealed'); await new Promise(r => setTimeout(r, 200)) }
    const st = await stats(w.base, s.id)
    assert.equal(st.pending, false); assert.ok(st.alarm !== null, 'an alarm stays armed for the retention expiry')
    const cov = await w.clients.archive.getCoverage({ project: s.id }, admin)
    assert.equal(cov.publication?.state, 'idle', 'a retention alarm is not a pending publication'); assert.equal(cov.publication?.estimatedAt, undefined)
    while ((await stats(w.base, s.id)).manifest !== 0) { assert.ok(Date.now() < deadline + 20_000, 'old archive never expired'); await new Promise(r => setTimeout(r, 300)) }
    assert.equal((await stats(w.base, s.id)).alarm, null, 'nothing left to wait for')
  } finally { await w.stop() }
})

test('with retention off, coverage reports 0 (kept until deleted), not a made-up window', async () => {
  const w = await startWorker()
  try {
    const s = await newProject(w.base, name('keep'))
    await post(w.base, s.pk, evt('k')); await debug(w.base, 'seal', s.id)
    assert.equal((await w.clients.archive.getCoverage({ project: s.id }, admin)).coverage?.retentionSeconds, 0)
  } finally { await w.stop() }
})

test('a buffered event still seals on time when a retention alarm is armed far ahead', async () => {
  const w = await startWorker({ RETENTION_DAYS: '30', SEAL_INTERVAL_MS: '1200', GROUP_COMMIT_MS: '10' })
  try {
    const s = await newProject(w.base, name('pull'))
    await post(w.base, s.pk, evt('a'))
    const wait = async (n: number) => { const d = Date.now() + 15_000; while ((await stats(w.base, s.id)).manifest < n) { assert.ok(Date.now() < d, `archive ${n} never sealed`); await new Promise(r => setTimeout(r, 200)) } }
    await wait(1)                                                // idle now, alarm armed ~30 days out for retention
    await post(w.base, s.pk, evt('b'))                           // must pull the alarm in to the seal interval
    await wait(2)
    assert.deepEqual(ids(await readArchives(w.base, s.id, s.sk)).sort(), ['a', 'b'])
  } finally { await w.stop() }
})

test('rows stay under the 2 MB Durable Object SQLite limit: huge requests and coalesced bursts are split, nothing is lost', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '300' })
  try {
    const s = await newProject(w.base, name('big'))
    // one 5 MB request (about 1000 records of 5 KB) plus a burst of concurrent 900 KB requests that group commit would otherwise coalesce into one row
    const rec = (id: string) => evt(id, { data: { pad: 'x'.repeat(5000) } })
    const huge = Array.from({ length: 1000 }, (_, i) => rec(`h${i}`)).join('\n')
    assert.ok(huge.length > 5_000_000)
    const burst = Array.from({ length: 4 }, (_, b) => Array.from({ length: 180 }, (_, i) => rec(`b${b}-${i}`)).join('\n'))
    const res = await Promise.all([post(w.base, s.pk, huge), ...burst.map(b => post(w.base, s.pk, b))])
    assert.deepEqual(res.map(r => r.status), [200, 200, 200, 200, 200])
    await debug(w.base, 'seal', s.id)
    const lines = (await readArchives(w.base, s.id, s.sk)).flatMap(a => a.lines)
    assert.equal(lines.length, 1000 + 4 * 180)
    assert.equal(new Set(lines.map(l => l.id)).size, lines.length, 'no loss or duplication')
    assert.equal(new Set(lines.map(l => l.received_seq)).size, lines.length, 'received_seq stays unique across split rows')
  } finally { await w.stop() }
})

test('purge removes every project, archive and stray object so a deployment can be deleted', async () => {
  const w = await startWorker()
  try {
    const a = await newProject(w.base, name('purge_a')), b = await newProject(w.base, name('purge_b'))
    for (const s of [a, b]) { await post(w.base, s.pk, evt('p1')); await debug(w.base, 'seal', s.id) }
    const [obj] = (await w.clients.archive.listObjects({ project: a.id }, admin)).objects
    assert.equal((await fetch(obj.url)).status, 200)
    const unauth = await fetch(`${w.base}/v1/admin/purge`, { method: 'POST', body: '{"confirm":"delete-all-data"}' })
    assert.equal(unauth.status, 401)
    const forbidden = await fetch(`${w.base}/v1/admin/purge`, { method: 'POST', headers: { Authorization: `Bearer ${a.sk}` }, body: '{"confirm":"delete-all-data"}' })
    assert.equal(forbidden.status, 403)
    const unconfirmed = await fetch(`${w.base}/v1/admin/purge`, { method: 'POST', headers: admin, body: '{}' })
    assert.equal(unconfirmed.status, 400)
    assert.equal((await w.clients.project.listProjects({}, admin)).projects.length, 2, 'nothing was deleted without confirmation')
    const done = await (await fetch(`${w.base}/v1/admin/purge`, { method: 'POST', headers: admin, body: '{"confirm":"delete-all-data"}' })).json() as any
    assert.deepEqual([done.ok, done.projects, done.archives], [true, 2, 2])
    assert.equal((await fetch(obj.url)).status, 404, 'archive object is gone from R2')
    assert.equal((await w.clients.project.listProjects({}, admin)).projects.length, 0)
    assert.equal((await post(w.base, a.pk, evt('p2'))).status, 401, 'keys are gone')
    // the deployment is usable again from scratch
    const again = await newProject(w.base, name('after'))
    assert.equal((await post(w.base, again.pk, evt('p3'))).status, 200)
  } finally { await w.stop() }
})
