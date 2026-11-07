import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, memoryStorage } from '../src/index.ts'

test('capture preserves queued identities and context, source-scoped reloads, and explicit delivery outcomes', async () => {
  const storage = memoryStorage()
  const bodies: string[] = []
  let status = 503
  const fetcher: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body))
    return new Response(null, { status, headers: status === 503 ? { 'Retry-After': '10' } : {} })
  }
  const app = { version: 'before' }
  // Keys name their project, so a replacement key from the same project keeps the saved queue and identity.
  const projectKey = (project: string, random: string) => `slurp_pk_${project.repeat(16)}_${random.repeat(48)}`
  const options = { key: projectKey('a', '1'), endpoint: 'https://events.example/v1/events',
    storage, fetch: fetcher, context: { app }, flushAt: 100, flushIntervalMs: 60_000 }
  const first = createClient(options)
  const ids = [first.track('anonymous', { nested: { value: 1 } }), first.identify('alice', { plan: 'pro' }), first.track('known')]
  app.version = 'after'
  ids.push(first.identify('bob'), first.track('other'), first.track('override', {}, { userId: 'request-user', anonymousId: 'request-anon', sessionId: 'request-session' }))
  ids.push(first.track('still-bob'))
  first.reset()
  ids.push(first.track('reset'))
  const retry = await first.flush()
  assert.deepEqual({ accepted: retry.accepted, rejected: retry.rejected, pending: retry.pending, stopped: retry.stopped }, { accepted: 0, rejected: 0, pending: 8, stopped: false })
  assert.ok(retry.retryAt! > Date.now())
  const records = bodies[0].trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.id), ids)
  assert.deepEqual(records.map(record => record.type), ['track', 'identify', 'track', 'identify', 'track', 'track', 'track', 'track'])
  assert.deepEqual(records.map(record => record.user_id), [undefined, 'alice', 'alice', 'bob', 'bob', 'request-user', 'bob', undefined])
  assert.equal(records[0].anonymous_id, records[1].anonymous_id)
  assert.equal(records[1].session_id, records[2].session_id)
  assert.notEqual(records[2].anonymous_id, records[3].anonymous_id)
  assert.notEqual(records[2].session_id, records[3].session_id)
  assert.equal(records[4].anonymous_id, records[6].anonymous_id)
  assert.notEqual(records[6].anonymous_id, records[7].anonymous_id)
  assert.equal(records[0].context.app.version, 'before')
  assert.equal(records[3].context.app.version, 'after')
  assert.deepEqual(records[1].data, { plan: 'pro' })
  assert.equal(records[1].event, undefined)
  await first.close()
  // A rotating publishable key keeps the same identity and exact persisted body.
  const raw = await storage.getItem('@hitslop/slurp-sdk:v1:https://events.example/v1/events:aaaaaaaaaaaaaaaa')
  const state = JSON.parse(raw!)
  state.retryAt = 0
  await storage.setItem('@hitslop/slurp-sdk:v1:https://events.example/v1/events:aaaaaaaaaaaaaaaa', JSON.stringify(state))
  status = 200
  const next = createClient({ ...options, key: projectKey('a', '2') })
  const accepted = await next.flush()
  assert.deepEqual(bodies[1], bodies[0])
  assert.deepEqual(accepted, { accepted: 8, rejected: 0, pending: 0, retryAt: null, stopped: false })
  next.track('reload')
  await next.flush()
  const reloaded = JSON.parse(bodies.at(-1)!)
  assert.equal(reloaded.anonymous_id, records[7].anonymous_id)
  await next.close()
  const separate = createClient({ ...options, key: projectKey('b', '1') })
  separate.track('different-project')
  await separate.flush()
  assert.notEqual(JSON.parse(bodies.at(-1)!).anonymous_id, reloaded.anonymous_id)
  await separate.close()
})

test('invalid capture does not switch identity and permanent rejections are observable', async () => {
  const bodies: string[] = []
  const client = createClient({ key: 'key', endpoint: 'https://example.test/events', storage: memoryStorage(), flushAt: 100,
    fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response(null, { status: 401 }) } })
  client.identify('alice')
  client.identify('bob', { oversized: 'x'.repeat(1024 * 1024 + 1024) })
  client.track('still-alice')
  client.track('forged-geo', {}, { context: { geo: { country: 'CA' } } })
  const result = await client.flush()
  assert.equal(result.rejected, 4)
  assert.equal(result.pending, 0)
  assert.equal(result.stopped, true)
  assert.deepEqual(bodies[0].trim().split('\n').map(line => JSON.parse(line).user_id), ['alice', 'alice'])
  await client.close()
})
