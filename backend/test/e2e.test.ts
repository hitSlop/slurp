import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { AlreadyExistsError, ForbiddenError, InvalidArgumentError, NotFoundError, UnauthenticatedError } from '../src/slurp.gen.ts'
import { ADMIN_TOKEN, admin, debug, evt, newProject, post, readArchives, startWorker, stats, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`

test('health and auth gates (generated clients)', async () => {
  assert.equal((await w.clients.health.version({})).schema, 'v0.6.0')
  const h = await (await fetch(`${w.base}/v1/health`)).json() as any
  assert.equal(h.configured, true); assert.equal(h.capabilities.archive, 'jsonl.gz')
  await assert.rejects(w.clients.project.listProjects({}), UnauthenticatedError)
  await assert.rejects(w.clients.project.listProjects({}, { Authorization: 'Bearer wrong' }), UnauthenticatedError)
  await assert.rejects(w.clients.project.createProject({ name: name('x') }, { Authorization: 'Bearer slurp_pk_nope' }), UnauthenticatedError)
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

test('project and key control plane', async () => {
  const n = name('cp')
  const created = await w.clients.project.createProject({ name: n }, admin)
  assert.equal(created.created, true); assert.match(created.project.id, /^prj_[0-9a-f]{16}$/)
  // A key names its project and is made only of word characters, so it fits a Sentry DSN as is.
  assert.match(created.publishableKey, new RegExp(`^slurp_pk_${created.project.id.slice(4)}_[0-9a-f]{48}$`))
  assert.equal(created.ingestUrl, `${w.base}/v1/events`)
  for (const bad of ['Bad Name', 'dash-name', '1abc', 'a__b', 'prj_x', 'session_x', 'select', '_slurp', 'x'.repeat(64)])
    await assert.rejects(w.clients.project.createProject({ name: bad }, admin), InvalidArgumentError, bad)
  await assert.rejects(w.clients.project.createProject({ name: name('ttl'), title: 'x'.repeat(201) }, admin), InvalidArgumentError)
  assert.equal((await w.clients.project.createProject({ name: 'app_my_saas' }, admin)).project.name, 'app_my_saas', 'CLI-generated alias is accepted')
  const k = await w.clients.project.createKey({ project: n, scope: 'secret', name: 'cli' }, admin)
  assert.match(k.key, new RegExp(`^slurp_sk_${created.project.id.slice(4)}_[0-9a-f]{48}$`))
  await assert.rejects(w.clients.project.createKey({ project: n, scope: 'root' }, admin), InvalidArgumentError)
  await assert.rejects(w.clients.project.createKey({ project: 'nope', scope: 'secret' }, admin), NotFoundError)
  const keys = (await w.clients.project.listKeys({ project: created.project.id }, admin)).keys
  assert.equal(keys.length, 2)
  assert.equal(keys.find(x => x.scope === 'publishable')!.key, created.publishableKey, 'a publishable key can be read again')
  assert.equal(keys.find(x => x.scope === 'secret')!.key, undefined, 'a secret key is never stored or listed')
  assert.equal((await w.clients.project.getProject({ project: n }, admin)).project.id, created.project.id)
  await assert.rejects(w.clients.project.getProject({ project: 'nope' }, admin), NotFoundError)
  assert.equal((await w.clients.project.updateProject({ project: n, title: 'T' }, admin)).project.title, 'T')
  const other = name('cp2')
  await w.clients.project.createProject({ name: other }, admin)
  await assert.rejects(w.clients.project.updateProject({ project: other, name: n }, admin), AlreadyExistsError)
  // key-scoped callers cannot use the control plane
  await assert.rejects(w.clients.project.listProjects({}, { Authorization: `Bearer ${k.key}` }), ForbiddenError)
  // the hosted-service methods (memberships, usage, billing) are gone from the API, not stubbed
  const gone = async (service: string, method: string) => (await fetch(`${w.base}/rpc/${service}/${method}`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: '{}' })).status
  assert.equal(await gone('Billing', 'GetStatus'), 404); assert.equal(await gone('Usage', 'GetUsage'), 404); assert.equal(await gone('Source', 'ListSources'), 404)
  assert.equal((await w.clients.health.version({})).server, 'slurp-worker')
})

test('creating a project twice returns the same project and key, and never rotates a key', async () => {
  const n = name('again')
  const a = await w.clients.project.createProject({ name: n }, admin)
  const b = await w.clients.project.createProject({ name: n, geoEnabled: true }, admin)
  assert.equal(b.created, false); assert.equal(a.project.id, b.project.id); assert.equal(a.publishableKey, b.publishableKey)
  assert.equal((await w.clients.project.getProject({ project: n }, admin)).geoEnabled, false, 'geo applies only when the project is created')
  assert.equal((await post(w.base, a.publishableKey, evt('r1'))).status, 200, 'the installed key still works after a repeat')
  assert.equal((await w.clients.project.listKeys({ project: n }, admin)).keys.length, 1)
})

test('revoking a key takes effect on the very next request, and each key only opens its own project', async () => {
  const a = await newProject(w.base, name('ka')), b = await newProject(w.base, name('kb'))
  assert.equal((await post(w.base, a.pk, evt('k1'))).status, 200)
  const second = await w.clients.project.createKey({ project: a.id, scope: 'publishable', name: 'ios' }, admin)
  assert.equal((await post(w.base, second.key, evt('k2'))).status, 200)
  const first = (await w.clients.project.listKeys({ project: a.id, scope: 'publishable' }, admin)).keys.find(x => x.key === a.pk)!
  await w.clients.project.revokeKey({ project: a.id, keyId: first.keyId }, admin)
  await assert.rejects(w.clients.project.revokeKey({ project: a.id, keyId: 'ffffffffffffffff' }, admin), NotFoundError)
  assert.equal((await post(w.base, a.pk, evt('k3'))).status, 401, 'revoked: no cache window')
  assert.equal((await post(w.base, second.key, evt('k4'))).status, 200, 'the other key is untouched')
  // a secret key of one project cannot read another, and a made-up project id gets nothing
  await assert.rejects(w.clients.archive.listObjects({ project: b.id }, { Authorization: `Bearer ${a.sk}` }), ForbiddenError)
  const forged = `slurp_pk_${'0'.repeat(16)}_${'0'.repeat(48)}`
  assert.equal((await post(w.base, forged, evt('f1'))).status, 401)
  assert.equal((await post(w.base, a.pk.replace(/.$/, c => (c === '0' ? '1' : '0')), evt('f2'))).status, 401, 'a key that is nearly right')
  assert.equal((await post(w.base, 'slurp_pk_nope', evt('f3'))).status, 401)
  assert.equal((await post(w.base, ADMIN_TOKEN, evt('f4'))).status, 403, 'the admin token is not an ingest key')
})

test('every event is stamped with the key that sent it, and a client cannot claim another sender', async () => {
  const p = await newProject(w.base, name('who'))
  const web = (await w.clients.project.createKey({ project: p.id, scope: 'publishable', name: 'web' }, admin)).key
  const ios = (await w.clients.project.createKey({ project: p.id, scope: 'publishable', name: 'ios' }, admin)).key
  assert.equal((await post(w.base, web, evt('w1'))).status, 200)
  assert.equal((await post(w.base, ios, evt('i1'))).status, 200)
  assert.equal((await post(w.base, p.pk, evt('d1'))).status, 200)
  assert.equal((await post(w.base, web, evt('x1', { sender: 'ios' }))).status, 400, 'sender is reserved')
  assert.equal((await post(w.base, `${w.base}`.slice(0, 0) + web, evt('same'))).status, 200)
  assert.equal((await post(w.base, ios, evt('same'))).status, 200)
  await debug(w.base, 'seal', p.id)
  const lines = (await readArchives(w.base, p.id, p.sk)).flatMap(x => x.lines)
  const sender = (id: string) => lines.filter(l => l.id === id).map(l => l.sender)
  assert.deepEqual([sender('w1'), sender('i1'), sender('d1')], [['web'], ['ios'], ['default']])
  assert.deepEqual(sender('same').sort(), ['ios', 'web'], 'the same body from two senders is two events, not a duplicate')
})

test('ingest rules, CORS, dedupe, wide numbers', async () => {
  const s = await newProject(w.base, name('ing'))
  const wide = '{"id":"b","type":"track","event":"signup","timestamp":"2026-11-06T00:00:00Z","data":{"big":12345678901234567890}}'
  const batch = evt('a') + '\n' + wide + '\n'
  const first = await post(w.base, s.pk, batch)
  assert.equal(first.status, 200)
  const ack = await first.json() as any
  assert.equal(ack.ok, true); assert.equal(ack.publication.state, 'pending'); assert.equal(first.headers.get('access-control-allow-origin'), '*')
  const dup = await post(w.base, s.pk, batch)
  assert.equal(dup.status, 200); assert.equal(dup.headers.get('slurp-duplicate'), '1')
  const bad = async (body: string, status: number, text?: RegExp) => { const r = await post(w.base, s.pk, body); assert.equal(r.status, status, body.slice(0, 80)); if (text) assert.match(((await r.json()) as any).error, text) }
  await bad(evt('c', { received_at: 'x' }), 400, /reserved/)
  await bad(evt('c', { context: { geo: {} } }), 400, /context\.geo/)
  await bad(evt('c') + '\n' + '{"id":"z"}', 400, /line 2/)
  await bad('{"id":"d","id":"d","type":"track","event":"e","timestamp":"2026-11-06T00:00:00Z","data":{}}', 400, /duplicate/)
  await bad('x'.repeat(11 * 1024 * 1024), 413, /too large/)
  assert.equal((await post(w.base, s.pk, '')).status, 200, 'empty body is a no-op ack')
  assert.equal((await post(w.base, 'slurp_pk_wrong', evt('d'))).status, 401)
  assert.equal((await post(w.base, s.sk, evt('d'))).status, 403)
  assert.equal((await fetch(`${w.base}/v1/events?key=${s.pk}`, { method: 'POST', body: evt('q') })).status, 200, 'publishable key in query (page-hide beacons)')
  assert.equal((await fetch(`${w.base}/v1/events?key=${s.sk}`, { method: 'POST', body: evt('q2') })).status, 401, 'secret keys are refused in the query string')
  assert.equal((await fetch(`${w.base}/v1/events`, { method: 'GET' })).status, 405)
  const pre = await fetch(`${w.base}/v1/events`, { method: 'OPTIONS' })
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers')!, /Authorization/)
  // not UTF-8: a lone 0xFF byte inside a string
  const ok = new TextEncoder().encode(evt('u'))
  const bytes = new Uint8Array([...ok.slice(0, 70), 0xff, ...ok.slice(71)])
  assert.equal((await post(w.base, s.pk, bytes)).status, 400)
  // seal and read back: wide number is byte-exact
  await debug(w.base, 'seal', s.id)
  const [arc] = await readArchives(w.base, s.id, s.sk)
  assert.equal(arc.lines.length, 3, 'a, b (once, despite the duplicate), q')
  assert.ok(arc.raw.includes('"big":12345678901234567890'))
  assert.match(arc.raw.split('\n')[0], /^\{"received_at":"[^"]+","received_seq":"\d+","sender":"default","id":"a"/)
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

test('large records are stored whole: 900 KB survives sealing, 1.1 MB is refused with 413 and nothing is cut', async () => {
  const s = await newProject(w.base, name('big'))
  const pad = (n: number, tail: string) => ({ data: { blob: 'x'.repeat(n) + tail } })
  const small = await post(w.base, s.pk, evt('a'))
  assert.equal(small.status, 200)
  const big = await post(w.base, s.pk, evt('b', pad(900_000, 'END-OF-BLOB')))
  assert.equal(big.status, 200)
  const two = await post(w.base, s.pk, [evt('c', pad(700_000, 'C-END')), evt('d', pad(700_000, 'D-END'))].join('\n'))
  assert.equal(two.status, 200, 'two large records in one request pack into separate rows')
  const refused = await post(w.base, s.pk, [evt('e'), evt('f', pad(1_100_000, 'F-END'))].join('\n'))
  assert.equal(refused.status, 413)
  assert.match(((await refused.json()) as any).error, /line 2: record exceeds 1 MiB/)
  await debug(w.base, 'seal', s.id)
  const lines = (await readArchives(w.base, s.id, s.sk)).flatMap(a => a.lines)
  assert.deepEqual(lines.map(l => l.id).sort(), ['a', 'b', 'c', 'd'], 'the refused batch stored nothing')
  const stored = new Map(lines.map(l => [l.id, l]))
  assert.ok(stored.get('b').data.blob.endsWith('END-OF-BLOB') && stored.get('b').data.blob.length === 900_000 + 'END-OF-BLOB'.length)
  assert.ok(stored.get('c').data.blob.endsWith('C-END') && stored.get('d').data.blob.endsWith('D-END'))
})

test('geo enrichment from request.cf only, when the project opts in', async () => {
  const on = await newProject(w.base, name('geo'), true), off = await newProject(w.base, name('nogeo'), false)
  const rec = (id: string, ctx?: object) => '{"id":"' + id + '","type":"track","event":"v","timestamp":"2026-11-06T00:00:00Z","data":{"wide":9007199254740993123456789}' + (ctx ? ',"context":' + JSON.stringify(ctx) : '') + '}'
  const forged = { 'X-Slurp-Geo-Country': 'ZZ', 'X-Slurp-Ingress-Secret': 'x', 'CF-IPCountry': 'ZZ' }
  assert.equal((await post(w.base, on.pk, rec('g1') + '\n' + rec('g2', { app: { version: '1' } }), forged)).status, 200)
  assert.equal((await post(w.base, off.pk, rec('n1'), forged)).status, 200)
  await debug(w.base, 'seal', on.id); await debug(w.base, 'seal', off.id)
  const [a] = await readArchives(w.base, on.id, on.sk), [b] = await readArchives(w.base, off.id, off.sk)
  for (const l of a.lines) {
    assert.equal(l.context.geo.provider, 'cloudflare'); assert.equal(l.context.geo.basis, 'request_ip')
    assert.notEqual(l.context.geo.country, 'ZZ', 'client supplied geo headers are ignored')
  }
  assert.equal(a.lines[1].context.app.version, '1', 'existing context preserved')
  assert.ok(a.raw.includes('9007199254740993123456789'), 'wide number survives enrichment')
  assert.equal(b.lines[0].context, undefined)
})

test('seal -> manifest -> Archive.ListObjects -> signed download, checkpoint and auth', async () => {
  const s = await newProject(w.base, name('arc'))
  for (let i = 0; i < 3; i++) { await post(w.base, s.pk, evt(`e${i}`)); await debug(w.base, 'seal', s.id) }
  const list = await w.clients.archive.listObjects({ project: s.id }, { Authorization: `Bearer ${s.sk}` })
  assert.deepEqual(list.objects.map(o => o.seq), ['1', '2', '3'])
  assert.equal(list.coverage?.firstRetained, '1'); assert.equal(list.coverage?.latestPublished, '3'); assert.ok(list.expiresAt)
  for (const o of list.objects) {
    assert.match(o.name, /^\d{20}-[0-9a-f]{64}\.jsonl\.gz$/)
    const bytes = Buffer.from(await (await fetch(o.url)).arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), o.sha256); assert.equal(bytes.length, o.size)
    assert.equal((await fetch(o.url.replace(/sig=.{4}/, 'sig=0000'))).status, 403)
  }
  // One expiry for the whole listing: every URL carries it, and it is the one reported.
  const exps = new Set(list.objects.map(o => new URL(o.url).searchParams.get('exp')))
  assert.equal(exps.size, 1); assert.equal(new Date(Number([...exps][0]) * 1000).toISOString(), new Date(list.expiresAt!).toISOString())
  const page = await w.clients.archive.listObjects({ project: s.id, limit: 2 }, { Authorization: `Bearer ${s.sk}` })
  assert.equal(page.objects.length, 2); assert.equal(page.nextAfter, '2')
  assert.deepEqual((await w.clients.archive.listObjects({ project: s.id, after: '2' }, admin)).objects.map(o => o.seq), ['3'])
  assert.equal((await w.clients.archive.listObjects({ project: s.id, after: '3' }, admin)).objects.length, 0)
  const cov = await w.clients.archive.getCoverage({ project: s.id }, admin)
  assert.equal(cov.coverage?.latestPublished, '3'); assert.equal(cov.publication?.state, 'idle')
  await assert.rejects(w.clients.archive.listObjects({ project: s.id }, { Authorization: `Bearer ${s.pk}` }), ForbiddenError)
  const other = await newProject(w.base, name('other'))
  await assert.rejects(w.clients.archive.listObjects({ project: s.id }, { Authorization: `Bearer ${other.sk}` }), ForbiddenError)
  await assert.rejects(w.clients.archive.listObjects({ project: s.id }), UnauthenticatedError)
  await assert.rejects(w.clients.archive.listObjects({ project: s.id, after: 'x' }, admin), InvalidArgumentError)
  assert.equal((await w.clients.archive.listObjects({ project: (await newProject(w.base, name('empty'))).id }, admin)).objects.length, 0)
})

test('group commit: concurrent requests share rows, every event lands exactly once', async () => {
  const s = await newProject(w.base, name('gc'))
  const before = (await stats(w.base, s.id)).rows
  const res = await Promise.all(Array.from({ length: 60 }, (_, i) => post(w.base, s.pk, Array.from({ length: 20 }, (_, k) => evt(`c${i}-${k}`)).join('\n'))))
  assert.deepEqual([...new Set(res.map(r => r.status))], [200])
  await debug(w.base, 'seal', s.id)
  // A short real alarm may seal part of the batch first, so read every archive.
  const lines = (await readArchives(w.base, s.id, s.sk)).flatMap(a => a.lines)
  assert.equal(lines.length, 1200); assert.equal(new Set(lines.map(l => l.id)).size, 1200)
  assert.equal(new Set(lines.map(l => l.received_seq)).size, 1200, 'received_seq is unique across archives')
  const st = await stats(w.base, s.id)
  const perRequest = (st.rows - before) / 60
  console.log(`rows written per request (60 concurrent, 20 events each, incl. seal): ${perRequest.toFixed(3)}`)
  assert.ok(perRequest < 1, 'group commit coalesces concurrent requests')
})
