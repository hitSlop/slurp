// Archive publication must survive an R2 outage that outlasts Cloudflare's own alarm retries, with nothing else to wake the project.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { admin, debug, evt, newProject, post, publish, randomName as name, startWorker, stats, until, type Worker } from './harness.ts'

let w: Worker
// A publish interval of an hour keeps the ordinary alarm out of the way; the retry delay is short so the test is quick.
before(async () => { w = await startWorker({ SEAL_INTERVAL_MS: '3600000', ARCHIVE_RETRY_MS: '100' }) })
after(async () => { await w.stop() })

test('when archive writes fail, the alarm does not throw and keeps trying until the events are published, with no new ingestion', async () => {
  const p = await newProject(w.base, name('alarm_retry'))
  assert.equal((await post(w.base, p.pk, evt('a1'))).status, 200)
  await debug(w.base, 'fail-archive', p.id)
  // The alarm handler itself: it once threw here (Cloudflare would retry it a few times and then give up).
  const ran = await fetch(`${w.base}/__debug/alarm/${p.id}?force=1`, { headers: admin })
  assert.equal(ran.status, 200, 'the alarm handler must not throw on an archive failure')
  const failed = await stats(w.base, p.id)
  assert.equal(failed.manifest, 0); assert.equal(failed.pending, true); assert.ok(failed.failures >= 1)
  // The retry may already be running (the delay is 100 ms), so the stored retry time is what is checked, not the armed alarm.
  assert.ok(Number(failed.retryAt) - Date.now() < 10_000, 'a retry is scheduled, soon, not at the next publish interval')
  // R2 comes back. Nobody sends anything; the project publishes on its own.
  await debug(w.base, 'heal-archive', p.id)
  await until(async () => (await stats(w.base, p.id)).manifest === 1, 'the archive to be published by the retry alarm')
  const done = await stats(w.base, p.id)
  assert.deepEqual([done.pending, done.failures], [false, 0])
})

test('a failing project keeps backing off and does not touch another project', async () => {
  const broken = await newProject(w.base, name('alarm_broken')), fine = await newProject(w.base, name('alarm_fine'))
  assert.equal((await post(w.base, broken.pk, evt('b1'))).status, 200); assert.equal((await post(w.base, fine.pk, evt('f1'))).status, 200)
  await debug(w.base, 'fail-archive', broken.id)
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await fetch(`${w.base}/__debug/alarm/${broken.id}?force=1`, { headers: admin })).status, 200)
  assert.ok((await stats(w.base, broken.id)).failures >= 3, 'every failure counts, and the retries keep coming')
  await publish(w.base, fine.id)
  assert.equal((await stats(w.base, fine.id)).manifest, 1, 'another project is unaffected')
  assert.ok((await stats(w.base, broken.id)).retryAt !== null, 'the failing project has a retry scheduled')
  await debug(w.base, 'heal-archive', broken.id)
  await until(async () => (await stats(w.base, broken.id)).manifest === 1, 'recovery')
})
