// Spike: is storage isolated per test file, and does an alarm armed in one test fire during the next one?
// No afterEach cleanup on purpose.
import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { projectStub } from '../../src/api.ts'

const ADMIN = 'test-admin-token-0123456789abcdef'
const send = (path: string, init: RequestInit) => exports.default.fetch(new Request(`http://worker${path}`, init))
let project = ''

test('Q5a: this file starts with no Durable Objects, though alarm.test.ts creates many at the same time', async () => {
  expect(await listDurableObjectIds(env.PROJECT)).toHaveLength(0)
  expect(await listDurableObjectIds(env.REGISTRY)).toHaveLength(0)
  const r = await send('/v1/rpc/CreateProject', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'iso_a' }) })
  const c: any = await r.json()
  project = c.project.id
  const e = await send('/v1/events', { method: 'POST', headers: { authorization: `Bearer ${c.publishableKey}` }, body: JSON.stringify({ id: 'x', type: 'track', event: 'e', timestamp: '2026-11-06T00:00:00Z' }) })
  await e.text()
  // Make the project due and arm its alarm 200 ms from now, then leave the test with the alarm pending.
  await runInDurableObject(projectStub(env, project), async (_i, s) => {
    s.storage.sql.exec('UPDATE chunks SET at_ms = at_ms - 4000000')
    await s.storage.setAlarm(Date.now() + 200)
  })
})

test('Q5b: an alarm armed by the previous test fires on its own while this test runs', async () => {
  await new Promise(r => setTimeout(r, 800))
  const archives = await runInDurableObject(projectStub(env, project), (_i, s) => s.storage.sql.exec('SELECT COUNT(*) n FROM manifest').one().n)
  console.log('manifest rows from the previous test\'s alarm:', archives)
  expect(archives).toBe(1) // the leftover alarm ran and published during this test
})

test('Q5c: the previous tests\' storage is visible to later tests in the same file', async () => {
  expect(await listDurableObjectIds(env.PROJECT)).toHaveLength(1)
})
