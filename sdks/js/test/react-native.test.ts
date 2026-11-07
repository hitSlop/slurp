import assert from 'node:assert/strict'
import { test } from 'node:test'

// A React Native-like runtime: `window` exists without `location`, no `document`, no crypto, no TextEncoder, no process.
test('the core runs where window.location, crypto and TextEncoder are missing', async () => {
  const g = globalThis as any
  const saved = { window: g.window, crypto: Object.getOwnPropertyDescriptor(g, 'crypto'), TextEncoder: g.TextEncoder }
  g.window = {}
  Object.defineProperty(g, 'crypto', { value: undefined, configurable: true, writable: true })
  g.TextEncoder = undefined
  try {
    const { createClient, memoryStorage, version } = await import('../src/index.ts?react-native')
    const bodies: string[] = []
    const client = createClient({
      onError: e => assert.fail(e.message), key: 'slurp_pk_test', sourceId: 'src_rn', endpoint: 'https://worker.example/v1/events', storage: memoryStorage(),
      fetch: (async (_url: string, init: { body: string }) => { bodies.push(init.body); return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"ok":true}', json: async () => ({ ok: true }) } }) as any,
    })
    const id = client.track('screen_viewed', { name: 'Home', emoji: 'héllo 🎉', lone: '\ud800' })
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const result = await client.flush()
    assert.equal(result.accepted, 1)
    const record = JSON.parse(bodies[0].trim())
    assert.equal(record.id, id); assert.equal(record.data.emoji, 'héllo 🎉'); assert.deepEqual(record.context.library, { name: '@hitslop/slurp-sdk', version })
    await client.close()
  } finally {
    g.window = saved.window
    if (saved.crypto) Object.defineProperty(g, 'crypto', saved.crypto)
    g.TextEncoder = saved.TextEncoder
  }
})

test('the fallback UTF-8 encoder matches TextEncoder', async () => {
  const g = globalThis as any
  const real = g.TextEncoder
  g.TextEncoder = undefined
  let fallback: { encode(text: string): Uint8Array }
  try { fallback = (await import('../src/event.ts?utf8')).encoder } finally { g.TextEncoder = real }
  for (const text of ['', 'plain', 'héllo', '日本語', '🎉 party', 'a\u0000b', '\ud800x', 'x\udc00']) {
    assert.deepEqual([...fallback.encode(text)], [...new real().encode(text)], JSON.stringify(text))
  }
})
