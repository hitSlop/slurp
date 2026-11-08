import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { archived, newProject, randomName as name, records, startWorker, type Worker } from './harness.ts'
import { parseEnvelope } from '../src/compat/sentry.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const archive = async (s: { id: string; sk: string }) => records(await archived(w.base, s))
const enc = (...parts: (string | object)[]) => parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n') + '\n'
const post = (path: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`${w.base}${path}`, { method: 'POST', headers, body: body as BodyInit })
const errorEvent = (id: string, extra: object = {}) => ({
  event_id: id, timestamp: 1794075640.5, platform: 'javascript', level: 'error', release: 'app@1', environment: 'prod',
  sdk: { name: 'sentry.javascript.browser', version: '10.0.0' }, user: { id: 'u7', email: 'u@x.test' }, tags: { feature: 'checkout' },
  exception: { values: [{ type: 'TypeError', value: 'x is undefined', mechanism: { type: 'generic', handled: true }, stacktrace: { frames: [{ filename: 'app.js', function: 'a', lineno: 1, in_app: true }] } }] },
  ...extra,
})

test('a publishable key is only word characters, so every Sentry SDK accepts it as a DSN public key', () => {
  const pk = `slurp_pk_${'a1'.repeat(8)}_ios_${'0f'.repeat(24)}`
  assert.match(pk, /^\w+$/)
})

test('envelope parsing: length-prefixed and implicit-length items, blank lines, unknown types', () => {
  const payload = '{"a":"multi\\nline"}'
  const raw = `{"event_id":"abc"}\n{"type":"event","length":${payload.length}}\n${payload}\n{"type":"mystery"}\nfree text\n\n{"type":"session"}\n{"status":"ok"}`
  const env = parseEnvelope(new TextEncoder().encode(raw))
  assert.deepEqual(env.items.map(i => i.type), ['event', 'mystery', 'session'])
  assert.throws(() => parseEnvelope(new TextEncoder().encode('{"event_id":"x"}\n{"type":"event","length":99}\n{}')), /length/)
  assert.throws(() => parseEnvelope(new TextEncoder().encode('not json')))
})

test('an error event is stored whole, with the user and library lifted into the record', async () => {
  const s = await newProject(w.base, name('sentry'))
  const key = s.pk
  const event = errorEvent('0123456789abcdef0123456789abcdef')
  const res = await post('/api/1/envelope/', enc({ event_id: event.event_id, sent_at: '2026-11-07T10:00:00Z' }, { type: 'event' }, event), { 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=x/1, sentry_key=${key}` })
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { id: event.event_id })
  const [rec] = await archive(s)
  assert.equal(rec.id, event.event_id); assert.equal(rec.type, 'track'); assert.equal(rec.event, 'error'); assert.equal(rec.user_id, 'u7')
  assert.equal(rec.timestamp, new Date(1794075640500).toISOString())
  assert.deepEqual(rec.context, { compat: 'sentry', library: { name: 'sentry.javascript.browser', version: '10.0.0' } })
  assert.deepEqual(rec.data, event, 'the Sentry event is kept exactly as sent')
})

test('credentials: header, query string, envelope DSN all carry the publishable key as is; missing, wrong, conflicting or secret keys are 403', async () => {
  const s = await newProject(w.base, name('sentryauth'))
  const key = s.pk
  const body = (id: string, dsn?: string) => enc({ event_id: id, ...(dsn ? { dsn } : {}) }, { type: 'event' }, errorEvent(id))
  assert.equal((await post(`/api/1/envelope/?sentry_key=${key}&sentry_version=7`, body('a'.repeat(32)), { 'content-type': 'text/plain' })).status, 200, 'query string (browser SDKs avoid a preflight)')
  assert.equal((await post('/api/1/envelope/', body('b'.repeat(32), `http://${key}@host.test/1`))).status, 200, 'DSN in the envelope header')
  assert.equal((await post('/api/1/envelope/', body('c'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${s.pk}` })).status, 200, 'the key as is (there is no encoding)')
  assert.equal((await post('/api/1/envelope/', body('d'.repeat(32)))).status, 403, 'no credentials')
  assert.equal((await post('/api/1/envelope/', body('e'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${`slurp_pk_${'0'.repeat(16)}_default_${'0'.repeat(48)}`}` })).status, 403)
  assert.equal((await post('/api/1/envelope/', body('f'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${s.sk}` })).status, 403, 'secret keys never work')
  const other = await newProject(w.base, name('sentryother'))
  assert.equal((await post(`/api/1/envelope/?sentry_key=${key}`, body('g'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${other.pk}` })).status, 403, 'credentials must agree')
  assert.equal((await archive(s)).length, 3)
})

test('items are mapped or dropped on purpose; messages are not errors; gzip and legacy /store/ work', async () => {
  const s = await newProject(w.base, name('sentryitems'))
  const key = s.pk
  const auth = { 'x-sentry-auth': `Sentry sentry_key=${key}` }
  const id = (c: string) => c.repeat(32)
  const message = { event_id: id('1'), timestamp: '2026-11-07T10:00:00Z', level: 'info', message: 'hello', exception: { values: [{ value: 'hello', mechanism: { type: 'generic', synthetic: true } }] } }
  const env = enc({ event_id: id('1') }, { type: 'event' }, message,
    { type: 'session' }, { status: 'ok', sid: 'x' }, { type: 'transaction' }, { event_id: id('9'), type: 'transaction', spans: [] },
    { type: 'attachment', length: 3, filename: 'a.txt' }, 'abc', { type: 'client_report' }, { discarded_events: [] },
    { type: 'user_report' }, { event_id: id('2'), name: 'Pat', comments: 'it broke' },
    { type: 'check_in' }, { check_in_id: 'c1', monitor_slug: 'nightly', status: 'ok' })
  assert.equal((await post('/api/1/envelope/', gzipSync(env), { ...auth, 'content-encoding': 'gzip' })).status, 200)
  const legacy = errorEvent(id('3'))
  assert.equal((await post('/api/1/store/', JSON.stringify(legacy), { ...auth, 'content-type': 'application/json' })).status, 200)
  const lines = await archive(s)
  const byEvent = (e: string) => lines.filter(l => l.event === e)
  assert.equal(lines.length, 4, 'message, user feedback, check-in and the legacy error; sessions, transactions, attachments and client reports are dropped')
  assert.equal(byEvent('message').length, 1); assert.equal(byEvent('user_feedback')[0].data.comments, 'it broke')
  assert.ok(!('id' in byEvent('user_feedback')[0]) && !('id' in byEvent('check_in')[0]), 'items with no id of their own have none')
  assert.equal(byEvent('check_in')[0].data.monitor_slug, 'nightly'); assert.equal(byEvent('error')[0].id, id('3'))
})

test('a timestamp that is not a real time is left out: neither sent_at nor the arrival time is used', async () => {
  const s = await newProject(w.base, name('sentry_time'))
  const headers = { 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=x/1, sentry_key=${s.pk}` }
  const id = (n: number) => n.toString(16).padStart(32, '0')
  // 1e300 is a valid JSON number whose date is not valid; the other items in the envelope must still be stored.
  const res = await post('/api/1/envelope/', enc({ sent_at: '2026-11-07T10:00:00.000Z' }, // no event_id here: it would be every item's id
    { type: 'event' }, errorEvent(id(1), { timestamp: 1e300 }),
    { type: 'event' }, errorEvent(id(2), { timestamp: -1e300 }),
    { type: 'event' }, errorEvent(id(3), { timestamp: 'not a date' }),
    { type: 'event' }, errorEvent(id(4), { timestamp: 8.64e15 }),
    { type: 'event' }, errorEvent(id(5), { timestamp: 1794075640.5 })), headers)
  assert.equal(res.status, 200)
  const byId = new Map((await archive(s)).map(l => [l.id, l]))
  assert.equal(byId.size, 5, 'every item was kept')
  for (const n of [1, 2, 3, 4]) assert.ok(!('timestamp' in byId.get(id(n))), `item ${n} has no timestamp`)
  assert.equal(byId.get(id(5)).timestamp, new Date(1794075640500).toISOString(), 'a good timestamp is untouched')
})

test('a retried envelope is stored again for the importer to skip; an oversize event is dropped without failing the request; malformed input is 400; CORS preflight', async () => {
  const s = await newProject(w.base, name('sentryedge'))
  const auth = { 'x-sentry-auth': `Sentry sentry_key=${s.pk}` }
  const body = enc({ event_id: 'a'.repeat(32) }, { type: 'event' }, errorEvent('a'.repeat(32)))
  for (let n = 0; n < 2; n++) assert.equal((await post('/api/1/envelope/', body, auth)).status, 200)
  const huge = enc({ event_id: 'b'.repeat(32) }, { type: 'event' }, errorEvent('b'.repeat(32), { extra: { blob: 'x'.repeat(1_100_000) } }))
  assert.equal((await post('/api/1/envelope/', huge, auth)).status, 200)
  assert.deepEqual((await archive(s)).map(l => l.id), ['a'.repeat(32), 'a'.repeat(32)], 'the Worker has no dedupe; the importer drops the copy by (sender, id)')
  assert.equal((await post('/api/1/envelope/', '{"event_id":"x"}\n{"type":"event","length":500}\n{}', auth)).status, 400)
  assert.equal((await post('/api/1/envelope/', 'garbage', auth)).status, 400)
  const pre = await fetch(`${w.base}/api/1/envelope/`, { method: 'OPTIONS' })
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers')!, /x-sentry-auth/i)
  assert.equal((await fetch(`${w.base}/api/1/envelope/`)).status, 405)
})
