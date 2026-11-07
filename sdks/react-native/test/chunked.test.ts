import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkedStorage } from '../src/chunked.ts'

/** AsyncStorage as it behaves on Android: a value above the limit cannot be stored or read. */
function android(limit = 1000) {
  const values = new Map<string, string>()
  let failNext: ((key: string) => boolean) | undefined
  return {
    values,
    failWhen(predicate: ((key: string) => boolean) | undefined) { failNext = predicate },
    adapter: {
      async getItem(key: string) { const v = values.get(key) ?? null; if (v !== null && v.length > limit) throw new Error('Row too big to fit into CursorWindow'); return v },
      async setItem(key: string, value: string) { if (failNext?.(key)) throw new Error('disk full'); if (value.length > limit) throw new Error('value too large'); values.set(key, value) },
      async removeItem(key: string) { values.delete(key) },
    },
  }
}

test('a value far above the per-item limit is stored in pieces and read back whole', async () => {
  const device = android(1000)
  const storage = chunkedStorage(device.adapter, 400)
  const value = JSON.stringify({ queue: Array.from({ length: 200 }, (_, i) => `{"id":"event-${i}","data":{"pad":"${'x'.repeat(30)}"}}`) })
  assert.ok(value.length > 8000)
  await storage.setItem('state', value)
  assert.equal(await storage.getItem('state'), value)
  assert.ok([...device.values.values()].every(v => v.length <= 1000), 'every stored value fits the limit')
})

test('a small value, an empty value and a missing key behave like plain storage', async () => {
  const storage = chunkedStorage(android().adapter, 400)
  assert.equal(await storage.getItem('nothing'), null)
  await storage.setItem('k', 'small'); assert.equal(await storage.getItem('k'), 'small')
  await storage.setItem('empty', ''); assert.equal(await storage.getItem('empty'), '')
})

test('a plain value written before chunking was added is still read', async () => {
  const device = android()
  await device.adapter.setItem('legacy', 'plain value')
  assert.equal(await chunkedStorage(device.adapter).getItem('legacy'), 'plain value')
})

test('overwriting leaves no orphaned pieces, and removing cleans everything', async () => {
  const device = android(1000)
  const storage = chunkedStorage(device.adapter, 100)
  await storage.setItem('k', 'a'.repeat(950))
  await storage.setItem('k', 'b'.repeat(120))
  assert.equal(await storage.getItem('k'), 'b'.repeat(120))
  assert.equal([...device.values.keys()].filter(key => key.startsWith('k#')).length, 2, 'only the live pieces remain')
  await storage.removeItem('k')
  assert.deepEqual([...device.values.keys()], [])
})

test('a crash while writing leaves the previous value readable, never a torn mix', async () => {
  const device = android(1000)
  const storage = chunkedStorage(device.adapter, 100)
  await storage.setItem('k', 'old-'.repeat(60))
  device.failWhen(key => key === 'k') // the pieces are written, the manifest is not
  await assert.rejects(storage.setItem('k', 'new-'.repeat(60)), /disk full/)
  device.failWhen(undefined)
  assert.equal(await storage.getItem('k'), 'old-'.repeat(60))
  device.failWhen(key => key.endsWith('#2')) // dies partway through the pieces
  await assert.rejects(storage.setItem('k', 'newer-'.repeat(60)), /disk full/)
  device.failWhen(undefined)
  assert.equal(await storage.getItem('k'), 'old-'.repeat(60))
  await storage.setItem('k', 'final')
  assert.equal(await storage.getItem('k'), 'final')
})

test('a missing piece reads as absent, not as half a value', async () => {
  const device = android(1000)
  const storage = chunkedStorage(device.adapter, 100)
  await storage.setItem('k', 'z'.repeat(450))
  const piece = [...device.values.keys()].find(key => key.startsWith('k#'))!
  device.values.delete(piece)
  assert.equal(await storage.getItem('k'), null)
})

test('concurrent saves are applied one at a time, in order', async () => {
  const storage = chunkedStorage(android(1000).adapter, 100)
  await Promise.all(['one'.repeat(80), 'two'.repeat(80), 'three'.repeat(80)].map(value => storage.setItem('k', value)))
  assert.equal(await storage.getItem('k'), 'three'.repeat(80))
})
