import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { validEventName } from '../src/event.ts'
import { advance, newIdentity, reset } from '../src/identity.ts'
import { Queue } from '../src/queue.ts'
import { classify, retryAfterMs } from '../src/response.ts'
import { restore, storageKey } from '../src/storage.ts'

let n = 0
const ids = () => `id-${++n}`

test('identity: first identification keeps the visitor, switching users and reset start a new one', () => {
  const start = { ...newIdentity(ids), lastActivity: 1000 }
  const alice = advance(start, 1001, 60_000, 'alice', ids)
  assert.equal(alice.anonymousId, start.anonymousId); assert.equal(alice.sessionId, start.sessionId); assert.equal(alice.userId, 'alice')
  const later = advance(alice, 1002, 60_000, undefined, ids)
  assert.equal(later.userId, 'alice'); assert.equal(later.sessionId, start.sessionId)
  const bob = advance(later, 1003, 60_000, 'bob', ids)
  assert.notEqual(bob.anonymousId, start.anonymousId); assert.notEqual(bob.sessionId, start.sessionId); assert.equal(bob.userId, 'bob')
  const again = reset(2000, ids)
  assert.equal(again.userId, undefined); assert.equal(again.lastActivity, 2000); assert.notEqual(again.anonymousId, bob.anonymousId)
})

test('identity: the session times out after exactly sessionTimeoutMs (>=), not before', () => {
  const identity = { ...newIdentity(ids), lastActivity: 1000 }
  assert.equal(advance(identity, 1000 + 59_999, 60_000, undefined, ids).sessionId, identity.sessionId)
  assert.notEqual(advance(identity, 1000 + 60_000, 60_000, undefined, ids).sessionId, identity.sessionId)
})

const line = (name: string, pad = 0) => JSON.stringify({ id: name, event: name, data: { pad: 'x'.repeat(pad) } })

test('queue: byte accounting follows push, ack, drop and trim', () => {
  const queue = new Queue()
  const lines = ['a', 'b', 'c', 'd'].map(name => line(name))
  for (const l of lines) queue.push(l)
  const one = new TextEncoder().encode(lines[0]).byteLength + 1
  assert.equal(queue.bytes, 4 * one)
  queue.take(10, 1_000_000); queue.ack(1)
  assert.equal(queue.bytes, 3 * one)
  queue.take(2, 1_000_000); assert.equal(queue.dropLines([1]), 1)
  assert.equal(queue.bytes, 2 * one); assert.deepEqual(queue.lines, [lines[1], lines[3]], 'c was the second line of the request')
})

test('queue: take is limited by count, bytes and the split limit; a first line that does not fit goes alone', () => {
  const queue = new Queue()
  for (const name of ['a', 'b', 'c', 'd', 'e']) queue.push(line(name, 100))
  const size = new TextEncoder().encode(line('a', 100)).byteLength + 1
  assert.equal(queue.take(3, 10 * size).length, 3)
  queue.release()
  assert.equal(queue.take(10, 2 * size).length, 2)
  queue.release()
  assert.equal(queue.take(10, 1).length, 1, 'oversized first line goes alone')
  queue.release()
  queue.split = 2
  assert.equal(queue.take(10, 10 * size).length, 2)
  assert.equal(new Queue().take(10, 10).length, 0)
})

test('queue: trim never drops the lines in flight and drops the oldest others', () => {
  const queue = new Queue()
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) queue.push(line(name))
  queue.take(3, 1_000_000)
  assert.equal(queue.trim(4, 1_000_000), 2)
  assert.deepEqual(queue.lines.map(l => JSON.parse(l).id), ['a', 'b', 'c', 'f'])
  assert.equal(queue.trim(1, 1), 1, 'only f can go: a, b, c are on the wire')
  assert.deepEqual(queue.lines.map(l => JSON.parse(l).id), ['a', 'b', 'c'])
  queue.ack(3)
  assert.equal(queue.length, 0); assert.equal(queue.bytes, 0)
})

test('queue: dropLines removes the listed lines of the request; halve splits or drops a single line', () => {
  const queue = new Queue()
  for (const name of ['a', 'b', 'c', 'd']) queue.push(line(name))
  queue.take(3, 1_000_000)
  assert.equal(queue.dropLines([0, 2, 7, -1]), 2, 'indices outside the request are ignored')
  assert.deepEqual(queue.lines.map(l => JSON.parse(l).id), ['b', 'd'])
  assert.equal(queue.inFlight, 0)
  queue.take(2, 1_000_000)
  assert.equal(queue.halve(2), false); assert.equal(queue.split, 1)
  assert.equal(queue.take(2, 1_000_000).length, 1)
  assert.equal(queue.halve(1), true); assert.deepEqual(queue.lines.map(l => JSON.parse(l).id), ['d'])
  const five = new Queue(); five.halve(5); assert.equal(five.split, 3, 'the first half is the larger')
})

test('response: every status maps to one action', () => {
  const now = 1_000_000
  assert.deepEqual(classify(200, null, '', 2, now), { kind: 'ok' })
  assert.deepEqual(classify(204, null, '', 2, now), { kind: 'ok' })
  assert.deepEqual(classify(401, null, '', 2, now), { kind: 'pause' })
  assert.deepEqual(classify(403, null, '', 2, now), { kind: 'pause' })
  assert.deepEqual(classify(413, null, '', 2, now), { kind: 'split' })
  assert.deepEqual(classify(408, null, '', 2, now), { kind: 'retry', delayMs: undefined })
  assert.deepEqual(classify(500, '7', '', 2, now), { kind: 'retry', delayMs: undefined }, 'Retry-After is only read on 429 and 503')
  assert.deepEqual(classify(429, '3', '', 2, now), { kind: 'retry', delayMs: 3000 })
  assert.deepEqual(classify(503, new Date(now + 5000).toUTCString(), '', 2, now), { kind: 'retry', delayMs: 5000 })
  assert.deepEqual(classify(422, null, '', 2, now), { kind: 'drop' })
  assert.deepEqual(classify(400, null, 'not json', 2, now), { kind: 'drop' })
  assert.deepEqual(classify(400, null, '{"error":"unreadable"}', 2, now), { kind: 'drop' })
  assert.deepEqual(classify(400, null, '{"rejected":[{"line":9,"reason":"x"}]}', 2, now), { kind: 'drop' }, 'no usable line numbers')
  assert.deepEqual(classify(400, null, '{"rejected":[{"line":2,"reason":"timestamp must be RFC 3339"},{"line":1},{"line":2},{"line":9}]}', 2, now),
    { kind: 'rejected', lines: [1, 2], reasons: 'line 2: timestamp must be RFC 3339' })
})

test('response: Retry-After is digits or an HTTP date, never negative, and ignored otherwise', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')
  assert.equal(retryAfterMs('0', now), 0)
  assert.equal(retryAfterMs(' 120 ', now), 120_000)
  assert.equal(retryAfterMs('Sat, 07 Nov 2026 12:00:30 GMT', now), 30_000)
  assert.equal(retryAfterMs('Sat, 07 Nov 2026 11:00:00 GMT', now), 0)
  assert.equal(retryAfterMs('soon', now), undefined)
  assert.equal(retryAfterMs('', now), undefined)
  assert.equal(retryAfterMs(null, now), undefined)
})

test('storage key: endpoint, project and source from a publishable key; the whole key when it does not parse', () => {
  const key = `slurp_pk_0123456789abcdef_web_${'a1'.repeat(24)}`
  const rotated = `slurp_pk_0123456789abcdef_web_${'b2'.repeat(24)}`
  const expected = '@hitslop/slurp-sdk:v1:https://w.example/v1/events:0123456789abcdef:web'
  assert.equal(storageKey('https://w.example/v1/events', key), expected)
  assert.equal(storageKey('https://w.example/v1/events/?x=1#top', key), expected)
  assert.equal(storageKey('https://w.example/v1/events', rotated), expected, 'another key for the same source is the same sender')
  assert.equal(storageKey('https://w.example/v1/events', 'slurp_pk_test'), '@hitslop/slurp-sdk:v1:https://w.example/v1/events:slurp_pk_test')
  assert.notEqual(storageKey('https://w.example/v1/events', key.replace('_web_', '_ios_')), expected)
})

test('saved state: exactly the spec shape is read, damaged lines are dropped', () => {
  const ok = JSON.stringify({ id: 'x' })
  const { saved, damaged } = restore(JSON.stringify({ version: 1, anonymousId: 'a', sessionId: 's', lastActivity: 5, userId: 'u', queue: [ok, 'junk', ''], retryAt: 9, attempts: 2 }))
  assert.deepEqual(saved, { version: 1, anonymousId: 'a', sessionId: 's', lastActivity: 5, userId: 'u', queue: [ok], retryAt: 9, attempts: 2 })
  assert.equal(damaged, 1)
  assert.throws(() => restore(JSON.stringify({ version: 2 })), /invalid stored SDK state/)
  assert.throws(() => restore(JSON.stringify({ version: 1, anonymousId: 'a', sessionId: 's', lastActivity: 5, queue: 'no', retryAt: 0, attempts: 0 })), /invalid/)
})

// The Worker accepts an event name of 1 to 200 code points. The SDK must never refuse one the Worker accepts: sdks never set `id`, `timestamp` or the rest of a record
// to something the Worker rejects, so the event name is the one client-side check that could disagree with backend/fixtures/canonical/records.json.
test('event names: the SDK check agrees with the Worker\'s canonical record vectors', () => {
  const vectors: { name: string; line?: string; valid: boolean }[] = JSON.parse(readFileSync(new URL('../../../backend/fixtures/canonical/records.json', import.meta.url), 'utf8')).records
  let checked = 0
  for (const vector of vectors) {
    if (vector.line === undefined) continue
    let record: any
    try { record = JSON.parse(vector.line) } catch { continue }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    if ((record.type ?? 'track') !== 'track' || typeof record.event !== 'string') continue
    checked++
    if (vector.valid) assert.ok(validEventName(record.event), `the Worker accepts "${vector.name}", so the SDK must accept its event`)
    // Where the event name is the point of the vector, the SDK refuses exactly what the Worker refuses.
    if (/event/.test(vector.name)) assert.equal(validEventName(record.event), vector.valid, vector.name)
  }
  assert.ok(checked >= 5, `only ${checked} track vectors were checked`)
  assert.equal(validEventName('é'.repeat(200)), true); assert.equal(validEventName('é'.repeat(201)), false)
  assert.equal(validEventName('😀'.repeat(200)), true, 'counted in code points, not UTF-16 units')
  assert.equal(validEventName('😀'.repeat(201)), false)
  assert.equal(validEventName(''), false); assert.equal(validEventName('\ud800'), false); assert.equal(validEventName(5), false)
})
