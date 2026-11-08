import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { debug, newProject, readArchives, startWorker, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`
const basic = (key: string) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`
const send = (path: string, body: unknown, headers: Record<string, string> = {}, raw?: BodyInit) =>
  fetch(`${w.base}${path}`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) })
const archive = async (s: { id: string; sk: string }) => { await debug(w.base, 'seal', s.id); return (await readArchives(w.base, s.id, s.sk)).flatMap(a => a.lines) }

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
  assert.equal(lines.find(l => l.id === 'n-2').timestamp, '2026-11-07T10:00:05.000Z', 'a missing timestamp falls back to the batch sentAt')
})

test('a timestamp that is not a real time is replaced by sentAt or the arrival time, not stored as an impossible date', async () => {
  const s = await newProject(w.base, name('segtime'))
  const auth = { authorization: basic(s.pk), 'content-type': 'text/plain' }
  const events = [1e300, 8.64e15, 'garbage', '+275760-09-13T00:00:00.000Z'].map((timestamp, i) => ({ messageId: `bad-${i}`, type: 'track', event: 'x', userId: 'u', timestamp }))
  const res = await send('/v1/batch', { batch: [...events, { messageId: 'good', type: 'track', event: 'x', userId: 'u', timestamp: '2026-11-07T10:00:00.000Z' }], sentAt: '2026-11-07T11:00:00.000Z' }, auth)
  assert.equal(res.status, 200)
  const byId = new Map((await archive(s)).map(l => [l.id, l]))
  for (let i = 0; i < events.length; i++) assert.equal(byId.get(`bad-${i}`).timestamp, '2026-11-07T11:00:00.000Z', `event ${i} uses sentAt`)
  assert.equal(byId.get('good').timestamp, '2026-11-07T10:00:00.000Z')
})

test('a retried batch is deduplicated and a bad event does not cost the rest of its batch', async () => {
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
  const retry = await send('/v1/batch', { ...body, sentAt: '2026-11-07T10:00:09Z' }) // new sentAt, same events
  assert.equal(retry.status, 200)
  assert.deepEqual((await archive(s)).map(l => l.id), ['ok-1'], 'stored once, not twice')
  const nothing = await send('/v1/batch', { writeKey: s.pk, batch: [{ type: 'track', messageId: 'z' }] })
  assert.equal(nothing.status, 400, 'a request with no valid event is a 400, which Segment SDKs drop rather than retry')
  assert.equal((await send('/v1/batch', { writeKey: s.pk, batch: [] })).status, 200)
})

test('events without a messageId get a stable derived id; gzip bodies are accepted', async () => {
  const s = await newProject(w.base, name('seggz'))
  const body = { writeKey: s.pk, batch: [{ type: 'track', event: 'NoId', userId: 'u1', timestamp: '2026-11-07T10:00:00Z', properties: { a: 1 } }] }
  const raw = gzipSync(JSON.stringify(body))
  for (let n = 0; n < 2; n++) assert.equal((await send('/v1/batch', null, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, raw)).status, 200)
  const lines = await archive(s)
  assert.equal(lines.length, 1); assert.match(lines[0].id, /^segment-[0-9a-f]{64}$/)
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
