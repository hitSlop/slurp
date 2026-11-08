import assert from 'node:assert/strict'
import { createClient, memoryStorage } from '../src/index.ts'

// Re-verified in integration: run by other suites against a real Worker (usage: node send-batches.ts KEY INGEST_URL).
const [key, endpoint] = process.argv.slice(2)
assert.ok(key && endpoint, 'usage: node send-batches.ts KEY INGEST_URL')
const storage = memoryStorage()
const acked = new Set<string>()
const batches: string[] = []
const send: typeof fetch = async (input, init) => {
  const body = String(init?.body)
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, await response.text())
  for (const line of body.trimEnd().split('\n')) acked.add(JSON.parse(line).id)
  return response
}
const errors: string[] = []
const client = createClient({
  key, endpoint, storage, flushAt: 100, flushIntervalMs: 60_000, maxBatchEvents: 3,
  onError: error => { errors.push(error.message) },
  fetch: async (input, init) => {
    const body = String(init?.body)
    // Every line on the wire is still saved until it is acknowledged.
    const parsed = key.match(/^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_[0-9a-f]{48}$/)
    const saved = JSON.parse((await storage.getItem(`@hitslop/slurp-sdk:v1:${endpoint}:${parsed ? `${parsed[1]}:${parsed[2]}` : key}`))!)
    assert.deepEqual(saved.queue.slice(0, body.trimEnd().split('\n').length), body.trimEnd().split('\n'))
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
  assert.deepEqual([...acked].sort(), [...tracked].sort())
  console.log(JSON.stringify({ acked_ids: [...acked], batch_sizes: batchSizes }))
} finally { await client.close() }
