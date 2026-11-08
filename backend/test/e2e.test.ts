import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { ADMIN_TOKEN, ApiError, admin, archived, call, envelopes, evt, ids, newProject, post, publish, randomName as name, readArchives, records, startWorker, stats, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const rejects = (promise: Promise<unknown>, code: string, what = '') => assert.rejects(promise, (e: ApiError) => e instanceof ApiError && e.code === code, `${what} should be ${code}`)

test('health, and the control API refuses what it should', async () => {
  const h = await (await fetch(`${w.base}/v1/health`)).json() as any
  assert.deepEqual([h.ok, h.apiVersion, h.configured, h.geo], [true, 2, true, true])
  assert.equal((await fetch(`${w.base}/healthz`)).status, 200)
  await rejects(call(w.base, 'wrong', 'ListProjects', {}), 'unauthenticated')
  await rejects(call(w.base, 'slurp_pk_nope', 'CreateProject', { name: name('x') }), 'unauthenticated')
  const response = await fetch(`${w.base}/v1/rpc/ListProjects`, { method: 'POST' })
  assert.equal(response.status, 401); assert.equal(((await response.json()) as any).error.code, 'unauthenticated')
  assert.equal((await fetch(`${w.base}/v1/rpc/NoSuchMethod`, { method: 'POST', headers: admin })).status, 404)
  assert.equal((await fetch(`${w.base}/v1/rpc/ListProjects`, { method: 'POST', headers: admin, body: '{nope' })).status, 400)
  assert.equal((await fetch(`${w.base}/v1/rpc/ListProjects`, { method: 'GET', headers: admin })).status, 405)
  // the signed-URL object route and the old webrpc paths are gone
  assert.equal((await fetch(`${w.base}/v1/objects/abc`)).status, 404)
  assert.equal((await fetch(`${w.base}/rpc/Project/ListProjects`, { method: 'POST', headers: admin })).status, 404)
})

test('the Worker address explains itself and leaks nothing', async () => {
  const res = await fetch(`${w.base}/`)
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  const html = await res.text()
  assert.ok(html.includes(`slurp connect ${w.base} --token-stdin`), 'shows the exact connect command for this origin')
  assert.ok(!html.includes('test-admin-token'), 'never prints the admin token')
  assert.equal((await fetch(`${w.base}/`, { method: 'POST' })).status, 404, 'only GET and HEAD serve the page')
})

test('projects, keys and sources', async () => {
  const n = name('cp')
  const created = await call(w.base, ADMIN_TOKEN, 'CreateProject', { name: n })
  assert.equal(created.created, true); assert.match(created.project.id, /^prj_[0-9a-f]{16}$/)
  // The key names its project and its source, and is only word characters, so it fits a Sentry DSN as is.
  assert.match(created.publishableKey, new RegExp(`^slurp_pk_${created.project.id.slice(4)}_default_[0-9a-f]{48}$`))
  assert.match(created.publishableKey, /^\w+$/)
  assert.equal(created.ingestUrl, `${w.base}/v1/events`)
  for (const bad of ['Bad Name', 'dash-name', '1abc', 'a__b', 'prj_x', 'session_x', 'select', '_slurp', 'x'.repeat(64)])
    await rejects(call(w.base, ADMIN_TOKEN, 'CreateProject', { name: bad }), 'invalid_argument', bad)
  await rejects(call(w.base, ADMIN_TOKEN, 'CreateProject', { name: name('ttl'), title: 'x'.repeat(201) }), 'invalid_argument')
  await rejects(call(w.base, ADMIN_TOKEN, 'CreateProject', {} as any), 'invalid_argument')
  assert.equal((await call(w.base, ADMIN_TOKEN, 'CreateProject', { name: 'app_my_saas' })).project.name, 'app_my_saas', 'CLI-generated alias is accepted')

  const secret = await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: n, scope: 'secret', name: 'cli' })
  assert.match(secret.key.key!, new RegExp(`^slurp_sk_${created.project.id.slice(4)}_[0-9a-f]{48}$`))
  assert.deepEqual([secret.key.scope, secret.key.name, secret.key.source], ['secret', 'cli', undefined])
  const ios = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: n, scope: 'publishable', source: 'ios' })).key
  assert.equal(ios.source, 'ios'); assert.match(ios.key!, new RegExp(`_ios_[0-9a-f]{48}$`))
  await rejects(call(w.base, ADMIN_TOKEN, 'CreateKey', { project: n, scope: 'publishable' }), 'invalid_argument', 'a publishable key needs a source')
  for (const source of ['Web', '1x', 'a-b', 'x'.repeat(33), '']) await rejects(call(w.base, ADMIN_TOKEN, 'CreateKey', { project: n, scope: 'publishable', source }), 'invalid_argument', source)
  await rejects(call(w.base, ADMIN_TOKEN, 'CreateKey', { project: n, scope: 'root' as any }), 'invalid_argument')
  await rejects(call(w.base, ADMIN_TOKEN, 'CreateKey', { project: 'nope', scope: 'secret' }), 'not_found')

  const keys = (await call(w.base, ADMIN_TOKEN, 'ListKeys', { project: created.project.id })).keys
  assert.equal(keys.length, 3)
  assert.equal(keys.find(k => k.source === 'default')!.key, created.publishableKey, 'a publishable key can be read again')
  assert.equal(keys.find(k => k.scope === 'secret')!.key, undefined, 'a secret key is shown once, when it is created')
  assert.equal((await call(w.base, ADMIN_TOKEN, 'ListKeys', { project: n, scope: 'secret' })).keys.length, 1)

  // SourceKey: the oldest live publishable key for the source, made once
  const web = (await call(w.base, ADMIN_TOKEN, 'SourceKey', { project: n, source: 'web' })).key
  assert.deepEqual((await call(w.base, ADMIN_TOKEN, 'SourceKey', { project: n, source: 'web' })).key, web)
  assert.equal((await call(w.base, ADMIN_TOKEN, 'SourceKey', { project: n, source: 'default' })).key.key, created.publishableKey)
  await rejects(call(w.base, ADMIN_TOKEN, 'SourceKey', { project: n, source: 'No Good' }), 'invalid_argument')

  assert.equal((await call(w.base, ADMIN_TOKEN, 'GetProject', { project: n })).project.id, created.project.id)
  assert.equal((await call(w.base, ADMIN_TOKEN, 'GetProject', { project: created.project.id })).ingestUrl, created.ingestUrl)
  await rejects(call(w.base, ADMIN_TOKEN, 'GetProject', { project: 'nope' }), 'not_found')
  assert.ok((await call(w.base, ADMIN_TOKEN, 'ListProjects', {})).projects.some(p => p.id === created.project.id))
  // key-scoped callers cannot use the control plane
  await rejects(call(w.base, secret.key.key!, 'ListProjects', {}), 'forbidden')
  // Whoami says what any token is
  assert.deepEqual(await call(w.base, ADMIN_TOKEN, 'Whoami', {}), { scope: 'admin' })
  assert.deepEqual(await call(w.base, secret.key.key!, 'Whoami', {}), { scope: 'secret', project: created.project.id, name: 'cli' })
  assert.deepEqual(await call(w.base, ios.key!, 'Whoami', {}), { scope: 'publishable', project: created.project.id, source: 'ios' })
  // the removed methods are gone, not stubbed
  for (const gone of ['UpdateProject', 'RotateWebhookSecret']) assert.equal((await fetch(`${w.base}/v1/rpc/${gone}`, { method: 'POST', headers: admin, body: '{}' })).status, 404)
})

test('creating a project twice returns the same project and key, and never rotates a key', async () => {
  const n = name('again')
  const a = await call(w.base, ADMIN_TOKEN, 'CreateProject', { name: n })
  const b = await call(w.base, ADMIN_TOKEN, 'CreateProject', { name: n })
  assert.equal(b.created, false); assert.equal(a.project.id, b.project.id); assert.equal(a.publishableKey, b.publishableKey)
  assert.equal((await post(w.base, a.publishableKey, evt('r1'))).status, 200, 'the installed key still works after a repeat')
  assert.equal((await call(w.base, ADMIN_TOKEN, 'ListKeys', { project: n })).keys.length, 1)
})

test('revoking a key takes effect on the very next request, and each key only opens its own project', async () => {
  const a = await newProject(w.base, name('ka')), b = await newProject(w.base, name('kb'))
  assert.equal((await post(w.base, a.pk, evt('k1'))).status, 200)
  const second = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: a.id, scope: 'publishable', source: 'ios' })).key
  assert.equal((await post(w.base, second.key!, evt('k2'))).status, 200)
  const first = (await call(w.base, ADMIN_TOKEN, 'ListKeys', { project: a.id, scope: 'publishable' })).keys.find(x => x.key === a.pk)!
  const revoked = (await call(w.base, ADMIN_TOKEN, 'RevokeKey', { project: a.id, keyId: first.keyId })).key
  assert.ok(revoked.revokedAt)
  await rejects(call(w.base, ADMIN_TOKEN, 'RevokeKey', { project: a.id, keyId: 'ffffffffffffffff' }), 'not_found')
  assert.equal((await post(w.base, a.pk, evt('k3'))).status, 401, 'revoked: no cache window')
  assert.equal((await post(w.base, second.key!, evt('k4'))).status, 200, 'the other key is untouched')
  // after the revoke the source has no live key: SourceKey makes a new one for the same source
  const again = (await call(w.base, ADMIN_TOKEN, 'SourceKey', { project: a.id, source: 'default' })).key
  assert.notEqual(again.key, a.pk); assert.equal((await post(w.base, again.key!, evt('k5'))).status, 200)
  // a secret key of one project cannot read another, and a made-up project id gets nothing
  await rejects(call(w.base, a.sk, 'ListArchives', { project: b.id }), 'forbidden')
  const forged = `slurp_pk_${'0'.repeat(16)}_default_${'0'.repeat(48)}`
  assert.equal((await post(w.base, forged, evt('f1'))).status, 401)
  assert.equal((await post(w.base, a.pk.replace(/.$/, c => (c === '0' ? '1' : '0')), evt('f2'))).status, 401, 'a key that is nearly right')
  assert.equal((await post(w.base, 'slurp_pk_nope', evt('f3'))).status, 401)
  assert.equal((await post(w.base, ADMIN_TOKEN, evt('f4'))).status, 403, 'the admin token is not an ingest key')
  assert.equal((await stats(w.base, `prj_${'0'.repeat(16)}`)).ready, false, 'a forged project id created no storage')
})

test('every event carries the source of the key that sent it, and a client cannot claim another', async () => {
  const p = await newProject(w.base, name('who'))
  const web = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: p.id, scope: 'publishable', source: 'web' })).key.key!
  const ios = (await call(w.base, ADMIN_TOKEN, 'CreateKey', { project: p.id, scope: 'publishable', source: 'ios' })).key.key!
  assert.equal((await post(w.base, web, evt('w1'))).status, 200)
  assert.equal((await post(w.base, ios, evt('i1'))).status, 200)
  assert.equal((await post(w.base, p.pk, evt('d1'))).status, 200)
  // `sender` is not a reserved field: it is the client's own field, and the envelope's sender is still the key's
  assert.equal((await post(w.base, web, evt('x1', { sender: 'ios' }))).status, 200)
  assert.equal((await post(w.base, web, evt('same'))).status, 200)
  assert.equal((await post(w.base, ios, evt('same'))).status, 200)
  const lines = envelopes(await archived(w.base, p))
  const sender = (id: string) => lines.filter(l => l.record.id === id).map(l => l.sender)
  assert.deepEqual([sender('w1'), sender('i1'), sender('d1'), sender('x1')], [['web'], ['ios'], ['default'], ['web']])
  assert.deepEqual(sender('same').sort(), ['ios', 'web'])
  assert.equal(lines.find(l => l.record.id === 'x1').record.sender, 'ios', 'the record is untouched')
})

test('a minimal record is accepted and stored byte for byte inside its envelope', async () => {
  const p = await newProject(w.base, name('min'))
  const res = await post(w.base, p.pk, '{"event":"x"}')
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { ok: true, accepted: 1 })
  assert.equal((await post(w.base, p.pk, '{"type":"identify","user_id":"u"}')).status, 200)
  const odd = '{"event":"y",  "n":1.2300,"wide":9007199254740993123456789,"e":"\\u00e9\\ud83d\\ude00","z":-0}'
  assert.equal((await post(w.base, p.pk, `  ${odd}\r\n`)).status, 200)
  const [arc] = await archived(w.base, p)
  const lines = arc.raw.split('\n')
  assert.equal(lines[0].replace(/"received_at":"[^"]+"/, '"received_at":"T"').replace(/"geo":\{[^}]*\},/, ''), '{"received_at":"T","sender":"default","record":{"event":"x"}}')
  assert.match(lines[0], /^\{"received_at":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z","sender":"default",/)
  assert.ok(lines[2].endsWith(`,"record":${odd}}`), `the record is untouched: ${lines[2]}`)
  assert.deepEqual(arc.records.map(r => r.event), ['x', undefined, 'y'])
})

test('ingest rules: atomic, every bad line is listed, empty body, CORS, query key', async () => {
  const s = await newProject(w.base, name('ing'))
  const bad = await post(w.base, s.pk, [evt('ok1'), '{"data":{}}', '', 'not json', evt('ok2', { timestamp: 'today' }), '{"event":"x","id":null}'].join('\n'))
  assert.equal(bad.status, 400)
  const body = await bad.json() as any
  assert.equal(body.error, 'invalid records')
  assert.deepEqual(body.rejected.map((r: any) => r.line), [2, 4, 5, 6], 'every bad line, numbered from 1 counting blanks')
  assert.equal(body.rejected[2].reason, 'timestamp must be RFC 3339')
  assert.equal(bad.headers.get('access-control-allow-origin'), '*')
  assert.equal((await stats(w.base, s.id)).pending, false, 'nothing was stored')
  const tooMany = await post(w.base, s.pk, '{}\n'.repeat(150))
  assert.equal(((await tooMany.json()) as any).rejected.length, 100, 'capped at 100')
  const ok = await post(w.base, s.pk, evt('a') + '\n' + evt('b') + '\n')
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, accepted: 2 }); assert.equal(ok.headers.get('access-control-allow-origin'), '*')
  assert.equal(ok.headers.get('slurp-duplicate'), null, 'there is no body-hash dedupe')
  assert.match(ok.headers.get('access-control-expose-headers') ?? '', /Retry-After/)
  const empty = await post(w.base, s.pk, '\n')
  assert.deepEqual(await empty.json(), { ok: true, accepted: 0 })
  assert.equal((await post(w.base, s.pk, 'x'.repeat(11 * 1024 * 1024))).status, 413)
  assert.equal((await post(w.base, 'slurp_pk_wrong', evt('d'))).status, 401)
  assert.equal((await post(w.base, s.sk, evt('d'))).status, 403)
  assert.equal((await fetch(`${w.base}/v1/events`, { method: 'POST', body: evt('d') })).status, 401)
  assert.equal((await fetch(`${w.base}/v1/events?key=${s.pk}`, { method: 'POST', body: evt('q') })).status, 200, 'publishable key in query (page-hide beacons)')
  assert.equal((await fetch(`${w.base}/v1/events?key=${s.sk}`, { method: 'POST', body: evt('q2') })).status, 401, 'secret keys are refused in the query string')
  assert.equal((await fetch(`${w.base}/v1/events?key=${s.pk}`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: evt('q3') })).status, 200, 'the query key wins over the header')
  assert.equal((await fetch(`${w.base}/v1/events`, { method: 'GET' })).status, 405)
  const pre = await fetch(`${w.base}/v1/events`, { method: 'OPTIONS' })
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers')!, /Authorization/); assert.match(pre.headers.get('access-control-allow-methods')!, /POST/)
  // not UTF-8: a lone 0xFF byte inside a string
  const okBytes = new TextEncoder().encode(evt('u'))
  const res = await post(w.base, s.pk, new Uint8Array([...okBytes.slice(0, 70), 0xff, ...okBytes.slice(71)]))
  assert.equal(res.status, 400); assert.match(((await res.json()) as any).rejected[0].reason, /UTF-8/)
})

test('records without an id are each a new event, including byte-identical repeats; an id makes a retry safe to repeat', async () => {
  const s = await newProject(w.base, name('noid'))
  for (let i = 0; i < 2; i++) assert.equal((await post(w.base, s.pk, '{"event":"ping","data":{"n":1}}')).status, 200)
  const batch = [evt('same'), evt('same')].join('\n')
  assert.equal((await post(w.base, s.pk, batch)).status, 200); assert.equal((await post(w.base, s.pk, batch)).status, 200)
  const lines = records(await archived(w.base, s))
  assert.equal(lines.filter(r => r.event === 'ping').length, 2, 'both id-less posts are stored')
  assert.equal(lines.filter(r => r.id === 'same').length, 4, 'the Worker stores what it is sent; the importer dedupes by (sender, id)')
})

test('a body with no Content-Length is cut off at the limit, not buffered whole first', async () => {
  const small = await startWorker({ MAX_BODY_BYTES: '4096' })
  try {
    const p = await newProject(small.base, name('chunked'))
    const stream = (chunks: number, size: number, pulled: { bytes: number }) => {
      let sent = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ >= chunks) return controller.close()
          pulled.bytes += size
          controller.enqueue(new TextEncoder().encode('x'.repeat(size)))
        },
      })
    }
    const send = (body: ReadableStream<Uint8Array>) => fetch(`${small.base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${p.pk}` }, body, duplex: 'half' } as RequestInit)
    // 32 MB in 16 KB chunks, no Content-Length: refused, and the sender is stopped long before the end.
    const pulled = { bytes: 0 }
    // The Worker stops reading, so the sender may see the 413 or a closed connection (a broken pipe) first; either way it was refused.
    const outcome = await send(stream(2048, 16 * 1024, pulled)).then(r => r.status, () => 'connection closed')
    assert.ok(outcome === 413 || outcome === 'connection closed', `refused, got ${outcome}`)
    assert.ok(pulled.bytes < 16 * 1024 * 1024, `the Worker kept reading: ${pulled.bytes} of ${32 * 1024 * 1024} bytes were pulled`)
    // A chunked body that fits is accepted as before (it is one valid record, padded to just under the limit).
    const record = JSON.parse(evt('fits'))
    record.data = { pad: '' }
    record.data.pad = 'p'.repeat(4096 - JSON.stringify(record).length - 64)
    const fits = JSON.stringify(record)
    assert.ok(fits.length < 4096)
    assert.equal((await send(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(fits)); c.close() } }))).status, 200)
    // The native endpoint takes the bytes as sent: a gzip label does not make it decode them.
    const labelled = await fetch(`${small.base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${p.pk}`, 'Content-Encoding': 'gzip' }, body: evt('labelled') })
    assert.equal(labelled.status, 200)
  } finally { await small.stop() }
})

test('large records are stored whole: 900 KB survives publishing, a record over 1 MiB is rejected by line and nothing is stored', async () => {
  const s = await newProject(w.base, name('big'))
  const pad = (n: number, tail: string) => ({ data: { blob: 'x'.repeat(n) + tail } })
  assert.equal((await post(w.base, s.pk, evt('a'))).status, 200)
  assert.equal((await post(w.base, s.pk, evt('b', pad(900_000, 'END-OF-BLOB')))).status, 200)
  assert.equal((await post(w.base, s.pk, [evt('c', pad(700_000, 'C-END')), evt('d', pad(700_000, 'D-END'))].join('\n'))).status, 200, 'two large records in one request')
  const refused = await post(w.base, s.pk, [evt('e'), evt('f', pad(1_100_000, 'F-END'))].join('\n'))
  assert.equal(refused.status, 400)
  assert.deepEqual(((await refused.json()) as any).rejected, [{ line: 2, reason: 'record exceeds 1 MiB' }])
  const lines = records(await archived(w.base, s))
  assert.deepEqual(lines.map(l => l.id).sort(), ['a', 'b', 'c', 'd'], 'the refused request stored nothing')
  const stored = new Map(lines.map(l => [l.id, l]))
  assert.ok(stored.get('b').data.blob.endsWith('END-OF-BLOB') && stored.get('b').data.blob.length === 900_000 + 'END-OF-BLOB'.length)
  assert.ok(stored.get('c').data.blob.endsWith('C-END') && stored.get('d').data.blob.endsWith('D-END'))
})

test('geo is request.cf only, sorted, and added to the envelope when GEO is on', async () => {
  const on = await newProject(w.base, name('geo'))
  const forged = { 'X-Slurp-Geo-Country': 'ZZ', 'CF-IPCountry': 'ZZ' }
  assert.equal((await post(w.base, on.pk, '{"event":"v","context":{"geo":{"city":"mine"}}}', forged)).status, 200)
  const [line] = envelopes(await archived(w.base, on))
  assert.deepEqual(line.record.context, { geo: { city: 'mine' } }, 'a client "geo" is just a field of its record')
  assert.ok(line.geo, 'local wrangler supplies request.cf')
  assert.deepEqual(Object.keys(line.geo), Object.keys(line.geo).sort(), 'geo keys are sorted')
  assert.ok(Object.keys(line.geo).every(k => ['city', 'country', 'region'].includes(k)))
  assert.notEqual(line.geo.country, 'ZZ', 'client supplied geo headers are ignored')
  assert.deepEqual(Object.keys(line), ['received_at', 'sender', 'geo', 'record'], 'the record is last')

  const off = await startWorker({ GEO: 'off' })
  try {
    assert.equal(((await (await fetch(`${off.base}/v1/health`)).json()) as any).geo, false)
    const p = await newProject(off.base, name('nogeo'))
    assert.equal((await post(off.base, p.pk, '{"event":"v"}')).status, 200)
    assert.deepEqual(Object.keys(envelopes(await archived(off.base, p))[0]), ['received_at', 'sender', 'record'])
  } finally { await off.stop() }
})

test('publish -> ListArchives -> download, with checkpoints, paging and authorization', async () => {
  const s = await newProject(w.base, name('arc'))
  const empty = await call(w.base, s.sk, 'ListArchives', { project: s.id })
  assert.deepEqual(empty, { coverage: { pending: false }, archives: [] })
  for (let i = 0; i < 3; i++) {
    await post(w.base, s.pk, evt(`e${i}`))
    const { coverage } = await publish(w.base, s.id)
    assert.deepEqual([coverage.first, coverage.last, coverage.pending], [1, i + 1, false])
  }
  const list = await call(w.base, s.sk, 'ListArchives', { project: s.id })
  assert.deepEqual(list.archives.map(a => a.seq), [1, 2, 3])
  assert.deepEqual([list.coverage.first, list.coverage.last, list.next, list.gap], [1, 3, undefined, undefined])
  assert.ok(list.coverage.lastAt)
  for (const a of list.archives) {
    const res = await fetch(`${w.base}/v1/projects/${s.id}/archives/${a.seq}`, { headers: { Authorization: `Bearer ${s.sk}` } })
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/gzip'); assert.ok(res.headers.get('etag'))
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), a.sha256); assert.equal(bytes.length, a.size); assert.equal(a.events, 1)
    assert.equal(res.headers.get('content-length'), String(a.size))
  }
  const page = await call(w.base, s.sk, 'ListArchives', { project: s.id, limit: 2 })
  assert.equal(page.archives.length, 2); assert.equal(page.next, 2)
  assert.deepEqual((await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 2 })).archives.map(a => a.seq), [3])
  assert.equal((await call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id, after: 3 })).archives.length, 0)
  await rejects(call(w.base, ADMIN_TOKEN, 'ListArchives', { project: s.id, limit: 5001 }), 'invalid_argument')
  await rejects(call(w.base, s.pk, 'ListArchives', { project: s.id }), 'forbidden')
  await rejects(call(w.base, (await newProject(w.base, name('other'))).sk, 'ListArchives', { project: s.id }), 'forbidden')
  await rejects(call(w.base, '', 'ListArchives', { project: s.id }), 'unauthenticated')
  // download: GET and HEAD, admin or this project's secret key; 404 for what does not exist
  const url = `${w.base}/v1/projects/${s.id}/archives`
  assert.equal((await fetch(`${url}/1`, { headers: admin })).status, 200)
  const head = await fetch(`${url}/1`, { method: 'HEAD', headers: { Authorization: `Bearer ${s.sk}` } })
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), String(list.archives[0].size))
  assert.equal((await fetch(`${url}/1`)).status, 401)
  assert.equal((await fetch(`${url}/1`, { headers: { Authorization: `Bearer ${s.pk}` } })).status, 403)
  assert.equal((await fetch(`${url}/1`, { headers: { Authorization: `Bearer ${(await newProject(w.base, name('o2'))).sk}` } })).status, 403)
  for (const seq of ['4', '0', 'x', '00000000000000000001x']) assert.equal((await fetch(`${url}/${seq}`, { headers: admin })).status, 404, seq)
  assert.equal((await fetch(`${url}/1`, { method: 'POST', headers: admin })).status, 405)
  // archives are numbered per project and listed in R2 order
  assert.deepEqual(ids(await readArchives(w.base, s.id, s.sk)), ['e0', 'e1', 'e2'])
})

test('group commit: concurrent requests share chunks, every event lands exactly once', async () => {
  const s = await newProject(w.base, name('gc'))
  const res = await Promise.all(Array.from({ length: 60 }, (_, i) => post(w.base, s.pk, Array.from({ length: 20 }, (_, k) => evt(`c${i}-${k}`)).join('\n'))))
  assert.deepEqual([...new Set(res.map(r => r.status))], [200])
  const lines = records(await archived(w.base, s))
  assert.equal(lines.length, 1200); assert.equal(new Set(lines.map(l => l.id)).size, 1200)
  const st = await stats(w.base, s.id)
  console.log(`group commit: 60 concurrent requests, rowsWritten=${st.rowsWritten} (includes keys and the publish)`)
  assert.ok(st.chunks === 0 && st.manifest >= 1)
})
