import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Archive, Source, Health, UnauthenticatedError, ForbiddenError, NotFoundError, AlreadyExistsError, InvalidArgumentError } from '../src/slurp.gen.ts'

const base = process.env.BASE ?? 'http://localhost:8788'
const admin = { Authorization: 'Bearer spike-admin-token' }
const f = (i: any, init?: any) => fetch(i, init)
const source = new Source(base, f), archive = new Archive(base, f), health = new Health(base, f)
const evt = (id: string, extra: object = {}) => JSON.stringify({ id, type: 'track', event: 'signup', timestamp: '2026-11-06T00:00:00Z', data: { n: 1 }, ...extra })
const name = 'spike-' + Math.random().toString(16).slice(2, 8)
let src: string, pk: string, sk: string

test('health + auth gates', async () => {
  assert.equal((await health.version({})).schema, 'v0.5.0')
  await assert.rejects(source.listSources({}), UnauthenticatedError)
})

test('source + keys control plane via generated client', async () => {
  const created = await source.createSource({ name, requestId: crypto.randomUUID() }, admin)
  src = created.source.id; pk = created.publishableKey
  assert.match(pk, /^slurp_pk_/)
  assert.equal(created.ingestUrl, `${base}/v1/events`)
  const again = await source.createSource({ name, requestId: 'dup-' + name }, admin).catch(e => e)
  assert.ok(again instanceof AlreadyExistsError)
  await assert.rejects(source.createSource({ name: 'Bad Name', requestId: crypto.randomUUID() }, admin), InvalidArgumentError)
  const k = await source.createKey({ source: name, scope: 'secret', name: 'cli' }, admin)
  sk = k.key; assert.match(sk, /^slurp_sk_/)
  assert.equal((await source.listKeys({ source: src }, admin)).keys.length, 2)
  assert.equal((await source.getSource({ source: name }, admin)).source.id, src)
  await assert.rejects(source.getSource({ source: 'nope' }, admin), NotFoundError)
  const upd = await source.updateSource({ source: src, title: 'Spike' }, admin)
  assert.equal(upd.source.title, 'Spike')
})

test('requestId retry rotates only that create\'s key', async () => {
  const rid = crypto.randomUUID(), n = 'retry-' + Math.random().toString(16).slice(2, 8)
  const a = await source.createSource({ name: n, requestId: rid }, admin)
  const b = await source.createSource({ name: n, requestId: rid }, admin)
  assert.equal(a.source.id, b.source.id); assert.notEqual(a.publishableKey, b.publishableKey)
  const r1 = await fetch(`${base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${a.publishableKey}` }, body: evt('x1') })
  assert.equal(r1.status, 401)
})

const post = (body: string, key = pk) => fetch(`${base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body })

test('ingest: validation, dedupe, wide numbers', async () => {
  const wide = '{"id":"b","type":"track","event":"signup","timestamp":"2026-11-06T00:00:00Z","data":{"big":12345678901234567890}}'
  assert.equal((await post(evt('a') + '\n' + wide)).status, 200)
  const dup = await (await post(evt('a') + '\n' + wide)).json() as any
  assert.equal(dup.duplicate, true)
  assert.equal((await post(evt('c', { received_at: 'x' }))).status, 400)
  assert.equal((await post(evt('c', { context: { geo: {} } }))).status, 400)
  assert.equal((await post('{"id":"z","type":"track","timestamp":"2026-11-06T00:00:00Z","data":{}}')).status, 400) // no event
  assert.equal((await post(evt('d'), 'slurp_pk_wrong')).status, 401)
  assert.equal((await post(evt('d'), sk)).status, 403)
  assert.equal((await fetch(`${base}/v1/events?key=${pk}`, { method: 'POST', body: evt('q') })).status, 200)
  assert.equal((await post('x'.repeat(2 * 1024 * 1024))).status, 413)
})

test('seal -> manifest -> Archive.ListObjects -> signed download', async () => {
  const sealed = await (await fetch(`${base}/__debug/seal/${src}`, { headers: admin })).json() as any
  assert.equal(sealed.seq, 1); assert.match(sealed.name, /^0{19}1-[0-9a-f]{64}\.jsonl\.gz$/)
  const list = await archive.listObjects({ source: src }, { Authorization: `Bearer ${sk}` })
  assert.equal(list.objects.length, 1); assert.equal(list.coverage?.firstRetained, '1')
  const o = list.objects[0]
  const bytes = Buffer.from(await (await fetch(o.url)).arrayBuffer())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), o.sha256); assert.equal(bytes.length, o.size)
  const lines = gunzipSync(bytes).toString().trim().split('\n')
  assert.equal(lines.length, 3) // a, b, q
  assert.match(lines[0], /^\{"received_at":"[^"]+","received_seq":"\d+","id":"a"/)
  assert.ok(lines[1].includes('"big":12345678901234567890'), 'wide number preserved byte-for-byte')
  for (const l of lines) JSON.parse(l)
  assert.equal((await fetch(o.url.replace(/sig=.{4}/, 'sig=0000'))).status, 403)
  // resume after checkpoint = empty
  assert.equal((await archive.listObjects({ source: src, after: '1' }, { Authorization: `Bearer ${sk}` })).objects.length, 0)
  await assert.rejects(archive.listObjects({ source: src }, { Authorization: `Bearer ${pk}` }), ForbiddenError)
  await assert.rejects(archive.listObjects({ source: src }), UnauthenticatedError)
})
