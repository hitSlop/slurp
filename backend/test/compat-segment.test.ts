import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { archived, newProject, randomName as name, records, startWorker, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const basic = (key: string) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`
const send = (path: string, body: unknown, headers: Record<string, string> = {}, raw?: BodyInit) =>
  fetch(`${w.base}${path}`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) })
const archive = async (s: { id: string; sk: string }) => records(await archived(w.base, s))

test('single-event endpoints: Basic auth with the publishable key, text/plain bodies (Analytics.js)', async () => {
  const s = await newProject(w.base, name('segsingle'))
  const auth = { authorization: basic(s.pk), 'content-type': 'text/plain' }
  const common = { anonymousId: 'anon-1', timestamp: '2026-11-07T10:00:00.000Z', context: { library: { name: 'analytics.js' }, page: { url: 'https://x.test/' } } }
  assert.equal((await send('/v1/t', { ...common, messageId: 'ajs-t', type: 'track', event: 'Signed Up', properties: { plan: 'pro' } }, auth)).status, 200)
  assert.equal((await send('/v1/i', { ...common, messageId: 'ajs-i', type: 'identify', userId: 'u1', traits: { email: 'a@b.test' } }, auth)).status, 200)
  assert.equal((await send('/v1/p', { ...common, messageId: 'ajs-p', type: 'page', name: 'Pricing', category: 'Docs', properties: { path: '/pricing' } }, auth)).status, 200)
  assert.equal((await send('/v1/s', { ...common, messageId: 'ajs-s', type: 'screen', name: 'Home', properties: { tab: 1 } }, auth)).status, 200)
  assert.equal((await send('/v1/g', { ...common, messageId: 'ajs-g', type: 'group', userId: 'u1', groupId: 'org', traits: { name: 'Acme' } }, auth)).status, 200)
  assert.equal((await send('/v1/a', { ...common, messageId: 'ajs-a', type: 'alias', userId: 'u2', previousId: 'u1' }, auth)).status, 200)
  const byId = new Map((await archive(s)).map(l => [l.id, l]))
  assert.deepEqual([...byId.keys()].sort(), ['ajs-a', 'ajs-g', 'ajs-i', 'ajs-p', 'ajs-s', 'ajs-t'])
  const t = byId.get('ajs-t')
  assert.equal(t.type, 'track'); assert.equal(t.event, 'Signed Up'); assert.deepEqual(t.data, { plan: 'pro' })
  assert.equal(t.anonymous_id, 'anon-1'); assert.equal(t.timestamp, '2026-11-07T10:00:00.000Z')
  assert.equal(t.context.compat, 'segment'); assert.equal(t.context.page.url, 'https://x.test/'); assert.ok(!('writeKey' in t))
  const i = byId.get('ajs-i'); assert.equal(i.type, 'identify'); assert.equal(i.user_id, 'u1'); assert.deepEqual(i.data, { email: 'a@b.test' })
  const p = byId.get('ajs-p'); assert.equal(p.event, 'page'); assert.deepEqual(p.data, { path: '/pricing', name: 'Pricing', category: 'Docs' })
  assert.equal(byId.get('ajs-s').event, 'screen')
  assert.deepEqual(byId.get('ajs-g').data, { name: 'Acme', group_id: 'org' })
  assert.deepEqual(byId.get('ajs-a').data, { previous_id: 'u1' }); assert.equal(byId.get('ajs-a').user_id, 'u2')
})

test('batch endpoints /v1/batch (Node) and /v1/b (Swift): key in the body, no Authorization header', async () => {
  const s = await newProject(w.base, name('segbatch'))
  const batch = (prefix: string) => ({
    writeKey: s.pk, sentAt: '2026-11-07T10:00:05.000Z',
    batch: [
      { type: 'track', messageId: `${prefix}-1`, event: 'A', userId: 'u1', properties: {}, timestamp: '2026-11-07T10:00:00Z' },
      { type: 'identify', messageId: `${prefix}-2`, userId: 'u1', traits: { plan: 'pro' } },
    ],
  })
  const a = await send('/v1/batch', batch('n'), { 'content-type': 'application/json' }); assert.equal(a.status, 200)
  assert.deepEqual(await a.json(), { success: true, accepted: 2, rejected: 0 })
  assert.equal((await send('/v1/b', batch('s'), { 'content-type': 'application/json; charset=utf-8' })).status, 200)
  const lines = await archive(s)
  assert.deepEqual(lines.map(l => l.id).sort(), ['n-1', 'n-2', 's-1', 's-2'])
  assert.ok(!('timestamp' in lines.find(l => l.id === 'n-2')), 'a missing timestamp is left out: not sentAt, not the arrival time')
  assert.equal(lines.find(l => l.id === 'n-1').timestamp, '2026-11-07T10:00:00.000Z')
})

test('a timestamp that is not a real time is left out, originalTimestamp is the second choice, and sentAt is never used', async () => {
  const s = await newProject(w.base, name('segtime'))
  const auth = { authorization: basic(s.pk), 'content-type': 'text/plain' }
  const events = [1e300, 8.64e15, 'garbage', '+275760-09-13T00:00:00.000Z'].map((timestamp, i) => ({ messageId: `bad-${i}`, type: 'track', event: 'x', userId: 'u', timestamp }))
  const res = await send('/v1/batch', { batch: [...events,
    { messageId: 'good', type: 'track', event: 'x', userId: 'u', timestamp: '2026-11-07T10:00:00.000Z' },
    { messageId: 'orig', type: 'track', event: 'x', userId: 'u', originalTimestamp: '2026-11-07T09:00:00.000Z' },
    { messageId: 'both', type: 'track', event: 'x', userId: 'u', timestamp: '2026-11-07T10:30:00.000Z', originalTimestamp: '2026-11-07T09:00:00.000Z' }], sentAt: '2026-11-07T11:00:00.000Z' }, auth)
  assert.equal(res.status, 200)
  const byId = new Map((await archive(s)).map(l => [l.id, l]))
  for (let i = 0; i < events.length; i++) assert.ok(!('timestamp' in byId.get(`bad-${i}`)), `event ${i} has no timestamp`)
  assert.equal(byId.get('good').timestamp, '2026-11-07T10:00:00.000Z')
  assert.equal(byId.get('orig').timestamp, '2026-11-07T09:00:00.000Z')
  assert.equal(byId.get('both').timestamp, '2026-11-07T10:30:00.000Z', 'timestamp wins over originalTimestamp')
})

test('a bad event does not cost the rest of its batch, and a retried batch is stored again for the importer to skip', async () => {
  const s = await newProject(w.base, name('segretry'))
  const body = { writeKey: s.pk, batch: [
    { type: 'track', messageId: 'ok-1', event: 'Good', userId: 'u1', timestamp: '2026-11-07T10:00:00Z' },
    { type: 'track', messageId: 'bad-1', userId: 'u1' },
    { type: 'nope', messageId: 'bad-2', event: 'x' },
    { type: 'track', messageId: 'big-1', event: 'Huge', properties: { blob: 'x'.repeat(1_100_000) } },
    'not an object',
  ] }
  const first = await send('/v1/batch', { ...body, sentAt: '2026-11-07T10:00:01Z' })
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), { success: true, accepted: 1, rejected: 4 })
  const retry = await send('/v1/batch', { ...body, sentAt: '2026-11-07T10:00:09Z' }) // new sentAt, same events: the same record
  assert.equal(retry.status, 200)
  const lines = await archive(s)
  assert.deepEqual(lines.map(l => l.id), ['ok-1', 'ok-1'], 'the Worker has no dedupe; the importer drops the copy by (sender, id)')
  assert.equal(JSON.stringify(lines[0]), JSON.stringify(lines[1]), 'both copies are the same record')
  const nothing = await send('/v1/batch', { writeKey: s.pk, batch: [{ type: 'track', messageId: 'z' }] })
  assert.equal(nothing.status, 400, 'a request with no valid event is a 400, which Segment SDKs drop rather than retry')
  assert.equal((await send('/v1/batch', { writeKey: s.pk, batch: [] })).status, 200)
})

test('only what the protocol supplies is stored: an event without a messageId has no id; gzip bodies are accepted', async () => {
  const s = await newProject(w.base, name('seggz'))
  const body = { writeKey: s.pk, batch: [{ type: 'track', event: 'NoId', userId: 'u1', properties: { a: 1 }, context: { geo: { city: 'mine' } } }] }
  const raw = gzipSync(JSON.stringify(body))
  assert.equal((await send('/v1/batch', null, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, raw)).status, 200)
  const [line] = await archive(s)
  assert.ok(!('id' in line) && !('timestamp' in line))
  assert.deepEqual(line.context, { geo: { city: 'mine' }, compat: 'segment' }, 'a context.geo from the client is just a field')
})

test('auth: only publishable keys, never secret ones; unknown keys are refused; malformed bodies are 400', async () => {
  const s = await newProject(w.base, name('segauth'))
  const ev = { type: 'track', messageId: 'a', event: 'e', userId: 'u' }
  assert.equal((await send('/v1/t', ev, { authorization: basic('slurp_pk_nope') })).status, 401)
  assert.equal((await send('/v1/t', ev, { authorization: basic(s.sk) })).status, 401, 'secret keys are never accepted as write keys')
  assert.equal((await send('/v1/t', ev)).status, 401)
  assert.equal((await send('/v1/t', null, { authorization: basic(s.pk) }, '{not json')).status, 400)
  assert.equal((await send('/v1/b', { writeKey: s.pk, batch: 'x' })).status, 400)
  assert.equal((await fetch(`${w.base}/v1/t`, { method: 'GET' })).status, 405)
})

test('browser plumbing: CORS preflight and the settings document Analytics.js loads', async () => {
  const s = await newProject(w.base, name('segset'))
  const pre = await fetch(`${w.base}/v1/t`, { method: 'OPTIONS' })
  assert.equal(pre.status, 204)
  assert.match(pre.headers.get('access-control-allow-headers')!, /authorization/i); assert.match(pre.headers.get('access-control-allow-headers')!, /x-retry-count/i)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  const ok = await fetch(`${w.base}/v1/projects/${s.pk}/settings`)
  assert.equal(ok.status, 200)
  const doc = await ok.json() as any
  assert.equal(doc.integrations['Segment.io'].apiKey, s.pk)
  assert.equal(doc.integrations['Segment.io'].apiHost, `${new URL(w.base).host}/v1`)
  assert.equal(doc.integrations['Segment.io'].protocol, 'http', 'follows the scheme the Worker is served on')
  assert.equal(doc.metrics.sampleRate, 0, 'no metrics beacons')
  assert.equal((await fetch(`${w.base}/v1/projects/slurp_pk_unknown/settings`)).status, 404)
  assert.equal((await fetch(`${w.base}/v1/projects/${s.sk}/settings`)).status, 404, 'a secret key is never echoed back')
})
