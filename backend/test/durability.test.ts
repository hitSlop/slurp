// Durability: what survives a crash or a restart, publication that races itself, size limits, backpressure and retention.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { ADMIN_TOKEN, ApiError, admin, call, debug, evt, ids, newProject, post, publish, randomName as name, readArchives, startWorker, stats, until } from './harness.ts'

const seqs = (arcs: { seq: number }[]) => arcs.map(a => a.seq)
const post_ = async (w: { base: string }, p: { pk: string }, id: string) => assert.equal((await post(w.base, p.pk, evt(id))).status, 200)
const archivedAll = async (w: { base: string }, p: { id: string; sk: string }) => { await publish(w.base, p.id); return readArchives(w.base, p.id, p.sk) }
const failsWith503 = (p: Promise<unknown>) => assert.rejects(p, (e: ApiError) => e instanceof ApiError && e.status === 503 && e.code === 'unavailable')

test('a publish that died after its intent was stored is finished by the restarted Worker as seq 1, and later events become seq 2', async () => {
  const w = await startWorker({}, { keep: true })
  try {
    const p = await newProject(w.base, name('crash'))
    for (let i = 0; i < 5; i++) await post_(w, p, `early${i}`)
    await debug(w.base, 'fail-archive', p.id)
    await failsWith503(publish(w.base, p.id))                       // the intent is stored; the R2 put never happened
    for (let i = 0; i < 3; i++) await post_(w, p, `late${i}`)       // these arrive while that publish is unfinished
    const before = await stats(w.base, p.id)
    assert.deepEqual([before.intent.seq, before.manifest, before.chunks], [1, 0, 8])
    await w.restart()                                               // nothing in memory survives; the fault is gone too
    await until(async () => (await stats(w.base, p.id)).manifest === 2, 'the restarted object to publish by itself')
    const arcs = await readArchives(w.base, p.id, p.sk)
    assert.deepEqual(seqs(arcs), [1, 2], 'gapless')
    assert.deepEqual(ids([arcs[0]]), [0, 1, 2, 3, 4].map(i => `early${i}`), 'the stored choice was replayed as seq 1')
    assert.deepEqual(ids([arcs[1]]), [0, 1, 2].map(i => `late${i}`))
    const after = await stats(w.base, p.id)
    assert.deepEqual([after.intent, after.chunks, after.pending], [null, 0, false])
  } finally { await w.stop() }
})

test('post, restart, post, publish: every event is there once and the archives are gapless', async () => {
  const w = await startWorker({}, { keep: true })
  try {
    const p = await newProject(w.base, name('restart'))
    for (let i = 0; i < 4; i++) await post_(w, p, `a${i}`)
    await call(w.base, ADMIN_TOKEN, 'Publish', { project: p.id })
    for (let i = 0; i < 4; i++) await post_(w, p, `b${i}`)     // committed, not yet published
    await w.restart()
    for (let i = 0; i < 4; i++) await post_(w, p, `c${i}`)
    const { coverage } = await publish(w.base, p.id)
    assert.deepEqual([coverage.first, coverage.last, coverage.pending], [1, 2, false])
    const arcs = await readArchives(w.base, p.id, p.sk)
    assert.deepEqual(seqs(arcs), [1, 2])
    assert.deepEqual(ids(arcs).sort(), ['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3', 'c0', 'c1', 'c2', 'c3'])
    // the project's keys also survived the restart
    assert.equal((await post(w.base, p.pk, evt('after'))).status, 200)
  } finally { await w.stop() }
})

test('a publish that died after the R2 put, then a restart: one manifest row per seq, no gap, nothing twice', async () => {
  const w = await startWorker({}, { keep: true })
  try {
    const p = await newProject(w.base, name('afterput'))
    for (let i = 0; i < 3; i++) await post_(w, p, `x${i}`)
    await debug(w.base, 'fail-after-put', p.id)
    await failsWith503(publish(w.base, p.id))                       // seq 1 is in R2 but not in the manifest
    assert.deepEqual([(await stats(w.base, p.id)).manifest, (await stats(w.base, p.id)).intent.seq], [0, 1])
    assert.equal((await call(w.base, p.sk, 'ListArchives', { project: p.id })).archives.length, 0, 'an object that is not in the manifest is not listed')
    assert.equal((await fetch(`${w.base}/v1/projects/${p.id}/archives/1`, { headers: admin })).status, 404, 'nor served')
    await w.restart()
    await post_(w, p, 'y0')
    await publish(w.base, p.id)
    const arcs = await readArchives(w.base, p.id, p.sk)
    assert.deepEqual(seqs(arcs), [1, 2])
    assert.deepEqual(ids(arcs), ['x0', 'x1', 'x2', 'y0'])
    const st = await stats(w.base, p.id)
    assert.deepEqual([st.manifest, st.intent, st.chunks], [2, null, 0], 'one manifest row per seq')
  } finally { await w.stop() }
})

test('Publish racing the alarm and another Publish: one archive per intent, nothing twice', async () => {
  const w = await startWorker({}, { keep: true })
  try {
    const p = await newProject(w.base, name('race'))
    for (let i = 0; i < 6; i++) await post_(w, p, `r${i}`)
    const results = await Promise.all([debug(w.base, 'alarm', p.id, '?force=1'), publish(w.base, p.id), publish(w.base, p.id), publish(w.base, p.id)])
    assert.ok(results.every(Boolean))
    const st = await stats(w.base, p.id)
    assert.deepEqual([st.manifest, st.chunks, st.intent], [1, 0, null], 'one publication served them all')
    assert.deepEqual(ids(await readArchives(w.base, p.id, p.sk)), [0, 1, 2, 3, 4, 5].map(i => `r${i}`))
    // and again with a stored intent waiting: the concurrent callers share the replay
    for (let i = 6; i < 9; i++) await post_(w, p, `r${i}`)
    await debug(w.base, 'fail-archive', p.id)
    await failsWith503(publish(w.base, p.id))
    await w.restart()
    await Promise.all([publish(w.base, p.id), debug(w.base, 'alarm', p.id, '?force=1'), publish(w.base, p.id)])
    assert.deepEqual(seqs(await readArchives(w.base, p.id, p.sk)), [1, 2], 'the replayed intent is seq 2, once')
  } finally { await w.stop() }
})

test('Publish archives what is buffered when it is called, however much traffic follows', async () => {
  const w = await startWorker({}, { keep: true })
  try {
    const p = await newProject(w.base, name('mark'))
    for (let i = 0; i < 3; i++) await post_(w, p, `m${i}`)
    let stop = false
    const traffic = (async () => { for (let i = 0; !stop; i++) { await post(w.base, p.pk, evt(`t${i}`)); await new Promise(r => setTimeout(r, 5)) } })()
    const started = Date.now()
    await publish(w.base, p.id)
    stop = true; await traffic
    assert.ok(Date.now() - started < 10_000, 'Publish ended while traffic continued')
    const arcs = await readArchives(w.base, p.id, p.sk)
    assert.ok(['m0', 'm1', 'm2'].every(id => ids(arcs).includes(id)))
    assert.equal(new Set(ids(arcs)).size, ids(arcs).length)
  } finally { await w.stop() }
})

test('a backlog of poorly compressible data publishes in several archives, each within ARCHIVE_MAX_BYTES of input', async () => {
  const max = 2 * 1024 * 1024
  const w = await startWorker({ ARCHIVE_MAX_BYTES: String(max) })
  try {
    const p = await newProject(w.base, name('near_cap'))
    // 14 requests of about 600 KB of random bytes (base64 barely compresses): 8.4 MB, so at least 4 archives of at most 2 MiB
    const total = 14 * 6
    for (let r = 0; r < 14; r++)
      assert.equal((await post(w.base, p.pk, Array.from({ length: 6 }, (_, i) => evt(`n${r}-${i}`, { data: { blob: randomBytes(75_000).toString('base64') } })).join('\n'))).status, 200)
    await publish(w.base, p.id)
    const arcs = await readArchives(w.base, p.id, p.sk)
    assert.ok(arcs.length >= 4, `published in ${arcs.length} archives`)
    for (const a of arcs) assert.ok(gunzipSync(a.bytes).length <= max, `archive ${a.seq} holds ${gunzipSync(a.bytes).length} bytes`)
    assert.deepEqual(seqs(arcs), arcs.map((_, i) => i + 1), 'gapless')
    assert.equal(ids(arcs).length, total); assert.equal(new Set(ids(arcs)).size, total)
    // one chunk larger than the cap goes alone, never split
    const big = await newProject(w.base, name('one_chunk'))
    assert.equal((await post(w.base, big.pk, Array.from({ length: 4 }, (_, i) => evt(`o${i}`, { data: { blob: 'y'.repeat(700_000) } })).join('\n'))).status, 200)
    await publish(w.base, big.id)
    assert.deepEqual(ids(await readArchives(w.base, big.id, big.sk)).sort(), ['o0', 'o1', 'o2', 'o3'])
  } finally { await w.stop() }
})

test('a full archive of buffered data publishes at once, without waiting for the interval', async () => {
  const w = await startWorker({ ARCHIVE_MAX_BYTES: '4000', SEAL_INTERVAL_MS: '3600000' })
  try {
    const p = await newProject(w.base, name('full'))
    assert.equal((await post(w.base, p.pk, Array.from({ length: 30 }, (_, i) => evt(`f${i}`)).join('\n'))).status, 200)
    await until(async () => (await stats(w.base, p.id)).manifest >= 1, 'the full buffer to publish by itself')
  } finally { await w.stop() }
})

test('rows written: a flush, a publish and an idle alarm; the alarm is only set when its time changes', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '0', SEAL_INTERVAL_MS: '3600000' })
  try {
    const p = await newProject(w.base, name('rows'))
    const at = async () => stats(w.base, p.id)
    const base = await at()
    await post_(w, p, 'one')
    const first = await at()
    assert.equal(first.alarmWrites - base.alarmWrites, 1, 'the first commit after idle sets the alarm')
    assert.ok(first.alarm > Date.now() + 3_000_000, 'for one interval after the oldest buffered event')
    for (let i = 0; i < 5; i++) await post_(w, p, `more${i}`)
    const more = await at()
    assert.equal(more.alarmWrites, first.alarmWrites, 'more commits do not touch the alarm: its time did not change')
    const flushRows = (more.rowsWritten - first.rowsWritten) / 5
    await publish(w.base, p.id)
    const published = await at()
    const publishRows = published.rowsWritten - more.rowsWritten
    assert.equal(published.alarmWrites - more.alarmWrites, 1, 'publishing clears the alarm once (retention is off)')
    assert.equal(published.alarm, null)
    const idle = await debug(w.base, 'alarm', p.id)
    assert.equal(idle.rowsWritten, published.rowsWritten, 'an idle alarm writes no rows')
    assert.equal(idle.alarmWrites, published.alarmWrites, 'and does not call setAlarm or deleteAlarm')
    console.log(`rowsWritten: flush=${flushRows} per commit (1 chunk; first commit +${first.rowsWritten - base.rowsWritten}), publish=${publishRows} (6 chunks -> manifest+delete chunks+intent), idle alarm=${idle.rowsWritten - published.rowsWritten}; alarm writes: first commit=${first.alarmWrites - base.alarmWrites}, later commits=0, publish=1, idle alarm=0`)
  } finally { await w.stop() }
})

test('group commit: concurrent requests share one chunk; a failed commit is a 503 for everyone in it, and a retry works', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '300' })
  try {
    const p = await newProject(w.base, name('gc'))
    const before = (await stats(w.base, p.id)).rowsWritten
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => post(w.base, p.pk, evt(`g${i}`))))
    assert.deepEqual([...new Set(res.map(r => r.status))], [200])
    const st = await stats(w.base, p.id)
    assert.equal(st.chunks, 1, 'twenty requests, one chunk'); assert.equal(st.rowsWritten - before, 1)
    await debug(w.base, 'fail-flush', p.id)
    const failed = await Promise.all([post(w.base, p.pk, evt('lost1')), post(w.base, p.pk, evt('lost2'))])
    assert.deepEqual(failed.map(r => r.status), [503, 503]); assert.ok(Number(failed[0].headers.get('retry-after')) > 0)
    assert.equal((await post(w.base, p.pk, evt('lost1'))).status, 200, 'the retry is a fresh attempt')
    await publish(w.base, p.id)
    const got = ids(await readArchives(w.base, p.id, p.sk)).sort()
    assert.equal(got.length, 21); assert.ok(got.includes('lost1') && !got.includes('lost2'))
  } finally { await w.stop() }
})

test('an acknowledged event always has an alarm: a failed setAlarm is a 503 and the retry arms it', async () => {
  const w = await startWorker()
  try {
    const p = await newProject(w.base, name('alarmfail'))
    await debug(w.base, 'fail-alarm', p.id)                         // the next setAlarm throws once
    const failed = await post(w.base, p.pk, evt('a1'))
    assert.equal(failed.status, 503); assert.ok(Number(failed.headers.get('retry-after')) > 0)
    const mid = await stats(w.base, p.id)
    assert.equal(mid.chunks, 1, 'the chunk is committed'); assert.equal(mid.armed, null, 'but the cache does not claim an alarm'); assert.equal(mid.alarm, null)
    assert.equal((await post(w.base, p.pk, evt('a1'))).status, 200, 'the retry is acknowledged')
    const after = await stats(w.base, p.id)
    assert.ok(after.alarm !== null && after.armed === after.alarm, 'and the alarm is set')
    const got = ids(await archivedAll(w, p))
    assert.deepEqual(got, ['a1', 'a1'], 'the retry is a duplicate; the importer dedupes it by (sender, id)')
  } finally { await w.stop() }
})

test('a Publish that fails on R2 backs off like the alarm does and leaves an alarm armed', async () => {
  const w = await startWorker()
  try {
    const p = await newProject(w.base, name('pubfail'))
    await post_(w, p, 'x1')
    await debug(w.base, 'fail-archive', p.id)
    await failsWith503(publish(w.base, p.id))
    const st = await stats(w.base, p.id)
    assert.equal(st.failures, 1); assert.ok(st.retryAt !== null, 'retry_at is set')
    assert.ok(st.alarm !== null && st.armed === st.alarm, 'an alarm is armed')
    assert.ok(st.alarm >= Number(st.retryAt) - 1000 && st.alarm <= Number(st.retryAt) + 1000, 'for the retry time')
    await debug(w.base, 'heal-archive', p.id)
    await publish(w.base, p.id)
    const done = await stats(w.base, p.id)
    assert.deepEqual([done.failures, done.retryAt, done.manifest], [0, null, 1])
  } finally { await w.stop() }
})

test('backpressure: a full buffer answers 429 with Retry-After, and publishing frees space', async () => {
  const w = await startWorker({ BUFFER_CAP_BYTES: '3000', GROUP_COMMIT_MS: '0' })
  try {
    const s = await newProject(w.base, name('cap'))
    const big = (prefix: string) => Array.from({ length: 8 }, (_, i) => evt(`${prefix}${i}`, { data: { pad: 'x'.repeat(60) } })).join('\n')
    assert.equal((await post(w.base, s.pk, big('b'))).status, 200)
    const full = await post(w.base, s.pk, big('c'))
    assert.equal(full.status, 429); assert.ok(Number(full.headers.get('retry-after')) > 0)
    await publish(w.base, s.id)
    assert.equal((await post(w.base, s.pk, big('c'))).status, 200)
  } finally { await w.stop() }
})

test('backpressure counts work still queued for the group commit, and the envelope that will be stored', async () => {
  const w = await startWorker({ BUFFER_CAP_BYTES: '5000', GROUP_COMMIT_MS: '400' })
  try {
    const s = await newProject(w.base, name('capq'))
    // each body is about 1.3 KB as sent (three are under the cap) and about 2 KB once wrapped (three are over it), all before any commit
    const body = (prefix: string) => Array.from({ length: 8 }, (_, i) => evt(`${prefix}${i}`, { data: { pad: 'x'.repeat(40) } })).join('\n')
    assert.ok(new TextEncoder().encode(body('a')).length * 3 < 5000)
    const res = await Promise.all(['a', 'b', 'c'].map(p => post(w.base, s.pk, body(p))))
    assert.deepEqual(res.map(r => r.status).sort(), [200, 200, 429], 'two fit once enveloped, the third does not')
  } finally { await w.stop() }
})

test('chunks stay under 6 MiB: a 9 MB request and a burst of large ones are split, nothing is lost', async () => {
  const w = await startWorker({ GROUP_COMMIT_MS: '300', ARCHIVE_MAX_BYTES: '67108864' }) // no early publish: look at the chunks
  try {
    const s = await newProject(w.base, name('big'))
    const rec = (id: string) => evt(id, { data: { pad: 'x'.repeat(5000) } })
    const huge = Array.from({ length: 1800 }, (_, i) => rec(`h${i}`)).join('\n')
    assert.ok(huge.length > 9_000_000)
    const burst = Array.from({ length: 4 }, (_, b) => Array.from({ length: 180 }, (_, i) => rec(`b${b}-${i}`)).join('\n'))
    const res = await Promise.all([post(w.base, s.pk, huge), ...burst.map(b => post(w.base, s.pk, b))])
    assert.deepEqual(res.map(r => r.status), [200, 200, 200, 200, 200])
    assert.ok((await stats(w.base, s.id)).chunks >= 2, 'more than 6 MiB cannot be one chunk')
    await publish(w.base, s.id)
    const lines = ids(await readArchives(w.base, s.id, s.sk))
    assert.equal(lines.length, 1800 + 4 * 180); assert.equal(new Set(lines).size, lines.length, 'no loss or duplication')
  } finally { await w.stop() }
})

test('the alarm publishes on its own after the interval, and no alarm stays armed while idle', async () => {
  const w = await startWorker({ SEAL_INTERVAL_MS: '1500', GROUP_COMMIT_MS: '10' })
  try {
    const s = await newProject(w.base, name('alarm'))
    assert.equal((await post(w.base, s.pk, evt('t1'))).status, 200)
    const pending = await call(w.base, s.sk, 'ListArchives', { project: s.id })
    assert.equal(pending.coverage.pending, true)
    await until(async () => (await stats(w.base, s.id)).manifest === 1, 'the alarm to publish')
    assert.equal(ids(await readArchives(w.base, s.id, s.sk))[0], 't1')
    const st = await stats(w.base, s.id)
    assert.deepEqual([st.alarm, st.pending], [null, false])
  } finally { await w.stop() }
})

test('retention deletes old archives from R2, keeps their manifest rows, and reports a gap for a stale checkpoint', async () => {
  const w = await startWorker({ RETENTION_DAYS: '0.00002' }) // about 1.7 s
  try {
    const s = await newProject(w.base, name('ret'))
    await post_(w, s, 'old'); await publish(w.base, s.id)
    const url = `${w.base}/v1/projects/${s.id}/archives/1`
    assert.equal((await fetch(url, { headers: admin })).status, 200)
    await new Promise(r => setTimeout(r, 2500))
    await debug(w.base, 'sweep', s.id)
    assert.equal((await fetch(url, { headers: admin })).status, 404, 'deleted by retention')
    const st = await stats(w.base, s.id)
    assert.deepEqual([st.manifest, st.live], [1, 0], 'the manifest row stays, so seq is never reused')
    const listing = await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id })
    assert.deepEqual([listing.archives.length, listing.coverage.first, listing.coverage.last], [0, undefined, 1])
    assert.deepEqual((await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 0 })).gap, { from: 1, to: 1 })
    await post_(w, s, 'new'); await publish(w.base, s.id)
    const next = await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 1 })
    assert.deepEqual([next.archives.map(a => a.seq), next.gap, next.coverage.first], [[2], undefined, 2], 'seq 2, not 1 again')
    assert.deepEqual((await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 0 })).gap, { from: 1, to: 1 })
  } finally { await w.stop() }
})

test('retention keeps sweeping after the project goes quiet, with no further ingest', async () => {
  const w = await startWorker({ RETENTION_DAYS: '0.00004', SEAL_INTERVAL_MS: '600', GROUP_COMMIT_MS: '10' }) // expires about 3.5 s after publishing
  try {
    const s = await newProject(w.base, name('idle'))
    await post_(w, s, 'old')
    await until(async () => (await stats(w.base, s.id)).manifest === 1, 'publication')
    const st = await stats(w.base, s.id)
    assert.equal(st.pending, false); assert.ok(st.alarm !== null, 'an alarm stays armed for the retention expiry')
    assert.equal((await call(w.base, s.sk, 'ListArchives', { project: s.id })).coverage.pending, false, 'a retention alarm is not a pending publication')
    await until(async () => (await stats(w.base, s.id)).live === 0, 'the old archive to expire', 30_000)
    assert.equal((await stats(w.base, s.id)).alarm, null, 'nothing left to wait for')
  } finally { await w.stop() }
})

test('retention keeps working while publication is failing', async () => {
  const w = await startWorker({ RETENTION_DAYS: '0.00004', SEAL_INTERVAL_MS: '600', GROUP_COMMIT_MS: '10', ARCHIVE_RETRY_MS: '100' })
  try {
    const s = await newProject(w.base, name('ret_fail'))
    await post_(w, s, 'a')
    await until(async () => (await stats(w.base, s.id)).manifest === 1, 'the first archive')
    await debug(w.base, 'fail-archive', s.id)
    await post_(w, s, 'b')
    await until(async () => (await stats(w.base, s.id)).failures >= 1, 'publication to fail')
    await until(async () => (await stats(w.base, s.id)).live === 0, 'the old archive to be deleted although publication is failing', 30_000)
    assert.equal((await stats(w.base, s.id)).pending, true, 'and the buffered event is still waiting')
    await debug(w.base, 'heal-archive', s.id)
    await until(async () => (await stats(w.base, s.id)).manifest === 2, 'recovery')
    assert.equal((await stats(w.base, s.id)).failures, 0)
  } finally { await w.stop() }
})

test('a buffered event still publishes on time when a retention alarm is armed far ahead', async () => {
  const w = await startWorker({ RETENTION_DAYS: '30', SEAL_INTERVAL_MS: '1200', GROUP_COMMIT_MS: '10' })
  try {
    const s = await newProject(w.base, name('pull'))
    await post_(w, s, 'a')
    await until(async () => (await stats(w.base, s.id)).manifest >= 1, 'the first archive')
    assert.ok((await stats(w.base, s.id)).alarm > Date.now() + 86_400_000, 'idle: armed ~30 days out for retention')
    await post_(w, s, 'b')                                         // must pull the alarm in to the publish interval
    await until(async () => (await stats(w.base, s.id)).manifest >= 2, 'the second archive')
    assert.deepEqual(ids(await readArchives(w.base, s.id, s.sk)).sort(), ['a', 'b'])
  } finally { await w.stop() }
})

test('purge removes every project, archive and stray object so a deployment can be deleted', async () => {
  const w = await startWorker()
  try {
    const a = await newProject(w.base, name('purge_a')), b = await newProject(w.base, name('purge_b'))
    for (const s of [a, b]) { await post_(w, s, 'p1'); await publish(w.base, s.id) }
    const url = `${w.base}/v1/projects/${a.id}/archives/1`
    assert.equal((await fetch(url, { headers: admin })).status, 200)
    const purge = (body: string, headers: Record<string, string> = admin) => fetch(`${w.base}/v1/admin/purge`, { method: 'POST', headers, body })
    assert.equal((await purge('{"confirm":"delete-all-data"}', {})).status, 401)
    assert.equal((await purge('{"confirm":"delete-all-data"}', { Authorization: `Bearer ${a.sk}` })).status, 403)
    assert.equal((await purge('{}')).status, 400)
    assert.equal((await call(w.base, ADMIN_TOKEN, 'ListProjects', {})).projects.length, 2, 'nothing was deleted without confirmation')
    const done = await (await purge('{"confirm":"delete-all-data"}')).json() as any
    assert.deepEqual([done.ok, done.projects, done.archives], [true, 2, 2])
    assert.equal((await fetch(url, { headers: admin })).status, 404, 'archive object is gone from R2')
    assert.equal((await call(w.base, ADMIN_TOKEN, 'ListProjects', {})).projects.length, 0)
    assert.equal((await post(w.base, a.pk, evt('p2'))).status, 401, 'keys are gone')
    // the deployment is usable again from scratch
    const again = await newProject(w.base, name('after'))
    assert.equal((await post(w.base, again.pk, evt('p3'))).status, 200)
  } finally { await w.stop() }
})
