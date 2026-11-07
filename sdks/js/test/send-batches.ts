import assert from 'node:assert/strict'
import { createClient, memoryStorage } from '../src/index.ts'

const [key, endpoint] = process.argv.slice(2)
assert.ok(key && endpoint, 'usage: node send-batches.ts KEY INGEST_URL')
const storage = memoryStorage()
const acked = new Set<string>()
const batches: string[] = []
let duplicates = 0
const send: typeof fetch = async (input, init) => {
  const body = String(init?.body)
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, await response.text())
  if (response.headers.get('Slurp-Duplicate') === '1') duplicates++
  for (const line of body.trimEnd().split('\n')) acked.add(JSON.parse(line).id)
  return response
}
const errors: string[] = []
const client = createClient({
  key, endpoint, storage, flushAt: 100, flushIntervalMs: 60_000, maxBatchEvents: 3,
  onError: error => { errors.push(error.message) },
  fetch: async (input, init) => {
    const body = String(init?.body)
    const persisted = JSON.parse((await storage.getItem(`@hitslop/slurp-sdk:v1:${endpoint}:${key.split('_')[2]}`))!)
    assert.equal(persisted.batches[0], body)
    batches.push(body)
    return send(input, init)
  },
})
try {
  const tracked = Array.from({ length: 5 }, (_, index) => client.track('sdk_delivery', { index, text: '雪\n"quoted"' }))
  await client.flush()
  assert.deepEqual(errors, [])
  assert.equal(client.pending, 0)
  const batchSizes = batches.map(body => body.trimEnd().split('\n').length)
  assert.deepEqual(batchSizes, [3, 2])
  // Replay the SDK's persisted bytes after the original request was acknowledged.
  await send(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-ndjson' },
    body: batches[0],
  })
  assert.equal(duplicates, 1)
  assert.deepEqual([...acked].sort(), [...tracked].sort())
  console.log(JSON.stringify({ acked_ids: [...acked], duplicate_responses: duplicates, batch_sizes: batchSizes }))
} finally { await client.close() }
