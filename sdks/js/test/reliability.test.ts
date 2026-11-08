import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, memoryStorage } from '../src/index.ts'

// Failure modes found in review: each of these dropped or stranded events before it was fixed.
const endpoint = 'https://worker.example/v1/events'
const reply = (status: number) => new Response(status === 204 ? null : '', { status })
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until = (retryAt: number | null) => wait(Math.max(0, (retryAt ?? Date.now()) - Date.now()) + 50)
type Handler = (request: { body: string; signal?: AbortSignal; n: number }) => Promise<Response> | Response
function server(handler: Handler) {
  const bodies: string[] = []
  const fetch = (async (_url: string, init: { body: string; signal?: AbortSignal }) => { bodies.push(init.body); return handler({ body: init.body, signal: init.signal, n: bodies.length }) }) as any
  return { bodies, fetch }
}
const names = (body: string) => body.trim().split('\n').map(line => JSON.parse(line).event)
const base = { key: 'slurp_pk_test', endpoint, flushIntervalMs: 3_600_000 }

test('HTTP 408 is retried with the same records, like 429 and 5xx', async () => {
  const s = server(({ n }) => reply(n === 1 ? 408 : 200))
  const client = createClient({ ...base, fetch: s.fetch, storage: memoryStorage() })
  client.track('a'); client.track('b')
  const first = await client.flush()
  assert.equal(first.rejected, 0); assert.equal(first.pending, 2); assert.ok(first.retryAt)
  await until(first.retryAt)
  const second = await client.flush()
  assert.equal(second.accepted, 2); assert.equal(second.pending, 0)
  assert.equal(s.bodies.length, 2); assert.deepEqual(s.bodies[1].split('\n').sort(), s.bodies[0].split('\n').sort(), 'the retry carries the same records')
  await client.close()
})

test('every 2xx status is an acknowledgement', async () => {
  for (const status of [200, 201, 202, 204]) {
    const s = server(() => reply(status))
    const client = createClient({ ...base, fetch: s.fetch, storage: memoryStorage() })
    client.track('a')
    const result = await client.flush()
    assert.equal(result.accepted, 1, `HTTP ${status}`); assert.equal(result.rejected, 0); assert.equal(result.pending, 0)
    await client.close()
  }
})

test('a request that never answers is aborted and retried', async () => {
  let aborted = false
  const s = server(({ n, signal }) => {
    if (n > 1) return reply(200)
    signal?.addEventListener('abort', () => { aborted = true })
    return new Promise<Response>(() => {}) // never settles, and ignores the abort
  })
  const client = createClient({ ...base, fetch: s.fetch, storage: memoryStorage(), requestTimeoutMs: 100 })
  client.track('a')
  const first = await client.flush()
  assert.ok(aborted, 'the request was cancelled'); assert.equal(first.pending, 1); assert.equal(first.accepted, 0); assert.ok(first.retryAt)
  await until(first.retryAt)
  assert.equal((await client.flush()).accepted, 1)
  assert.equal(s.bodies[0], s.bodies[1])
  await client.close()
})

test('the queue is limited by bytes: the oldest lines go and the rest is kept for retry', async () => {
  const dropped: number[] = []
  const s = server(() => reply(503))
  const client = createClient({ ...base, fetch: s.fetch, storage: memoryStorage(), maxQueueBytes: 3_000, maxBatchEvents: 2, onError: (_e, d) => { if (d) dropped.push(d) } })
  for (let i = 0; i < 10; i++) client.track(`event${i}`, { pad: 'x'.repeat(500) })
  const result = await client.flush()
  assert.ok(result.pending < 10 && result.pending >= 1, `pending ${result.pending}`)
  assert.equal(result.pending + result.rejected, 10, 'everything is either still waiting or was reported dropped')
  assert.equal(dropped.reduce((a, b) => a + b, 0), result.rejected)
  assert.ok(result.pending * 560 <= 3_600, 'about 3000 bytes of events are kept, no more')
  await client.close()
})

test('a 401 pause is not saved: the next client on the same storage tries again and sends what was kept', async () => {
  const storage = memoryStorage()
  const refused = server(() => reply(401))
  const old = createClient({ ...base, fetch: refused.fetch, storage })
  old.track('a')
  assert.equal((await old.flush()).stopped, true)
  await old.close()
  const ok = server(() => reply(200))
  const fresh = createClient({ ...base, fetch: ok.fetch, storage })
  fresh.track('b')
  const result = await fresh.flush()
  assert.equal(result.stopped, false); assert.equal(result.accepted, 2)
  assert.deepEqual(ok.bodies.flatMap(names), ['a', 'b'], 'what the refused client kept is sent by the next one')
  await fresh.close()
})

test('401 and 403 pause the client, keep everything that was waiting and report the pause once with nothing dropped', async () => {
  for (const status of [401, 403]) {
    const reported: number[] = []
    const s = server(() => reply(status))
    const client = createClient({ ...base, fetch: s.fetch, storage: memoryStorage(), maxBatchEvents: 2, onError: (_e, d) => { reported.push(d) } })
    for (let i = 0; i < 5; i++) client.track(`e${i}`)
    const result = await client.flush()
    assert.equal(result.stopped, true, `HTTP ${status}`); assert.equal(result.pending, 5, `HTTP ${status}: nothing was dropped`)
    client.track('e5')
    await client.flush(); await client.flush()
    assert.equal(client.pending, 6, 'a capture while paused is queued')
    assert.equal(s.bodies.length, 1, 'and nothing more is sent')
    assert.deepEqual(reported, [0], `HTTP ${status}: the pause is reported once, with dropped 0`)
    await client.close()
  }
})

test('saved state is validated: damaged lines are dropped and reported, the rest is sent', async () => {
  const storage = memoryStorage()
  const key = '@hitslop/slurp-sdk:v1:https://worker.example/v1/events:slurp_pk_test'
  const good = (id: string) => JSON.stringify({ id, type: 'track', event: id, timestamp: '2026-11-07T00:00:00.000Z', data: {} })
  storage.setItem(key, JSON.stringify({
    version: 1, anonymousId: 'anon', sessionId: 'sess', lastActivity: 0, retryAt: 0, attempts: 0,
    queue: [good('ok1'), '{"id":"hal', 'not json', '[1,2]', good('ok2')],
  }))
  const reported: number[] = []
  const s = server(() => reply(200))
  const client = createClient({ ...base, fetch: s.fetch, storage, onError: (_e, d) => { if (d) reported.push(d) } })
  const result = await client.flush()
  assert.deepEqual(reported, [3], 'two lines that are not JSON and one [1,2]')
  assert.equal(result.accepted, 2)
  const sent = s.bodies.flatMap(names)
  assert.deepEqual(sent.sort(), ['ok1', 'ok2'])
  assert.ok(s.bodies.every(body => body.trim().split('\n').every(line => { try { JSON.parse(line); return true } catch { return false } })), 'no line that was sent is malformed')
  await client.close()
})
