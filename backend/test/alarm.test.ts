// Archive publication must survive an R2 outage that outlasts Cloudflare's own alarm retries, with nothing else to wake the project.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { admin, debug, evt, newProject, post, startWorker, type Worker } from './harness.ts'

let w: Worker
// A seal interval of an hour keeps the ordinary alarm out of the way; the retry delay is short so the test is quick.
before(async () => { w = await startWorker({ SEAL_INTERVAL_MS: '3600000', ARCHIVE_RETRY_MS: '100' }) })
after(async () => { await w.stop() })

const stats = async (project: string) => (await (await fetch(`${w.base}/__debug/stats/${project}`, { headers: admin })).json()) as { pending: boolean; manifest: number; alarm: number | null }
const until = async (check: () => Promise<boolean>, what: string, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
  assert.fail(`timed out waiting for ${what}`)
}

test('when archive writes fail, the alarm does not throw and keeps trying until the events are published, with no new ingestion', async () => {
  const p = await newProject(w.base, 'alarm_retry')
  assert.equal((await post(w.base, p.pk, evt('a1'))).status, 200)
  await debug(w.base, 'fail-archive', p.id)
  // The alarm handler itself: before, it threw here (Cloudflare would retry it six times and then give up).
  const ran = await fetch(`${w.base}/__debug/alarm/${p.id}`, { headers: admin })
  assert.equal(ran.status, 200, 'the alarm handler must not throw on an archive failure')
  const failed = await stats(p.id)
  assert.equal(failed.manifest, 0); assert.equal(failed.pending, true)
  assert.ok(failed.alarm !== null && failed.alarm - Date.now() < 10_000, 'a retry is already scheduled, soon, not at the next seal interval')
  // R2 comes back. Nobody sends anything; the project publishes on its own.
  await debug(w.base, 'heal-archive', p.id)
  await until(async () => (await stats(p.id)).manifest === 1, 'the archive to be published by the retry alarm')
  assert.equal((await stats(p.id)).pending, false)
})

test('a failing project keeps backing off and does not touch another project', async () => {
  const broken = await newProject(w.base, 'alarm_broken'), fine = await newProject(w.base, 'alarm_fine')
  assert.equal((await post(w.base, broken.pk, evt('b1'))).status, 200); assert.equal((await post(w.base, fine.pk, evt('f1'))).status, 200)
  await debug(w.base, 'fail-archive', broken.id)
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await fetch(`${w.base}/__debug/alarm/${broken.id}`, { headers: admin })).status, 200)
  await debug(w.base, 'seal', fine.id)
  assert.equal((await stats(fine.id)).manifest, 1, 'another project is unaffected')
  assert.ok((await stats(broken.id)).alarm !== null, 'the failing project still has an alarm')
  await debug(w.base, 'heal-archive', broken.id)
  await until(async () => (await stats(broken.id)).manifest === 1, 'recovery')
})
