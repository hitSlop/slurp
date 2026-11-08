// Archive publication must survive an R2 outage that outlasts Cloudflare's own alarm retries, with nothing else to wake the project.
// Nothing here waits for a schedule: the stored times are moved (age, dueRetry) and the alarm handler is run directly.
import { abortAllDurableObjects } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, test } from 'vitest'
import { archiveKey } from '../../src/publisher.ts'
import { HOUR, age, alarm, alarmAt, assert, breakArchive, count, dueRetry, evt, healArchive, newProject, post, publish, settings, sql, stats } from './helpers.ts'

afterEach(abortAllDurableObjects)

test('a stored alarm for the future fires, and the handler publishes only once the stored facts make it due', async () => {
  const p = await newProject('alarm_due')
  assert.equal((await post(p.pk, evt('a1'))).status, 200)
  const armed = await alarmAt(p)
  assert.ok(armed! > Date.now() + 3_000_000, 'armed one seal interval (an hour) after the event')
  // Not due: the handler runs (even though its alarm is in the future) and publishes nothing.
  assert.equal(await alarm(p), true)
  assert.equal(await count(p, 'manifest'), 0)
  assert.equal(await alarmAt(p), armed, 'and sets the same time again')
  // Make it due by moving the stored time back, not by waiting.
  await age(p, HOUR + 1000)
  assert.equal(await alarm(p), true)
  assert.equal(await count(p, 'manifest'), 1)
  assert.equal(await count(p, 'chunks'), 0)
  assert.equal(await alarmAt(p), null, 'nothing is left to wait for')
  const object = await env.ARCHIVE.get(archiveKey(p.id, 1))
  assert.ok(object); await object!.arrayBuffer()
})

test('when archive writes fail, the alarm does not throw and keeps trying until the events are published, with no new ingestion', async () => {
  const p = await newProject('alarm_retry')
  assert.equal((await post(p.pk, evt('a1'))).status, 200)
  await breakArchive(p)
  await age(p, HOUR + 1000)
  // The alarm handler itself: it once threw here (Cloudflare would retry it a few times and then give up).
  assert.equal(await alarm(p), true, 'the alarm handler must not throw on an archive failure')
  const failed = await stats(p)
  assert.equal(failed.manifest, 0); assert.equal(failed.pending, true)
  const s = await settings(p)
  assert.ok(Number(s.failures) >= 1)
  const retryIn = Number(s.retry_at) - Date.now()
  assert.ok(retryIn > 0 && retryIn < 120_000, `a retry is scheduled, soon, not at the next publish interval (${retryIn} ms)`)
  assert.equal(failed.intent?.seq, 1, 'the intent is kept for the retry')
  const retryAlarm = await alarmAt(p)
  assert.ok(Math.abs(retryAlarm! - Number(s.retry_at)) <= 1000, 'and an alarm is armed for it')
  // R2 comes back. Nobody sends anything; when the retry falls due, the alarm publishes.
  await healArchive(p)
  await dueRetry(p)
  assert.equal(await alarm(p), true)
  const done = await stats(p)
  assert.deepEqual([done.manifest, done.pending, done.alarm], [1, false, null])
  assert.deepEqual(await settings(p), {})
})

test('a failing project keeps backing off and does not touch another project', async () => {
  const broken = await newProject('alarm_broken'), fine = await newProject('alarm_fine')
  assert.equal((await post(broken.pk, evt('b1'))).status, 200); assert.equal((await post(fine.pk, evt('f1'))).status, 200)
  await breakArchive(broken)
  await age(broken, HOUR + 1000)
  const delays: number[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await alarm(broken), true)
    delays.push(Number((await settings(broken)).retry_at) - Date.now())
    if (attempt < 2) await dueRetry(broken)
  }
  assert.ok(Number((await settings(broken)).failures) >= 3, 'every failure counts, and the retries keep coming')
  assert.ok(delays[1] > delays[0] * 1.5 && delays[2] > delays[1] * 1.5, `the delay grows: ${delays.join(', ')} ms`)
  await publish(fine)
  assert.equal(await count(fine, 'manifest'), 1, 'another project is unaffected')
  assert.ok((await settings(broken)).retry_at !== undefined, 'the failing project has a retry scheduled')
  await healArchive(broken)
  assert.equal(await alarm(broken), true) // the retry is not due yet: nothing is published
  assert.equal(await count(broken, 'manifest'), 0)
  await dueRetry(broken)
  await alarm(broken)
  assert.equal(await count(broken, 'manifest'), 1, 'recovery')
  assert.deepEqual(await sql(broken, 'SELECT seq FROM manifest'), [{ seq: 1 }])
})
