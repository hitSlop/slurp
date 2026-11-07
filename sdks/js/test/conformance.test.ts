import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createClient, memoryStorage } from '../src/index.ts'

// The same scenarios every other SDK runs: sdks/conformance/delivery.json.
const suite = JSON.parse(readFileSync(new URL('../../conformance/delivery.json', import.meta.url), 'utf8'))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

for (const scenario of suite.scenarios) {
  test(`conformance: ${scenario.name}`, async () => {
    const script: { status: number; retryAfter?: string }[] = [...scenario.responses]
    const bodies: string[] = []
    const fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      const next = script.shift() ?? { status: 200 }
      if (next.status === 0) throw new TypeError('network error')
      return new Response(next.status === 204 ? null : '', { status: next.status, headers: next.retryAfter === undefined ? {} : { 'Retry-After': next.retryAfter } })
    }) as any
    const client = createClient({ key: 'slurp_pk_test', endpoint: 'https://worker.example/v1/events', flushIntervalMs: 3_600_000, storage: memoryStorage(), fetch, ...scenario.options })
    for (const event of scenario.events) client.track(event)
    let result = await client.flush()
    for (let i = 0; i < 8 && result.pending > 0 && !result.stopped; i++) {
      await wait(Math.max(0, (result.retryAt ?? Date.now()) - Date.now()) + 30)
      result = await client.flush()
    }
    const expected = scenario.expect
    assert.deepEqual(bodies.map(body => body.trim().split('\n').map(line => JSON.parse(line).event)), expected.requests, 'requests')
    if (expected.identicalRetries) assert.ok(bodies.every(body => body === bodies[0]), 'a retry carries exactly the bytes of the request it retries')
    assert.equal(result.accepted, expected.accepted, 'accepted'); assert.equal(result.rejected, expected.rejected, 'rejected')
    assert.equal(result.stopped, expected.stopped, 'stopped'); assert.equal(result.pending, expected.pending, 'pending')
    await client.close()
  })
}
