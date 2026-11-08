import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, memoryStorage } from '../src/index.ts'

// What the driver persists and how it sends on page hide; the status handling is in the shared conformance scenarios.
const endpoint = 'https://worker.example/v1/events'
const key = `slurp_pk_0123456789abcdef_web_${'a1'.repeat(24)}`
const savedAt = `@hitslop/slurp-sdk:v1:${endpoint}:0123456789abcdef:web`
const base = { key, endpoint, flushIntervalMs: 3_600_000 }
const reply = (status: number) => new Response(null, { status })

test('saved state has exactly the specified fields: identity, queue, retry deadline and attempts', async () => {
  const storage = memoryStorage()
  const client = createClient({ ...base, storage, fetch: (async () => reply(503)) as any })
  const id = client.track('a')
  client.identify('user-1')
  const result = await client.flush()
  const saved = JSON.parse(storage.getItem(savedAt) as string)
  assert.deepEqual(Object.keys(saved), ['version', 'anonymousId', 'sessionId', 'lastActivity', 'userId', 'queue', 'retryAt', 'attempts'])
  assert.equal(saved.version, 1); assert.equal(saved.userId, 'user-1'); assert.equal(saved.attempts, 1); assert.equal(saved.retryAt, result.retryAt)
  assert.equal(saved.queue.length, 2); assert.equal(JSON.parse(saved.queue[0]).id, id)
  await client.close()
})

test('an acknowledged queue is saved empty, and a client that was refused keeps its queue and leaves no pause flag', async () => {
  const storage = memoryStorage()
  const ok = createClient({ ...base, storage, fetch: (async () => reply(200)) as any })
  ok.track('a')
  await ok.flush()
  assert.deepEqual(JSON.parse(storage.getItem(savedAt) as string).queue, [])
  await ok.close()
  const refused = createClient({ ...base, storage, fetch: (async () => reply(401)) as any })
  refused.track('b')
  assert.equal((await refused.flush()).stopped, true)
  await refused.close()
  const saved = JSON.parse(storage.getItem(savedAt) as string)
  assert.deepEqual(Object.keys(saved).sort(), ['anonymousId', 'attempts', 'lastActivity', 'queue', 'retryAt', 'sessionId', 'version'])
  assert.equal(saved.queue.length, 1); assert.equal(JSON.parse(saved.queue[0]).event, 'b')
})

test('page hide sends one keepalive request with ?key=, no Authorization and at most 60 KB', async () => {
  const globals = ['window', 'document', 'navigator'] as const
  const saved = Object.fromEntries(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const window = Object.assign(new EventTarget(), { location: { href: 'https://example.test/', pathname: '/' } })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', referrer: '', title: 'T' })
  const requests: { url: string; init: any }[] = []
  let client: ReturnType<typeof createClient> | undefined
  try {
    for (const [name, value] of Object.entries({ window, document, navigator: { userAgent: 'test', language: 'en' } })) Object.defineProperty(globalThis, name, { value, configurable: true })
    client = createClient({ ...base, flushAt: 1000, storage: memoryStorage(), fetch: (async (url: string, init: any) => { requests.push({ url, init }); return reply(200) }) as any })
    for (let i = 0; i < 100; i++) client.track(`event${i}`, { pad: 'x'.repeat(1000) }) // about 140 KB in all
    window.dispatchEvent(new Event('pagehide'))
    await client.flush() // finishes what the one keepalive request left
    assert.ok(requests.length >= 2)
    const hide = requests[0]
    assert.equal(hide.init.keepalive, true)
    assert.equal(new URL(hide.url).searchParams.get('key'), key)
    assert.equal(hide.init.headers.Authorization, undefined)
    assert.equal(hide.init.headers['Content-Type'], 'text/plain')
    assert.ok(new TextEncoder().encode(hide.init.body).byteLength <= 60 * 1024, 'within the keepalive limit')
    assert.equal(requests.filter(request => request.init.keepalive).length, 1, 'only the page-hide request is a keepalive one')
    assert.equal(requests[1].init.headers.Authorization, `Bearer ${key}`)
    assert.equal(new URL(requests[1].url).search, '')

    // A first line bigger than the limit is not sent on page hide at all.
    requests.length = 0
    client.track('huge', { pad: 'x'.repeat(70 * 1024) })
    window.dispatchEvent(new Event('pagehide'))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(requests.length, 0)
    assert.equal(client.pending, 1)
    assert.equal((await client.flush()).pending, 0, 'a normal flush sends it')
  } finally {
    await client?.close()
    for (const name of globals) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
