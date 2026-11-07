import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { AlreadyExistsError, ForbiddenError, InvalidArgumentError, NotFoundError, RetentionGapError, UnauthenticatedError, UnavailableError } from '../src/slurp.gen.ts'
import { admin, debug, evt, newSource, post, readArchives, rpc, startWorker, stats, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`

test('health and auth gates (generated clients)', async () => {
  assert.equal((await w.clients.health.version({})).schema, 'v0.5.0')
  const h = await (await fetch(`${w.base}/v1/health`)).json() as any
  assert.equal(h.configured, true); assert.equal(h.capabilities.archive, 'jsonl.gz')
  await assert.rejects(w.clients.source.listSources({}), UnauthenticatedError)
  await assert.rejects(w.clients.source.listSources({}, { Authorization: 'Bearer wrong' }), UnauthenticatedError)
  await assert.rejects(w.clients.source.createSource({ name: name('x'), requestId: 'r' }, { Authorization: 'Bearer slurp_pk_nope' }), UnauthenticatedError)
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

test('source and key control plane', async () => {
  const n = name('cp')
  const created = await w.clients.source.createSource({ name: n, requestId: crypto.randomUUID() }, admin)
  assert.match(created.publishableKey, /^slurp_pk_/); assert.equal(created.ingestUrl, `${w.base}/v1/events`)
  await assert.rejects(w.clients.source.createSource({ name: n, requestId: crypto.randomUUID() }, admin), AlreadyExistsError)
  for (const bad of ['Bad Name', 'dash-name', '1abc', 'a__b', 'src_x', 'session_x', 'select', '_slurp', 'x'.repeat(64)])
    await assert.rejects(w.clients.source.createSource({ name: bad, requestId: crypto.randomUUID() }, admin), InvalidArgumentError, bad)
  await assert.rejects(w.clients.source.createSource({ name: name('rid'), requestId: 'not-a-uuid' }, admin), InvalidArgumentError)
  await assert.rejects(w.clients.source.createSource({ name: name('ttl'), title: 'x'.repeat(201), requestId: crypto.randomUUID() }, admin), InvalidArgumentError)
  assert.equal((await w.clients.source.createSource({ name: 'app_my_saas', requestId: crypto.randomUUID() }, admin)).source.name, 'app_my_saas', 'CLI-generated alias is accepted')
  const k = await w.clients.source.createKey({ source: n, scope: 'secret', name: 'cli' }, admin)
  assert.match(k.key, /^slurp_sk_/)
  await assert.rejects(w.clients.source.createKey({ source: n, scope: 'root' }, admin), InvalidArgumentError)
  assert.equal((await w.clients.source.listKeys({ source: created.source.id }, admin)).keys.length, 2)
  assert.equal((await w.clients.source.getSource({ source: n }, admin)).source.id, created.source.id)
  await assert.rejects(w.clients.source.getSource({ source: 'nope' }, admin), NotFoundError)
  assert.equal((await w.clients.source.updateSource({ source: n, title: 'T' }, admin)).source.title, 'T')
  // key-scoped callers cannot use the control plane
  await assert.rejects(w.clients.source.listSources({}, { Authorization: `Bearer ${k.key}` }), ForbiddenError)
  // memberships and hosted-only services answer cleanly
  assert.deepEqual((await w.clients.source.listMemberships({ source: n }, admin)).memberships, [])
  await assert.rejects(w.clients.source.addMember({ source: n, userId: 'u' }, admin), ForbiddenError)
  assert.equal((await w.clients.health.version({})).server, 'slurp-worker')
  const billing = await rpc(w.base, 'Billing', 'GetStatus', {})
  assert.equal(billing.status, 503); assert.match(billing.cause, /self-hosted/)
})

test('requestId retry rotates only that create\'s key; revoked keys stop working', async () => {
  const rid = crypto.randomUUID(), n = name('retry')
  const a = await w.clients.source.createSource({ name: n, requestId: rid }, admin)
  const b = await w.clients.source.createSource({ name: n, requestId: rid }, admin)
  assert.equal(a.source.id, b.source.id); assert.notEqual(a.publishableKey, b.publishableKey)
  assert.equal((await post(w.base, a.publishableKey, evt('x1'))).status, 401)
  assert.equal((await post(w.base, b.publishableKey, evt('x1'))).status, 200)
  const keys = (await w.clients.source.listKeys({ source: a.source.id }, admin)).keys
  const live = keys.find(k => !k.revokedAt)!
  await w.clients.source.revokeKey({ source: a.source.id, keyId: live.keyId }, admin)
  await assert.rejects(w.clients.source.revokeKey({ source: a.source.id, keyId: 'ffffffffffffffff' }, admin), NotFoundError)
  assert.equal((await post(w.base, b.publishableKey, evt('x2'))).status, 401, 'revoked key stops working (cache window is 5s but revokeKey clears it)')
})

test('ingest rules, CORS, dedupe, wide numbers', async () => {
  const s = await newSource(w.base, name('ing'))
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
  assert.match(arc.raw.split('\n')[0], /^\{"received_at":"[^"]+","received_seq":"\d+","id":"a"/)
})

test('large records are stored whole: 900 KB survives sealing, 1.1 MB is refused with 413 and nothing is cut', async () => {
  const s = await newSource(w.base, name('big'))
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

test('geo enrichment from request.cf only, when the source opts in', async () => {
  const on = await newSource(w.base, name('geo'), true), off = await newSource(w.base, name('nogeo'), false)
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
  const s = await newSource(w.base, name('arc'))
  for (let i = 0; i < 3; i++) { await post(w.base, s.pk, evt(`e${i}`)); await debug(w.base, 'seal', s.id) }
  const list = await w.clients.archive.listObjects({ source: s.id }, { Authorization: `Bearer ${s.sk}` })
  assert.deepEqual(list.objects.map(o => o.seq), ['1', '2', '3'])
  assert.equal(list.coverage?.firstRetained, '1'); assert.equal(list.coverage?.latestPublished, '3'); assert.ok(list.expiresAt)
  for (const o of list.objects) {
    assert.match(o.name, /^\d{20}-[0-9a-f]{64}\.jsonl\.gz$/)
    const bytes = Buffer.from(await (await fetch(o.url)).arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), o.sha256); assert.equal(bytes.length, o.size)
    assert.equal((await fetch(o.url.replace(/sig=.{4}/, 'sig=0000'))).status, 403)
  }
  const page = await w.clients.archive.listObjects({ source: s.id, limit: 2 }, { Authorization: `Bearer ${s.sk}` })
  assert.equal(page.objects.length, 2); assert.equal(page.nextAfter, '2')
  assert.deepEqual((await w.clients.archive.listObjects({ source: s.id, after: '2' }, admin)).objects.map(o => o.seq), ['3'])
  assert.equal((await w.clients.archive.listObjects({ source: s.id, after: '3' }, admin)).objects.length, 0)
  const cov = await w.clients.archive.getCoverage({ source: s.id }, admin)
  assert.equal(cov.coverage?.latestPublished, '3'); assert.equal(cov.publication?.state, 'idle')
  await assert.rejects(w.clients.archive.listObjects({ source: s.id }, { Authorization: `Bearer ${s.pk}` }), ForbiddenError)
  const other = await newSource(w.base, name('other'))
  await assert.rejects(w.clients.archive.listObjects({ source: s.id }, { Authorization: `Bearer ${other.sk}` }), ForbiddenError)
  await assert.rejects(w.clients.archive.listObjects({ source: s.id }), UnauthenticatedError)
  await assert.rejects(w.clients.archive.listObjects({ source: s.id, after: 'x' }, admin), InvalidArgumentError)
  assert.equal((await w.clients.archive.listObjects({ source: (await newSource(w.base, name('empty'))).id }, admin)).objects.length, 0)
})

test('group commit: concurrent requests share rows, every event lands exactly once', async () => {
  const s = await newSource(w.base, name('gc'))
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
