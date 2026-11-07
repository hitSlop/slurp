import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { debug, newSource, readArchives, startWorker, type Worker } from './harness.ts'
import { decodeSentryKey, parseEnvelope, sentryKeyFor } from '../src/compat/sentry.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`
const archive = async (s: { id: string; sk: string }) => { await debug(w.base, 'seal', s.id); return (await readArchives(w.base, s.id, s.sk)).flatMap(a => a.lines) }
const enc = (...parts: (string | object)[]) => parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n') + '\n'
const post = (path: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`${w.base}${path}`, { method: 'POST', headers, body: body as BodyInit })
const errorEvent = (id: string, extra: object = {}) => ({
  event_id: id, timestamp: 1794075640.5, platform: 'javascript', level: 'error', release: 'app@1', environment: 'prod',
  sdk: { name: 'sentry.javascript.browser', version: '10.0.0' }, user: { id: 'u7', email: 'u@x.test' }, tags: { feature: 'checkout' },
  exception: { values: [{ type: 'TypeError', value: 'x is undefined', mechanism: { type: 'generic', handled: true }, stacktrace: { frames: [{ filename: 'app.js', function: 'a', lineno: 1, in_app: true }] } }] },
  ...extra,
})

test('the DSN key is the publishable key, hex-encoded, so the SDK accepts it', () => {
  const pk = 'slurp_pk_-6z1HjNk5AiSBac0SDRmCVwgs_eM5bG8'
  const hex = sentryKeyFor(pk)
  assert.match(hex, /^[0-9a-f]+$/)
  assert.equal(decodeSentryKey(hex), pk); assert.equal(decodeSentryKey(pk), pk)
  assert.equal(decodeSentryKey(sentryKeyFor('slurp_sk_secret')), null); assert.equal(decodeSentryKey('abc'), null); assert.equal(decodeSentryKey('zz'), null)
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
  const s = await newSource(w.base, name('sentry'))
  const key = sentryKeyFor(s.pk)
  const event = errorEvent('0123456789abcdef0123456789abcdef')
  const res = await post('/api/1/envelope/', enc({ event_id: event.event_id, sent_at: '2026-11-07T10:00:00Z' }, { type: 'event' }, event), { 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=x/1, sentry_key=${key}` })
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { id: event.event_id })
  const [rec] = await archive(s)
  assert.equal(rec.id, event.event_id); assert.equal(rec.type, 'track'); assert.equal(rec.event, 'error'); assert.equal(rec.user_id, 'u7')
  assert.equal(rec.timestamp, new Date(1794075640500).toISOString())
  assert.deepEqual(rec.context, { compat: 'sentry', library: { name: 'sentry.javascript.browser', version: '10.0.0' } })
  assert.deepEqual(rec.data, event, 'the Sentry event is kept exactly as sent')
})

test('credentials: header, query string, envelope DSN and raw key all work; missing, wrong, conflicting or secret keys are 403', async () => {
  const s = await newSource(w.base, name('sentryauth'))
  const key = sentryKeyFor(s.pk)
  const body = (id: string, dsn?: string) => enc({ event_id: id, ...(dsn ? { dsn } : {}) }, { type: 'event' }, errorEvent(id))
  assert.equal((await post(`/api/1/envelope/?sentry_key=${key}&sentry_version=7`, body('a'.repeat(32)), { 'content-type': 'text/plain' })).status, 200, 'query string (browser SDKs avoid a preflight)')
  assert.equal((await post('/api/1/envelope/', body('b'.repeat(32), `http://${key}@host.test/1`))).status, 200, 'DSN in the envelope header')
  assert.equal((await post('/api/1/envelope/', body('c'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${s.pk}` })).status, 200, 'raw publishable key')
  assert.equal((await post('/api/1/envelope/', body('d'.repeat(32)))).status, 403, 'no credentials')
  assert.equal((await post('/api/1/envelope/', body('e'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${sentryKeyFor('slurp_pk_unknown')}` })).status, 403)
  assert.equal((await post('/api/1/envelope/', body('f'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${sentryKeyFor(s.sk)}` })).status, 403, 'secret keys never work')
  const other = await newSource(w.base, name('sentryother'))
  assert.equal((await post(`/api/1/envelope/?sentry_key=${key}`, body('g'.repeat(32)), { 'x-sentry-auth': `Sentry sentry_key=${sentryKeyFor(other.pk)}` })).status, 403, 'credentials must agree')
  assert.equal((await archive(s)).length, 3)
})

test('items are mapped or dropped on purpose; messages are not errors; gzip and legacy /store/ work', async () => {
  const s = await newSource(w.base, name('sentryitems'))
  const key = sentryKeyFor(s.pk)
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
  assert.equal(byEvent('check_in')[0].data.monitor_slug, 'nightly'); assert.equal(byEvent('error')[0].id, id('3'))
})

test('retries dedupe; an oversize event is dropped without failing the request; malformed input is 400; CORS preflight', async () => {
  const s = await newSource(w.base, name('sentryedge'))
  const auth = { 'x-sentry-auth': `Sentry sentry_key=${sentryKeyFor(s.pk)}` }
  const body = enc({ event_id: 'a'.repeat(32) }, { type: 'event' }, errorEvent('a'.repeat(32)))
  for (let n = 0; n < 2; n++) assert.equal((await post('/api/1/envelope/', body, auth)).status, 200)
  const huge = enc({ event_id: 'b'.repeat(32) }, { type: 'event' }, errorEvent('b'.repeat(32), { extra: { blob: 'x'.repeat(1_100_000) } }))
  assert.equal((await post('/api/1/envelope/', huge, auth)).status, 200)
  assert.deepEqual((await archive(s)).map(l => l.id), ['a'.repeat(32)])
  assert.equal((await post('/api/1/envelope/', '{"event_id":"x"}\n{"type":"event","length":500}\n{}', auth)).status, 400)
  assert.equal((await post('/api/1/envelope/', 'garbage', auth)).status, 400)
  const pre = await fetch(`${w.base}/api/1/envelope/`, { method: 'OPTIONS' })
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers')!, /x-sentry-auth/i)
  assert.equal((await fetch(`${w.base}/api/1/envelope/`)).status, 405)
})
