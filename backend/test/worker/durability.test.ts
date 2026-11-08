// Durability: what survives a crash or a restart, publication that races itself, size limits, backpressure and retention.
// A restart is `abortAllDurableObjects()`: the instance is dropped and the next request rebuilds it from its SQLite tables. Time is
// moved with `age()` and `dueRetry()`; nothing waits for a schedule.
import { abortAllDurableObjects, evictDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, test } from 'vitest'
import { archiveKey } from '../../src/publisher.ts'
import {
  ADMIN_TOKEN, ApiError, CF, DAY, HOUR, admin, age, alarm, alarmAt, archived, archives, assert, breakArchive, call, count, dueRetry, evt, failNextCommit,
  failNextSetAlarm, healArchive, http, ids, inside, newProject, post, publish, seqs, settings, sql, stats, stubOf, until, withConfig,
} from './helpers.ts'

afterEach(abortAllDurableObjects)

const post_ = async (p: { pk: string }, id: string) => assert.equal((await post(p.pk, evt(id))).status, 200)
const failsWith503 = (p: Promise<unknown>) => assert.rejects(p, (e: ApiError) => e instanceof ApiError && e.status === 503 && e.code === 'unavailable')
/** Random bytes as base64 (barely compressible); getRandomValues takes at most 64 KiB at a time. */
const randomBase64 = (bytes: number) => {
  const out = new Uint8Array(bytes)
  for (let at = 0; at < bytes; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, bytes)))
  let binary = ''
  for (const b of out) binary += String.fromCharCode(b)
  return btoa(binary)
}

// ---- restarts ----

test('a publish that died after its intent was stored is finished by the restarted Worker as seq 1, and later events become seq 2', async () => {
  const p = await newProject('crash')
  for (let i = 0; i < 5; i++) await post_(p, `early${i}`)
  await breakArchive(p)
  await failsWith503(publish(p))                                  // the intent is stored; the R2 put never happened
  for (let i = 0; i < 3; i++) await post_(p, `late${i}`)          // these arrive while that publish is unfinished
  const before = await stats(p)
  assert.deepEqual([before.intent?.seq, before.manifest, before.chunks], [1, 0, 8])
  await abortAllDurableObjects()                                  // nothing in memory survives; the broken bucket is gone too
  assert.ok((await alarmAt(p)) !== null, 'the restarted object still has its alarm')
  await dueRetry(p)                                               // the retry the failure scheduled falls due
  assert.equal(await alarm(p), true)
  assert.equal((await stats(p)).manifest, 2, 'the restarted object published by itself')
  const arcs = await archives(p)
  assert.deepEqual(seqs(arcs), [1, 2], 'gapless')
  assert.deepEqual(ids([arcs[0]]), [0, 1, 2, 3, 4].map(i => `early${i}`), 'the stored choice was replayed as seq 1')
  assert.deepEqual(ids([arcs[1]]), [0, 1, 2].map(i => `late${i}`))
  const after = await stats(p)
  assert.deepEqual([after.intent, after.chunks, after.pending], [null, 0, false])
})

test('post, restart, post, publish: every event is there once and the archives are gapless', async () => {
  const p = await newProject('restart')
  for (let i = 0; i < 4; i++) await post_(p, `a${i}`)
  await call(ADMIN_TOKEN, 'Publish', { project: p.id })
  for (let i = 0; i < 4; i++) await post_(p, `b${i}`)             // committed, not yet published
  const armed = await alarmAt(p)
  await abortAllDurableObjects()
  assert.equal((await sql<{ n: number }>(p, 'SELECT SUM(events) n FROM chunks'))[0].n, 4, 'the acknowledged events survived the restart')
  assert.equal(await alarmAt(p), armed, 'and so did the alarm that will publish them')
  for (let i = 0; i < 4; i++) await post_(p, `c${i}`)
  const { coverage } = await publish(p)
  assert.deepEqual([coverage.first, coverage.last, coverage.pending], [1, 2, false])
  const arcs = await archives(p)
  assert.deepEqual(seqs(arcs), [1, 2])
  assert.deepEqual(ids(arcs).sort(), ['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3', 'c0', 'c1', 'c2', 'c3'])
  // the project's keys also survived the restart
  assert.equal((await post(p.pk, evt('after'))).status, 200)
})

test('a publish that died after the R2 put, then a restart: one manifest row per seq, no gap, nothing twice', async () => {
  const p = await newProject('afterput')
  for (let i = 0; i < 3; i++) await post_(p, `x${i}`)
  await breakArchive(p, { put: 'after' })
  await failsWith503(publish(p))                                  // seq 1 is in R2 but not in the manifest
  const mid = await stats(p)
  assert.deepEqual([mid.manifest, mid.intent?.seq], [0, 1])
  const object = await env.ARCHIVE.get(archiveKey(p.id, 1))
  assert.ok(object, 'the object is in R2'); await object!.arrayBuffer()
  assert.equal((await call(p.sk, 'ListArchives', { project: p.id })).archives.length, 0, 'an object that is not in the manifest is not listed')
  assert.equal((await http(`/v1/projects/${p.id}/archives/1`, { headers: admin })).status, 404, 'nor served')
  await abortAllDurableObjects()
  await post_(p, 'y0')
  await publish(p)
  const arcs = await archives(p)
  assert.deepEqual(seqs(arcs), [1, 2])
  assert.deepEqual(ids(arcs), ['x0', 'x1', 'x2', 'y0'])
  const st = await stats(p)
  assert.deepEqual([st.manifest, st.intent, st.chunks], [2, null, 0], 'one manifest row per seq')
})

test('a failure after the R2 put, then a restart, republishes the same sequence from the alarm with no gap', async () => {
  const p = await newProject('afterput_alarm')
  await post_(p, 'x1')
  await breakArchive(p, { put: 'after' })
  await age(p, HOUR + 1000)
  await alarm(p)
  assert.equal(await count(p, 'manifest'), 0)                     // the object is in R2 but the manifest does not know it yet
  const put = await env.ARCHIVE.get(archiveKey(p.id, 1))
  assert.ok(put); await put!.arrayBuffer()
  await abortAllDurableObjects()
  await dueRetry(p)
  assert.equal(await alarm(p), true)
  assert.deepEqual(await sql(p, 'SELECT seq FROM manifest'), [{ seq: 1 }])
})

test('after a restart the object is rebuilt from storage with chunks, intent, failure record and alarm intact', async () => {
  const p = await newProject('rebuild')
  await post_(p, 'r1')
  await breakArchive(p)                                           // fail the put after the intent is stored: an intent, a failure and a retry alarm
  await age(p, HOUR + 1000)
  await alarm(p)
  const before = { chunks: await sql(p, 'SELECT id, bytes FROM chunks'), intent: await sql(p, 'SELECT seq, through_chunk FROM intent'), alarm: await alarmAt(p), settings: await settings(p) }
  assert.equal(before.chunks.length, 1); assert.equal(before.intent.length, 1); assert.ok(before.alarm !== null)
  const instanceBefore = await inside(p, i => i)
  await abortAllDurableObjects()
  const instanceAfter = await inside(p, i => i)                   // the next request rebuilds the object (and the broken bucket is gone)
  assert.ok(instanceAfter !== instanceBefore, 'a new instance')
  assert.deepEqual(await sql(p, 'SELECT id, bytes FROM chunks'), before.chunks)
  assert.deepEqual(await sql(p, 'SELECT seq, through_chunk FROM intent'), before.intent)
  assert.deepEqual(await settings(p), before.settings)
  assert.equal(await alarmAt(p), before.alarm)
  await dueRetry(p)                                               // the stored intent republishes under the same sequence
  assert.equal(await alarm(p), true)
  assert.deepEqual(await sql(p, 'SELECT seq FROM manifest'), [{ seq: (before.intent[0] as any).seq }])
})

test('evicting the object also rebuilds it from storage, and an acknowledged event survives', async () => {
  const p = await newProject('evict')
  await post_(p, 'e1')
  const armed = await alarmAt(p)
  const first = await inside(p, i => i)
  await evictDurableObject(stubOf(p))
  assert.ok((await inside(p, i => i)) !== first)
  assert.equal(await count(p, 'chunks'), 1)
  assert.equal(await alarmAt(p), armed)
  await publish(p)
  assert.equal(await count(p, 'manifest'), 1)
})

// ---- publication that races itself ----

test('Publish racing the alarm and another Publish: one archive per intent, nothing twice', async () => {
  const p = await newProject('race')
  for (let i = 0; i < 6; i++) await post_(p, `r${i}`)
  await age(p, HOUR + 1000)                                       // the alarm has real work: publication is due
  const results = await Promise.all([alarm(p), publish(p), publish(p), publish(p)])
  assert.ok(results.slice(1).every(Boolean))
  const st = await stats(p)
  assert.deepEqual([st.manifest, st.chunks, st.intent], [1, 0, null], 'one publication served them all')
  assert.deepEqual(ids(await archives(p)), [0, 1, 2, 3, 4, 5].map(i => `r${i}`))
  // and again with a stored intent waiting: the concurrent callers share the replay
  for (let i = 6; i < 9; i++) await post_(p, `r${i}`)
  await breakArchive(p)
  await failsWith503(publish(p))
  await abortAllDurableObjects()
  await dueRetry(p)
  await Promise.all([publish(p), alarm(p), publish(p)])
  assert.deepEqual(seqs(await archives(p)), [1, 2], 'the replayed intent is seq 2, once')
})

test('Publish archives what is buffered when it is called, however much traffic follows', async () => {
  const p = await newProject('mark')
  for (let i = 0; i < 3; i++) await post_(p, `m${i}`)
  let stop = false
  const traffic = (async () => { for (let i = 0; !stop; i++) { await post(p.pk, evt(`t${i}`)); await new Promise(r => setTimeout(r, 5)) } })()
  const started = Date.now()
  await publish(p)
  stop = true; await traffic
  assert.ok(Date.now() - started < 10_000, 'Publish ended while traffic continued')
  const arcs = await archives(p)
  assert.ok(['m0', 'm1', 'm2'].every(id => ids(arcs).includes(id)))
  assert.equal(new Set(ids(arcs)).size, ids(arcs).length)
})

// ---- size limits ----

test('a backlog of poorly compressible data publishes in several archives, each within ARCHIVE_MAX_BYTES of input', async () => {
  const max = 2 * 1024 * 1024
  const p = await newProject('near_cap')
  await withConfig(p, { ARCHIVE_MAX_BYTES: String(max) })
  // 14 requests of about 600 KB of random bytes (base64 barely compresses): 8.4 MB, so at least 4 archives of at most 2 MiB
  const total = 14 * 6
  for (let r = 0; r < 14; r++)
    assert.equal((await post(p.pk, Array.from({ length: 6 }, (_, i) => evt(`n${r}-${i}`, { data: { blob: randomBase64(75_000) } })).join('\n'))).status, 200)
  await publish(p)
  const arcs = await archives(p)
  assert.ok(arcs.length >= 4, `published in ${arcs.length} archives`)
  for (const a of arcs) assert.ok(a.inflated <= max, `archive ${a.seq} holds ${a.inflated} bytes`)
  assert.deepEqual(seqs(arcs), arcs.map((_, i) => i + 1), 'gapless')
  assert.equal(ids(arcs).length, total); assert.equal(new Set(ids(arcs)).size, total)
  // one chunk larger than the cap goes alone, never split
  const big = await newProject('one_chunk')
  await withConfig(big, { ARCHIVE_MAX_BYTES: String(max) })
  assert.equal((await post(big.pk, Array.from({ length: 4 }, (_, i) => evt(`o${i}`, { data: { blob: 'y'.repeat(700_000) } })).join('\n'))).status, 200)
  await publish(big)
  assert.deepEqual(ids(await archives(big)).sort(), ['o0', 'o1', 'o2', 'o3'])
})

test('a full archive of buffered data is due at once, without waiting for the interval', async () => {
  const p = await newProject('full')
  await withConfig(p, { ARCHIVE_MAX_BYTES: '4000' })
  assert.equal((await post(p.pk, Array.from({ length: 30 }, (_, i) => evt(`f${i}`)).join('\n'))).status, 200)
  // The alarm was set for "now" (not an hour from now), so it fires on its own; running it here only makes that quicker.
  await alarm(p)
  await until(async () => (await count(p, 'manifest')) >= 1, 'the full buffer to publish')
})

test('chunks stay under 6 MiB: a 9 MB request and a burst of large ones are split, nothing is lost', async () => {
  const s = await newProject('big')
  await withConfig(s, { GROUP_COMMIT_MS: '300', ARCHIVE_MAX_BYTES: '67108864' }) // no early publish: look at the chunks
  const rec = (id: string) => evt(id, { data: { pad: 'x'.repeat(5000) } })
  const huge = Array.from({ length: 1800 }, (_, i) => rec(`h${i}`)).join('\n')
  assert.ok(huge.length > 9_000_000)
  const burst = Array.from({ length: 4 }, (_, b) => Array.from({ length: 180 }, (_, i) => rec(`b${b}-${i}`)).join('\n'))
  const res = await Promise.all([post(s.pk, huge), ...burst.map(b => post(s.pk, b))])
  assert.deepEqual(res.map(r => r.status), [200, 200, 200, 200, 200])
  assert.ok((await count(s, 'chunks')) >= 2, 'more than 6 MiB cannot be one chunk')
  await publish(s)
  const lines = ids(await archives(s))
  assert.equal(lines.length, 1800 + 4 * 180); assert.equal(new Set(lines).size, lines.length, 'no loss or duplication')
})

// ---- what it costs ----

test('rows written: a flush, a publish and an idle alarm; the alarm is only set when its time changes', async () => {
  const p = await newProject('rows')
  await withConfig(p, { GROUP_COMMIT_MS: '0' })
  const at = () => stats(p)
  const base = await at()
  await post_(p, 'one')
  const first = await at()
  assert.equal(first.alarmWrites - base.alarmWrites, 1, 'the first commit after idle sets the alarm')
  assert.ok(first.alarm! > Date.now() + 3_000_000, 'for one interval after the oldest buffered event')
  for (let i = 0; i < 5; i++) await post_(p, `more${i}`)
  const more = await at()
  assert.equal(more.alarmWrites, first.alarmWrites, 'more commits do not touch the alarm: its time did not change')
  const flushRows = (more.rowsWritten - first.rowsWritten) / 5
  await publish(p)
  const published = await at()
  const publishRows = published.rowsWritten - more.rowsWritten
  assert.equal(published.alarmWrites - more.alarmWrites, 1, 'publishing clears the alarm once (retention is off)')
  assert.equal(published.alarm, null)
  await inside(p, i => i.alarm())                                  // an alarm with nothing due
  const idle = await at()
  assert.equal(idle.rowsWritten, published.rowsWritten, 'an idle alarm writes no rows')
  assert.equal(idle.alarmWrites, published.alarmWrites, 'and does not call setAlarm or deleteAlarm')
  console.log(`rowsWritten: flush=${flushRows} per commit (1 chunk; first commit +${first.rowsWritten - base.rowsWritten}), publish=${publishRows} (6 chunks -> manifest+delete chunks+intent), idle alarm=${idle.rowsWritten - published.rowsWritten}; alarm writes: first commit=${first.alarmWrites - base.alarmWrites}, later commits=0, publish=1, idle alarm=0`)
})

test('group commit: concurrent requests share one chunk; a failed commit is a 503 for everyone in it, and a retry works', async () => {
  const p = await newProject('gc')
  await withConfig(p, { GROUP_COMMIT_MS: '300' })
  const before = (await stats(p)).rowsWritten
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => post(p.pk, evt(`g${i}`))))
  assert.deepEqual([...new Set(res.map(r => r.status))], [200])
  const st = await stats(p)
  assert.equal(st.chunks, 1, 'twenty requests, one chunk'); assert.equal(st.rowsWritten - before, 1)
  await failNextCommit(p)
  const failed = await Promise.all([post(p.pk, evt('lost1')), post(p.pk, evt('lost2'))])
  assert.deepEqual(failed.map(r => r.status), [503, 503]); assert.ok(Number(failed[0].headers.get('retry-after')) > 0)
  assert.equal((await post(p.pk, evt('lost1'))).status, 200, 'the retry is a fresh attempt')
  await publish(p)
  const got = ids(await archives(p)).sort()
  assert.equal(got.length, 21); assert.ok(got.includes('lost1') && !got.includes('lost2'))
})

// ---- failures on the way to an alarm ----

test('an acknowledged event always has an alarm: a failed setAlarm is a 503 and the retry arms it', async () => {
  const p = await newProject('alarmfail')
  await failNextSetAlarm(p)                                       // the next setAlarm throws once
  const failed = await post(p.pk, evt('a1'))
  assert.equal(failed.status, 503); assert.ok(Number(failed.headers.get('retry-after')) > 0)
  const mid = await stats(p)
  assert.equal(mid.chunks, 1, 'the chunk is committed'); assert.equal(mid.armed, null, 'but the cache does not claim an alarm'); assert.equal(mid.alarm, null)
  assert.equal((await post(p.pk, evt('a1'))).status, 200, 'the retry is acknowledged')
  const after = await stats(p)
  assert.ok(after.alarm !== null && after.armed === after.alarm, 'and the alarm is set')
  const got = ids(await archived(p))
  assert.deepEqual(got, ['a1', 'a1'], 'the retry is a duplicate; the importer dedupes it by (sender, id)')
})

test('a Publish that fails on R2 backs off like the alarm does and leaves an alarm armed', async () => {
  const p = await newProject('pubfail')
  await post_(p, 'x1')
  await breakArchive(p)
  await failsWith503(publish(p))
  const st = await stats(p)
  const s = await settings(p)
  assert.equal(s.failures, '1'); assert.ok(s.retry_at !== undefined, 'retry_at is set')
  assert.ok(st.alarm !== null && st.armed === st.alarm, 'an alarm is armed')
  assert.ok(st.alarm! >= Number(s.retry_at) - 1000 && st.alarm! <= Number(s.retry_at) + 1000, 'for the retry time')
  await healArchive(p)
  await publish(p)
  const done = await stats(p)
  assert.deepEqual([await settings(p), done.manifest], [{}, 1])
})

// ---- backpressure ----

test('backpressure: a full buffer answers 429 with Retry-After, and publishing frees space', async () => {
  const s = await newProject('cap')
  await withConfig(s, { BUFFER_CAP_BYTES: '3000', GROUP_COMMIT_MS: '0' })
  const big = (prefix: string) => Array.from({ length: 8 }, (_, i) => evt(`${prefix}${i}`, { data: { pad: 'x'.repeat(60) } })).join('\n')
  assert.equal((await post(s.pk, big('b'))).status, 200)
  const full = await post(s.pk, big('c'))
  assert.equal(full.status, 429); assert.ok(Number(full.headers.get('retry-after')) > 0)
  await publish(s)
  assert.equal((await post(s.pk, big('c'))).status, 200)
})

test('backpressure counts work still queued for the group commit, and the envelope that will be stored', async () => {
  const s = await newProject('capq')
  await withConfig(s, { BUFFER_CAP_BYTES: '5000', GROUP_COMMIT_MS: '400' })
  // each body is about 1.3 KB as sent (three are under the cap) and about 2 KB once wrapped (three are over it), all before any commit
  const body = (prefix: string) => Array.from({ length: 8 }, (_, i) => evt(`${prefix}${i}`, { data: { pad: 'x'.repeat(40) } })).join('\n')
  assert.ok(new TextEncoder().encode(body('a')).length * 3 < 5000)
  // (the envelope includes the caller's location, which Cloudflare supplies on every real request)
  const res = await Promise.all(['a', 'b', 'c'].map(p => http('/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${s.pk}` }, body: body(p), cf: CF })))
  assert.deepEqual(res.map(r => r.status).sort(), [200, 200, 429], 'two fit once enveloped, the third does not')
})

// ---- the schedule ----

test('the alarm publishes after the interval, and no alarm stays armed while idle', async () => {
  const s = await newProject('alarm')
  assert.equal((await post(s.pk, evt('t1'))).status, 200)
  const pending = await call(s.sk, 'ListArchives', { project: s.id })
  assert.equal(pending.coverage.pending, true)
  await age(s, HOUR + 1000)                                       // one seal interval later
  assert.equal(await alarm(s), true)
  assert.equal(ids(await archives(s))[0], 't1')
  const st = await stats(s)
  assert.deepEqual([st.alarm, st.pending], [null, false])
})

test('retention deletes old archives from R2, keeps their manifest rows, and reports a gap for a stale checkpoint', async () => {
  const s = await newProject('ret')
  await withConfig(s, { RETENTION_DAYS: '1' })
  await post_(s, 'old'); await publish(s)
  const url = `/v1/projects/${s.id}/archives/1`
  assert.equal((await http(url, { headers: admin })).status, 200)
  await age(s, 2 * DAY)                                           // the archive is now two days old
  assert.equal(await alarm(s), true)                              // the alarm armed for its expiry sweeps it
  assert.equal((await http(url, { headers: admin })).status, 404, 'deleted by retention')
  const st = await stats(s)
  assert.deepEqual([st.manifest, st.live], [1, 0], 'the manifest row stays, so seq is never reused')
  const listing = await call(ADMIN_TOKEN, 'ListArchives', { project: s.id })
  assert.deepEqual([listing.archives.length, listing.coverage.first, listing.coverage.last], [0, undefined, 1])
  assert.deepEqual((await call(ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 0 })).gap, { from: 1, to: 1 })
  await post_(s, 'new'); await publish(s)
  const next = await call(ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 1 })
  assert.deepEqual([next.archives.map(a => a.seq), next.gap, next.coverage.first], [[2], undefined, 2], 'seq 2, not 1 again')
  assert.deepEqual((await call(ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 0 })).gap, { from: 1, to: 1 })
})

test('retention keeps sweeping after the project goes quiet, with no further ingest', async () => {
  const s = await newProject('idle')
  await withConfig(s, { RETENTION_DAYS: '1' })
  await post_(s, 'old')
  await age(s, HOUR + 1000)
  await alarm(s)
  const st = await stats(s)
  assert.equal(st.manifest, 1); assert.equal(st.pending, false); assert.ok(st.alarm !== null, 'an alarm stays armed for the retention expiry')
  assert.ok(st.alarm! > Date.now() + DAY / 2, 'a day out, not now')
  assert.equal((await call(s.sk, 'ListArchives', { project: s.id })).coverage.pending, false, 'a retention alarm is not a pending publication')
  await age(s, 2 * DAY)
  assert.equal(await alarm(s), true)
  assert.equal((await stats(s)).live, 0, 'the old archive expired')
  assert.equal(await alarmAt(s), null, 'nothing left to wait for')
})

test('retention keeps working while publication is failing', async () => {
  const s = await newProject('ret_fail')
  await withConfig(s, { RETENTION_DAYS: '1' })
  await post_(s, 'a')
  await age(s, HOUR + 1000)
  await alarm(s)
  assert.equal(await count(s, 'manifest'), 1, 'the first archive')
  await breakArchive(s)                                           // writes fail; deletes still work
  await post_(s, 'b')
  await age(s, 2 * DAY)                                           // the old archive is past retention and the new event is overdue
  assert.equal(await alarm(s), true)
  assert.ok(Number((await settings(s)).failures) >= 1, 'publication failed')
  const st = await stats(s)
  assert.equal(st.live, 0, 'the old archive was deleted although publication is failing')
  assert.equal(st.pending, true, 'and the buffered event is still waiting')
  await healArchive(s)
  await dueRetry(s)
  assert.equal(await alarm(s), true)
  assert.equal(await count(s, 'manifest'), 2, 'recovery')
  assert.deepEqual(await settings(s), {})
})

test('an overdue deletion while R2 is failing waits for the retry time instead of waking the object every second', async () => {
  const s = await newProject('ret_outage')
  await withConfig(s, { RETENTION_DAYS: '1' })
  await post_(s, 'a')
  await age(s, HOUR + 1000)
  await alarm(s)
  await breakArchive(s, { put: 'throw', delete: 'throw' })       // an outage: neither writes nor deletes work
  await post_(s, 'b')
  await age(s, 2 * DAY)
  assert.equal(await alarm(s), true)
  const st = await stats(s)
  const retryAt = Number((await settings(s)).retry_at)
  assert.equal(st.live, 1, 'the old archive could not be deleted')
  assert.ok(retryAt > Date.now() + 30_000)
  assert.ok(Math.abs(st.alarm! - retryAt) <= 1000, `the alarm is at the retry time, not a second from now (${st.alarm! - Date.now()} ms)`)
})

test('a buffered event still publishes on time when a retention alarm is armed far ahead', async () => {
  const s = await newProject('pull')
  await withConfig(s, { RETENTION_DAYS: '30' })
  await post_(s, 'a')
  await age(s, HOUR + 1000)
  await alarm(s)
  assert.equal(await count(s, 'manifest'), 1, 'the first archive')
  assert.ok((await alarmAt(s))! > Date.now() + 29 * DAY, 'idle: armed ~30 days out for retention')
  await post_(s, 'b')                                              // must pull the alarm in to the publish interval
  const pulled = (await alarmAt(s))!
  assert.ok(pulled < Date.now() + HOUR + 60_000 && pulled > Date.now() + HOUR - 60_000, 'one interval from the new event')
  await age(s, HOUR + 1000)
  await alarm(s)
  assert.equal(await count(s, 'manifest'), 2, 'the second archive')
  assert.deepEqual(ids(await archives(s)).sort(), ['a', 'b'])
})
