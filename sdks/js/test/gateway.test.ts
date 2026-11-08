// The SDK against the real Worker (docs/contracts.md): delivery through a fault-injecting proxy, then the archives read back.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'
import { call } from '../../../backend/src/client.ts'
import { ADMIN_TOKEN, startWorker, type Worker } from '../../../backend/test/harness.ts'
import { createClient, memoryStorage, version } from '../src/index.ts'
import type { SlurpClient } from '../src/index.ts'
import { fileStorage } from '../src/node.ts'

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 10_000) {
  const deadline = performance.now() + timeout
  while (!(await check())) {
    assert.ok(performance.now() < deadline, message)
    await delay(10)
  }
}

test('durable delivery, backpressure, splitting and permanent auth failure leave every event in the archive', { timeout: 180_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'slurp-sdk-'))
  let worker: Worker | undefined
  let proxy: Server | undefined
  const clients: SlurpClient[] = []
  t.after(async () => {
    try {
      for (const client of clients) await client.close()
      if (proxy) await new Promise<void>((resolve, reject) => {
        proxy!.close(error => error ? reject(error) : resolve())
        proxy!.closeAllConnections()
      })
    } finally {
      await worker?.stop()
      await rm(scratch, { recursive: true, force: true })
    }
  })
  const maxBody = 1800
  // The real Worker under wrangler dev (set BASE to use a running or deployed one; it must allow a 1800 byte body limit).
  worker = await startWorker({ MAX_BODY_BYTES: String(maxBody), GROUP_COMMIT_MS: '20' })
  const publicUrl = worker.base
  const project = await call(publicUrl, ADMIN_TOKEN, 'CreateProject', { name: 'sdk_delivery' })
  const secret = { key: (await call(publicUrl, ADMIN_TOKEN, 'CreateKey', { project: project.project.id, scope: 'secret' })).key.key! }
  const records: {
    method: string | undefined; body: Buffer; at: number; forwarded: boolean
    status: number; headers: Record<string, string>; authorization: string | undefined; contentType: string | undefined; queryKey: boolean
  }[] = []
  let fault: 'lost' | 'busy' | 'date' | 'bad' | undefined
  let dateDeadline = 0
  const proxyErrors: unknown[] = []
  proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const action = fault
      fault = undefined
      const record = {
        method: request.method, body, at: performance.now(), forwarded: false, status: 0,
        headers: {} as Record<string, string>, authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        queryKey: new URL(request.url!, publicUrl).searchParams.has('key'),
      }
      records.push(record)
      if (action === 'busy' || action === 'date' || action === 'bad') {
        record.status = action === 'bad' ? 400 : action === 'busy' ? 503 : 429
        if (action === 'busy') record.headers['retry-after'] = '1'
        if (action === 'date') {
          dateDeadline = Math.ceil((Date.now() + 1200) / 1000) * 1000
          record.headers['retry-after'] = new Date(dateDeadline).toUTCString()
        }
        response.writeHead(record.status, record.headers).end()
        return
      }
      record.forwarded = true
      const upstream = await fetch(new URL(request.url!, publicUrl), {
        method: request.method, body, headers: {
          ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}),
          'Content-Type': request.headers['content-type']!,
        },
      })
      record.status = upstream.status
      record.headers = Object.fromEntries(upstream.headers)
      const result = Buffer.from(await upstream.arrayBuffer())
      if (action === 'lost') response.destroy()
      else response.writeHead(record.status, record.headers).end(result)
    } catch (error) { proxyErrors.push(error); response.destroy() }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/v1/events`
  const defaults = { key: project.publishableKey, endpoint, flushAt: 100, flushIntervalMs: 60_000 }
  const make = (options = {}) => { const client = createClient({ ...defaults, ...options }); clients.push(client); return client }
  const delivered: string[] = []
  const errors: { message: string; dropped: number }[] = []
  const onError = (error: Error, dropped: number) => { errors.push({ message: error.message, dropped }) }
  const drain = (client: SlurpClient) => until(async () => { await client.flush(); return client.pending === 0 }, 'SDK did not drain')
  const publish = async (previous = 0) => {
    // The alarm interval is long; publish on demand, as `slurp sync --now` does.
    const published = (await call(publicUrl, ADMIN_TOKEN, 'Publish', { project: project.project.id })).coverage.last ?? 0
    assert.ok(published > previous, 'nothing new was published')
    return published
  }

  const path = join(scratch, 'sdk.json')
  const storage = fileStorage(path)
  const first = make({ storage, onError })
  fault = 'lost'
  delivered.push(first.track('signed_up', { plan: 'pro', text: '雪\n"quoted"' }))
  delivered.push(first.identify('user-42', { plan: 'pro' }))
  delivered.push(first.track('order_completed', { total: 49 }))
  await first.flush()
  assert.equal(first.pending, 3)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 200)
  const persisted = JSON.parse(await readFile(path, 'utf8'))
  const [, projectHex, source] = /^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_[0-9a-f]{48}$/.exec(project.publishableKey)!
  const saved = JSON.parse(persisted[`@hitslop/slurp-sdk:v1:${endpoint}:${projectHex}:${source}`])
  assert.deepEqual(saved.queue, records[0].body.toString().trimEnd().split('\n'), 'the unacknowledged lines are what is saved')
  assert.equal(saved.batches, undefined)
  await first.close()
  const restarted = make({ storage: fileStorage(path), onError })
  await drain(restarted)
  assert.equal(records.length, 2)
  assert.deepEqual(records[1].body, records[0].body, 'the restart resends the same records')
  assert.equal(restarted.pending, 0)
  assert.deepEqual(errors.map(error => error.dropped), [0])
  const initial = records[0].body.toString().trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(initial[0].user_id, undefined)
  assert.equal(initial[1].user_id, 'user-42')
  assert.equal(initial[0].anonymous_id, initial[1].anonymous_id)
  assert.equal(initial[0].session_id, initial[1].session_id)
  t.diagnostic('lost ACK replay: the same records are sent again; the import dedupes by (source, id)')
  const firstPublished = await publish()

  let start = records.length
  fault = 'busy'
  delivered.push(restarted.track('after_restart', { number: 3 }))
  await restarted.flush()
  assert.equal(records.length, start + 1)
  assert.equal(records[start].status, 503)
  await restarted.flush()
  assert.equal(records.length, start + 1)
  await drain(restarted)
  assert.equal(records.length, start + 2)
  assert.deepEqual(records[start].body, records[start + 1].body)
  assert.ok(records[start + 1].at - records[start].at >= 950)
  const resumed = JSON.parse(records[start + 1].body.toString())
  assert.equal(resumed.user_id, 'user-42')
  assert.equal(resumed.anonymous_id, initial[0].anonymous_id)
  assert.equal(resumed.session_id, initial[0].session_id)
  t.diagnostic(`Retry-After: 1 elapsed ${(records[start + 1].at - records[start].at).toFixed(1)} ms`)

  start = records.length
  fault = 'date'
  delivered.push(restarted.track('dated_retry', { accepted: true }))
  await restarted.flush()
  const remaining = dateDeadline - Date.now()
  const received = performance.now()
  await drain(restarted)
  assert.equal(records.length, start + 2)
  assert.deepEqual(records[start].body, records[start + 1].body)
  assert.ok(records[start + 1].at - received >= remaining - 50)

  start = records.length
  for (let index = 0; index < 6; index++) delivered.push(restarted.track('large_batch', { index, pad: 'x'.repeat(700) }))
  await drain(restarted)
  const split = records.slice(start)
  assert.equal(split[0].status, 413)
  assert.ok(split[0].body.byteLength > maxBody)
  const originalLines = split[0].body.toString().trimEnd().split('\n')
  const accepted = split.filter(record => record.status === 200)
  assert.ok(accepted.length >= 3, 'a 413 halves the request until it fits')
  assert.deepEqual(accepted.flatMap(record => record.body.toString().trimEnd().split('\n')), originalLines)
  assert.ok(accepted.every(record => record.body.byteLength <= maxBody))
  t.diagnostic(`real gateway 413: ${split.filter(record => record.status === 413).length} splits, 6 singleton ACKs`)

  console.log('[sdk gateway] phase: unauthorized key')
  start = records.length
  const drops: number[] = []
  const unauthorized = make({ key: `slurp_pk_${'0'.repeat(64)}`, storage, onError: (_error: Error, dropped: number) => drops.push(dropped) })
  unauthorized.track('rejected_one')
  unauthorized.track('rejected_two')
  await unauthorized.flush()
  assert.equal(records.length, start + 1)
  assert.equal(records[start].status, 401)
  assert.equal(unauthorized.pending, 0)
  unauthorized.track('after_401')
  await unauthorized.flush()
  await unauthorized.flush()
  assert.equal(records.length, start + 1)
  assert.deepEqual(drops, [2, 1])
  console.log('[sdk gateway] phase: read key cannot write')
  const forbiddenDrops: number[] = []
  const forbidden = make({ key: secret.key, onError: (_error: Error, dropped: number) => forbiddenDrops.push(dropped) })
  forbidden.track('read_key_cannot_write')
  await forbidden.flush()
  assert.equal(records.at(-1)!.status, 403)
  const stoppedAt = records.length
  forbidden.track('after_403')
  await forbidden.flush()
  assert.equal(records.length, stoppedAt)
  assert.deepEqual(forbiddenDrops, [1, 1])

  console.log('[sdk gateway] phase: queue limits and invalid events')
  const rejected: number[] = []
  const limited = make({ maxQueue: 2, onError: (_error: Error, dropped: number) => rejected.push(dropped) })
  limited.track('oldest_evicted')
  delivered.push(limited.track('kept_one', { exact: 1 }), limited.track('kept_two', { exact: 2 }))
  assert.equal(limited.pending, 2)
  await drain(limited)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  const rejectedAt = records.length
  for (const [event, props] of [
    ['', {}], ['a'.repeat(201), {}], ['invalid', { number: NaN }], ['invalid', cyclic],
    ['invalid', { date: new Date() }], ['invalid', { value: undefined }], ['oversized', { pad: 'x'.repeat(1024 * 1024 + 1024) }],
  ] as [string, Record<string, unknown>][]) limited.track(event, props)
  await limited.flush()
  assert.equal(records.length, rejectedAt)
  assert.deepEqual(rejected, Array(8).fill(1))
  console.log('[sdk gateway] phase: single line over the body limit')
  limited.track('single_line_413', { pad: 'x'.repeat(maxBody) })
  await limited.flush()
  assert.equal(records.at(-1)!.status, 413)
  assert.deepEqual(rejected, Array(9).fill(1))
  fault = 'bad'
  limited.track('bad_batch_one')
  limited.track('bad_batch_two')
  await limited.flush()
  assert.equal(records.at(-1)!.status, 400)
  assert.deepEqual(rejected, [...Array(9).fill(1), 2])
  delivered.push(limited.track('after_bad_batch', { recovered: true }))
  await drain(limited)

  const memory = memoryStorage()
  const failWrites = true
  const storageErrors: number[] = []
  const durable = make({ storage: {
    getItem: memory.getItem,
    removeItem: memory.removeItem,
    setItem(key: string, value: string) {
      if (failWrites) throw new Error('storage unavailable')
      return memory.setItem(key, value)
    },
  }, onError: (_error: Error, dropped: number) => storageErrors.push(dropped) })
  start = records.length
  delivered.push(durable.track('after_storage_recovers', { retained: true }))
  await durable.flush()
  assert.equal(records.length, start + 1, 'a failing save does not stop delivery')
  assert.equal(durable.pending, 0)
  assert.deepEqual(storageErrors, [0], 'and is reported once')

  const realNow = Date.now
  try {
    Date.now = () => realNow() + 30 * 60 * 1000 + 1
    delivered.push(restarted.track('after_inactivity', { session: 'new' }))
  } finally { Date.now = realNow }
  await drain(restarted)
  const inactive = JSON.parse(records.at(-1)!.body.toString())
  assert.equal(inactive.anonymous_id, initial[0].anonymous_id)
  assert.equal(inactive.user_id, 'user-42')
  assert.notEqual(inactive.session_id, initial[0].session_id)

  restarted.reset()
  const resetId = restarted.track('after_reset', { anonymous: true })
  delivered.push(resetId)
  await drain(restarted)
  const resetEvent = JSON.parse(records.at(-1)!.body.toString())
  assert.equal(resetEvent.user_id, undefined)
  assert.notEqual(resetEvent.anonymous_id, initial[0].anonymous_id)
  assert.notEqual(resetEvent.session_id, initial[0].session_id)

  const descriptors = Object.fromEntries(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const window = Object.assign(new EventTarget(), { location: { href: 'https://example.test/pricing?plan=pro', pathname: '/pricing' }, localStorage: memoryStorage() })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', referrer: 'https://example.test/', title: 'Pricing' })
  const keepalive: boolean[] = []
  let browser!: SlurpClient
  try {
    for (const [key, value] of Object.entries({ window, document, navigator: { userAgent: 'SDK browser fixture', language: 'en-CA' } })) {
      Object.defineProperty(globalThis, key, { value, configurable: true })
    }
    browser = make({ fetch: (input: RequestInfo | URL, init?: RequestInit) => { keepalive.push(!!init?.keepalive); return fetch(input, init) } })
    const browserId = browser.track('page viewed', { path: '/pricing' })
    delivered.push(browserId)
    start = records.length
    window.dispatchEvent(new Event('pagehide'))
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await browser.flush()
    assert.equal(browser.pending, 0)
    assert.equal(records.length, start + 1)
    assert.deepEqual(keepalive, [true])
    assert.equal(records[start].queryKey, true)
    assert.equal(records[start].authorization, undefined)
    assert.equal(records[start].contentType, 'text/plain')
    assert.equal(records[start].status, 200)
    const replay = await fetch(project.ingestUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${project.publishableKey}`, 'Content-Type': 'application/x-ndjson' },
      body: records[start].body,
    })
    assert.equal(replay.status, 200)
    await replay.body?.cancel()
    const refused = await fetch(`${project.ingestUrl}?key=${encodeURIComponent(secret.key)}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: records[start].body,
    })
    assert.equal(refused.status, 401)
    await refused.body?.cancel()
    const browserEvent = JSON.parse(records[start].body.toString())
    assert.deepEqual(browserEvent.context, {
      library: { name: '@hitslop/slurp-sdk', version },
      page: { url: window.location.href, path: '/pricing', referrer: document.referrer, title: 'Pricing' },
      user_agent: 'SDK browser fixture', locale: 'en-CA', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  } finally {
    await browser?.close()
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }

  for (const record of records) {
    assert.equal(record.method, 'POST')
    assert.equal(record.contentType, record.queryKey ? 'text/plain' : 'application/x-ndjson')
    if (record.queryKey) assert.equal(record.authorization, undefined)
    else assert.ok(record.authorization?.startsWith('Bearer slurp_'))
    assert.equal(record.body.at(-1), 10)
    for (const line of record.body.toString().trimEnd().split('\n')) {
      const event = JSON.parse(line)
      assert.deepEqual(Object.keys(event), ['id', 'type', ...(event.type === 'track' ? ['event'] : []), 'timestamp', ...(event.user_id === undefined ? [] : ['user_id']), 'anonymous_id', 'session_id', 'data', 'context'])
    }
  }
  assert.deepEqual(proxyErrors, [])
  await publish(firstPublished)
  const archived: Record<string, any>[] = []
  let after: number | undefined
  let pages = 0
  do {
    const page = await call(publicUrl, secret.key, 'ListArchives', { project: project.project.id, after, limit: 1 })
    pages++
    for (const object of page.archives) {
      const response = await fetch(`${publicUrl}/v1/projects/${project.project.id}/archives/${object.seq}`, { headers: { Authorization: `Bearer ${secret.key}` } })
      assert.equal(response.status, 200)
      const compressed = Buffer.from(await response.arrayBuffer())
      assert.equal(compressed.byteLength, object.size)
      assert.equal(createHash('sha256').update(compressed).digest('hex'), object.sha256)
      const raw = gunzipSync(compressed).toString()
      assert.equal(raw.at(-1), '\n')
      archived.push(...raw.trimEnd().split('\n').map(line => JSON.parse(line)))
    }
    after = page.next
  } while (after)
  assert.equal(pages, 2)
  // The Worker stores every request as sent, so a replayed request (the lost response) is in the archive twice; the import dedupes by (source, id).
  assert.deepEqual([...new Set(archived.map(envelope => envelope.record.id))].sort(), [...delivered].sort())
  const wire = new Map(records.filter(record => record.forwarded && record.status === 200).flatMap(record =>
    record.body.toString().trimEnd().split('\n').map(line => { const event = JSON.parse(line); return [event.id, event] as const })))
  for (const { received_at, sender, record: event } of archived) {
    assert.equal(new Date(received_at).toISOString(), received_at)
    assert.equal(sender, 'default', 'the Worker stamps the source of the key that sent it')
    assert.deepEqual(event, wire.get(event.id))
    for (const id of [event.id, event.anonymous_id, event.session_id]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(Number.parseInt(event.id.replaceAll('-', '').slice(0, 12), 16), Date.parse(event.timestamp))
    assert.equal(new Date(event.timestamp).toISOString(), event.timestamp)
    assert.equal(event.type, event.event === undefined ? 'identify' : 'track')
    assert.equal(Object.getPrototypeOf(event.data), Object.prototype)
    if (!event.context.page) assert.deepEqual(event.context, { library: { name: '@hitslop/slurp-sdk', version }, runtime: { name: 'node', version: process.version } })
  }
  t.diagnostic(`archive: all ${delivered.length} delivered IDs present; every compressed object digest verified`)
})
