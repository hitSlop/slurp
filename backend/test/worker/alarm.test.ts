// Archive publication must survive an R2 outage that outlasts Cloudflare's own alarm retries, with nothing else to wake the project.
// Ported from test/alarm.test.ts to run inside workerd (no wrangler dev, no /__debug routes).
import { abortAllDurableObjects, evictDurableObject, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, expect, test } from 'vitest'
import { projectStub } from '../../src/api.ts'
import { archiveKey } from '../../src/publisher.ts'

const ADMIN = 'test-admin-token-0123456789abcdef'
const fetchWorker = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`http://worker${path}`, init))
const rpc = async (method: string, body: object) => {
  const r = await fetchWorker(`/v1/rpc/${method}`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method}: ${r.status} ${text}`)
  return JSON.parse(text) as any
}
const evt = (id: string) => JSON.stringify({ id, type: 'track', event: 'signup', timestamp: '2026-11-06T00:00:00Z', data: { n: 1 } })
const post = async (key: string, body: string) => { const r = await fetchWorker('/v1/events', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body }); await r.text(); return r }
let n = 0
async function newProject() {
  const created = await rpc('CreateProject', { name: `alarm_${++n}_${Math.random().toString(16).slice(2, 6)}` })
  return { id: created.project.id as string, pk: created.publishableKey as string }
}

// Reach inside the object. These private names are what the real tests would keep in helpers.ts.
const inside = <R>(id: string, fn: (i: any, state: DurableObjectState) => R | Promise<R>) => runInDurableObject(projectStub(env, id), fn)
const sqlRows = (id: string, q: string) => inside(id, (_i, state) => state.storage.sql.exec(q).toArray())
const age = (id: string, ms: number) => inside(id, (_i, state) => { state.storage.sql.exec('UPDATE chunks SET at_ms = at_ms - ?', ms) })
type Mode = { put: 'throw' | 'after' | 'ok' }
// A bucket whose writes fail (or fail after succeeding), swapped into this one Durable Object only.
function failingArchive(real: R2Bucket, mode: Mode = { put: 'throw' }) {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'put') return async (...a: Parameters<R2Bucket['put']>) => {
        if (mode.put === 'throw') throw new Error('injected archive failure')
        const out = await target.put(...a)
        if (mode.put === 'after') throw new Error('injected failure after the R2 put')
        return out
      }
      const v = (target as any)[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
const breakArchive = (id: string, mode?: Mode) =>
  inside(id, i => { const p = i.publisher; p.env = Object.create(p.env, { ARCHIVE: { value: failingArchive(env.ARCHIVE, mode) } }) })
const healArchive = (id: string) => inside(id, i => { const p = i.publisher; p.env = Object.getPrototypeOf(p.env) })
const fastRetry = (id: string) => inside(id, i => { const c = { ...i.cfg, archiveRetryMs: 100 }; i.cfg = c; i.publisher.cfg = c }) // configOf() caches one object per env, so replace it, never mutate it
// Make a scheduled retry due now by moving its stored time back (the schedule is derived from stored facts).
const dueRetry = (id: string) => inside(id, (_i, s) => { s.storage.sql.exec("UPDATE settings SET v = CAST(v AS INTEGER) - 3600000 WHERE k = 'retry_at'") })
const manifest = async (id: string) => ((await sqlRows(id, 'SELECT COUNT(*) n FROM manifest')) as any[])[0].n as number
const alarmOf = (id: string) => inside(id, (_i, s) => s.storage.getAlarm())
const settings = async (id: string) => Object.fromEntries(((await sqlRows(id, 'SELECT k, v FROM settings')) as any[]).map(r => [r.k, r.v]))
const until = async (check: () => Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}

afterEach(async () => { await abortAllDurableObjects() })

test('Q1/Q3: a stored alarm for the future fires, and the handler publishes only once the stored facts make it due', async () => {
  const p = await newProject()
  expect((await post(p.pk, evt('a1'))).status).toBe(200)
  const armed = await alarmOf(p.id)
  expect(armed).toBeGreaterThan(Date.now() + 3_000_000) // the hour-long seal interval
  // Not due: the alarm runs (runDurableObjectAlarm fires it even though it is in the future) and publishes nothing.
  expect(await runDurableObjectAlarm(projectStub(env, p.id))).toBe(true)
  expect(await manifest(p.id)).toBe(0)
  expect(await alarmOf(p.id)).toBe(armed) // rearmed to the same time
  // Make it due by moving the stored time back, not by sleeping.
  await age(p.id, 3_600_000 + 1000)
  expect(await runDurableObjectAlarm(projectStub(env, p.id))).toBe(true)
  expect(await manifest(p.id)).toBe(1)
  expect(await sqlRows(p.id, 'SELECT COUNT(*) n FROM chunks')).toEqual([{ n: 0 }])
  expect(await alarmOf(p.id)).toBeNull()
  const obj = await env.ARCHIVE.get(archiveKey(p.id, 1)); expect(obj).not.toBeNull(); await obj!.arrayBuffer()
})

test('when archive writes fail, the alarm does not throw and keeps trying until the events are published, with no new ingestion', async () => {
  const p = await newProject()
  expect((await post(p.pk, evt('a1'))).status).toBe(200)
  await breakArchive(p.id); await fastRetry(p.id)
  await age(p.id, 3_600_000 + 1000)
  // runDurableObjectAlarm rejects if the handler throws.
  expect(await runDurableObjectAlarm(projectStub(env, p.id))).toBe(true)
  expect(await manifest(p.id)).toBe(0)
  const s = await settings(p.id)
  expect(Number(s.failures)).toBeGreaterThanOrEqual(1)
  expect(Number(s.retry_at) - Date.now()).toBeLessThan(10_000)
  expect(await sqlRows(p.id, 'SELECT COUNT(*) n FROM intent')).toEqual([{ n: 1 }]) // the intent is kept for the retry
  // R2 comes back. Nobody sends anything; the platform's own alarm (the 100 ms retry) publishes.
  await healArchive(p.id)
  await until(async () => (await manifest(p.id)) === 1, 'the archive to be published by the retry alarm')
  expect(await settings(p.id)).toEqual({})
})

test('a failing project keeps backing off and does not touch another project', async () => {
  const broken = await newProject(), fine = await newProject()
  expect((await post(broken.pk, evt('b1'))).status).toBe(200); expect((await post(fine.pk, evt('f1'))).status).toBe(200)
  await breakArchive(broken.id)
  await age(broken.id, 3_600_000 + 1000)
  for (let attempt = 0; attempt < 3; attempt++) { await runDurableObjectAlarm(projectStub(env, broken.id)); if (attempt < 2) await dueRetry(broken.id) }
  expect(Number((await settings(broken.id)).failures)).toBeGreaterThanOrEqual(3)
  await rpc('Publish', { project: fine.id })
  expect(await manifest(fine.id)).toBe(1)
  expect((await settings(broken.id)).retry_at).toBeDefined()
  await healArchive(broken.id)
  expect(await runDurableObjectAlarm(projectStub(env, broken.id))).toBe(true) // the retry is not due yet: nothing published
  expect(await manifest(broken.id)).toBe(0)
  await dueRetry(broken.id)
  await runDurableObjectAlarm(projectStub(env, broken.id))
  expect(await manifest(broken.id)).toBe(1)
})

test('Q2: after abortAllDurableObjects the object is rebuilt from storage with chunks, intent and alarm intact', async () => {
  const p = await newProject()
  expect((await post(p.pk, evt('r1'))).status).toBe(200)
  // Fail the put after the intent is stored, so there is a pending intent, a failure record and a retry alarm.
  await breakArchive(p.id)
  await age(p.id, 3_600_000 + 1000)
  await runDurableObjectAlarm(projectStub(env, p.id))
  const before = { chunks: await sqlRows(p.id, 'SELECT id, bytes FROM chunks'), intent: await sqlRows(p.id, 'SELECT seq, through_chunk FROM intent') as any[], alarm: await alarmOf(p.id), s: await settings(p.id) }
  expect(before.chunks).toHaveLength(1); expect(before.intent).toHaveLength(1); expect(before.alarm).not.toBeNull()
  const instanceBefore = await inside(p.id, i => i)
  await abortAllDurableObjects()
  // The next request rebuilds the object (a new instance, with the broken bucket gone) ...
  const instanceAfter = await inside(p.id, i => i)
  expect(instanceAfter).not.toBe(instanceBefore)
  // ... and everything is still there.
  expect(await sqlRows(p.id, 'SELECT id, bytes FROM chunks')).toEqual(before.chunks)
  expect(await sqlRows(p.id, 'SELECT seq, through_chunk FROM intent')).toEqual(before.intent)
  expect(await settings(p.id)).toEqual(before.s)
  expect(await alarmOf(p.id)).not.toBeNull()
  // The stored intent republishes under the same sequence once the retry is due.
  await dueRetry(p.id)
  expect(await runDurableObjectAlarm(projectStub(env, p.id))).toBe(true)
  expect(await manifest(p.id)).toBe(1)
  expect(await sqlRows(p.id, 'SELECT seq FROM manifest')).toEqual([{ seq: before.intent[0].seq }])
})

test('Q4: a failure after the R2 put, then a restart, republishes the same sequence with no gap', async () => {
  const p = await newProject()
  expect((await post(p.pk, evt('x1'))).status).toBe(200)
  await breakArchive(p.id, { put: 'after' })
  await age(p.id, 3_600_000 + 1000)
  await runDurableObjectAlarm(projectStub(env, p.id))
  expect(await manifest(p.id)).toBe(0) // the object is in R2 but the manifest does not know it yet
  const put = await env.ARCHIVE.get(archiveKey(p.id, 1)); expect(put).not.toBeNull(); await put!.arrayBuffer()
  await abortAllDurableObjects()
  await dueRetry(p.id)
  expect(await runDurableObjectAlarm(projectStub(env, p.id))).toBe(true)
  expect(await sqlRows(p.id, 'SELECT seq FROM manifest')).toEqual([{ seq: 1 }])
})

test('Q2: evictDurableObject also rebuilds the object, and an acknowledged event survives', async () => {
  const p = await newProject()
  expect((await post(p.pk, evt('e1'))).status).toBe(200)
  const alarm = await alarmOf(p.id)
  const first = await inside(p.id, i => i)
  await evictDurableObject(projectStub(env, p.id))
  expect(await inside(p.id, i => i)).not.toBe(first)
  expect(await sqlRows(p.id, 'SELECT COUNT(*) n FROM chunks')).toEqual([{ n: 1 }])
  expect(await alarmOf(p.id)).toBe(alarm)
  await rpc('Publish', { project: p.id })
  expect(await manifest(p.id)).toBe(1)
})

test('Q5: storage and alarms left by earlier tests in this file are still there (nothing resets between tests)', async () => {
  const ids = await listDurableObjectIds(env.PROJECT)
  console.log('project objects visible from this test:', ids.length)
  expect(ids.length).toBeGreaterThan(1)
})
