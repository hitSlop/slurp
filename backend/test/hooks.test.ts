import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { authorizationOk, githubSignatureOk, stripeSignatureOk } from '../src/compat/hooks.ts'
import { admin, debug, newProject, readArchives, rpc, startWorker, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`
const fixture = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/webhooks', file), 'utf8').trim()
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex')

// The signing vector from GitHub's own documentation, against the verification function.
test('GitHub\'s documented signature example verifies, and nothing else does', async () => {
  const secret = 'It\'s a Secret to Everybody', body = new TextEncoder().encode('Hello, World!')
  const good = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
  assert.equal(await githubSignatureOk(body, good, secret), true)
  assert.equal(await githubSignatureOk(body, good.replace(/.$/, '8'), secret), false)
  assert.equal(await githubSignatureOk(body, good.slice('sha256='.length), secret), false, 'the prefix is required')
  assert.equal(await githubSignatureOk(body, null, secret), false)
  assert.equal(await githubSignatureOk(new TextEncoder().encode('Hello, World?'), good, secret), false)
})

test('Stripe\'s scheme: the signature covers the timestamp, any listed v1 may match, and old timestamps are refused', async () => {
  const secret = 'whsec_test', body = new TextEncoder().encode('{"id":"evt_1"}'), now = 1_800_000_000_000
  const t = Math.floor(now / 1000), sig = hmac(secret, `${t}.{"id":"evt_1"}`)
  assert.equal(await stripeSignatureOk(body, `t=${t},v1=${sig}`, secret, now), true)
  assert.equal(await stripeSignatureOk(body, `t=${t},v1=${'0'.repeat(64)},v1=${sig}`, secret, now), true, 'during secret rotation Stripe sends several')
  assert.equal(await stripeSignatureOk(body, `t=${t},v1=${sig},v0=legacy`, secret, now), true, 'unknown schemes are ignored')
  assert.equal(await stripeSignatureOk(body, `t=${t + 1},v1=${sig}`, secret, now), false, 'a signature does not move to another timestamp')
  assert.equal(await stripeSignatureOk(body, `t=${t - 301},v1=${hmac(secret, `${t - 301}.{"id":"evt_1"}`)}`, secret, now), false, 'a replay outside five minutes')
  assert.equal(await stripeSignatureOk(body, `t=${t + 301},v1=${hmac(secret, `${t + 301}.{"id":"evt_1"}`)}`, secret, now), false, 'a timestamp from the future')
  assert.equal(await stripeSignatureOk(body, 'garbage', secret, now), false)
  assert.equal(await stripeSignatureOk(body, null, secret, now), false)
})

// Built at run time: a literal that looks like a Stripe secret trips secret scanners, and this is only a test value.
const STRIPE_SECRET = ['whsec', '0123456789abcdef'.repeat(2)].join('_')
async function setup(provider: string) {
  const p = await newProject(w.base, name(`hook_${provider}`))
  // Stripe issues its own secret per endpoint, so it is given to Slurp; the others are derived.
  const hook = await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider, ...(provider === 'stripe' ? { secret: STRIPE_SECRET } : {}) }) as { url: string; secret: string; keyName: string }
  return { p, hook, url: hook.url }
}
const github = (body: string, secret: string, event: string, delivery: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
  'x-hub-signature-256': `sha256=${hmac(secret, body)}`, ...extra,
})
const stripe = (body: string, secret: string, t = Math.floor(Date.now() / 1000)) => ({ 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${hmac(secret, `${t}.${body}`)}` })
const stored = async (p: Awaited<ReturnType<typeof newProject>>) => { await debug(w.base, 'seal', p.id); return (await readArchives(w.base, p.id, p.sk)).flatMap(a => a.lines) }

test('GetWebhook is idempotent: one key named for the provider, the same URL and secret each time', async () => {
  const { p, hook } = await setup('github')
  assert.equal(hook.keyName, 'github')
  assert.match(hook.url, new RegExp(`^${w.base}/hooks/github\\?key=slurp_pk_${p.id.slice(4)}_[0-9a-f]{48}$`))
  assert.match(hook.secret, /^[0-9a-f]{64}$/)
  const again = await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'github' })
  assert.deepEqual(again, hook)
  const keys = (await rpc(w.base, 'Project', 'ListKeys', { project: p.id, scope: 'publishable' })).keys as any[]
  assert.equal(keys.filter(k => k.name === 'github').length, 1)
  assert.notEqual((await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'generic' })).secret, hook.secret, 'each provider has its own secret')
  assert.equal((await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'bitbucket' })).code, 2000, 'unknown providers are refused')
})

test('a signed GitHub release is stored whole, as the github sender, and a redelivery is not a second event', async () => {
  const { p, hook, url } = await setup('github')
  const body = fixture('github-release.json')
  const headers = github(body, hook.secret, 'release', 'f4b2c3d4-1111-2222-3333-444455556666')
  const first = await fetch(url, { method: 'POST', headers, body })
  assert.equal(first.status, 200, await first.clone().text())
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200, 'a redelivery is acknowledged')
  const lines = await stored(p)
  const releases = lines.filter(l => l.event === 'github.release.published')
  assert.equal(releases.length, 1, 'stored once')
  const [line] = releases
  assert.equal(line.sender, 'github')
  assert.equal(line.id, 'github:f4b2c3d4-1111-2222-3333-444455556666')
  assert.equal(line.timestamp, '2026-11-06T18:02:11.000Z', 'the time comes from the release, not from when GitHub called')
  assert.deepEqual(line.context.webhook, { provider: 'github', delivery: 'f4b2c3d4-1111-2222-3333-444455556666' })
  assert.equal(line.data.release.tag_name, 'v1.4.0')
  const raw = (await readArchives(w.base, p.id, p.sk))[0].raw
  assert.ok(raw.includes(`"data":${body}`), 'the payload is embedded exactly as sent')
  assert.ok(raw.includes('12345678901234567890'), 'a number beyond double precision survives')
})

test('GitHub: missing and wrong signatures, ping, and a body that is not JSON are refused or ignored', async () => {
  const { p, hook, url } = await setup('github')
  const body = fixture('github-workflow-run.json')
  const good = github(body, hook.secret, 'workflow_run', 'd1')
  assert.equal((await fetch(url, { method: 'POST', headers: { ...good, 'x-hub-signature-256': '' }, body })).status, 401, 'no signature')
  assert.equal((await fetch(url, { method: 'POST', headers: github(body, 'the-wrong-secret', 'workflow_run', 'd1'), body })).status, 401, 'wrong secret')
  assert.equal((await fetch(url, { method: 'POST', headers: good, body: body.replace('failure', 'success') })).status, 401, 'body changed after signing')
  const ping = '{"zen":"Keep it logically awesome.","hook_id":1}'
  const pinged = await fetch(url, { method: 'POST', headers: github(ping, hook.secret, 'ping', 'd2'), body: ping })
  assert.equal(pinged.status, 200); assert.equal(((await pinged.json()) as any).ignored, 'ping')
  const text = 'not json at all'
  assert.equal((await fetch(url, { method: 'POST', headers: github(text, hook.secret, 'push', 'd3'), body: text })).status, 400)
  const form = 'payload=%7B%7D'
  const formResponse = await fetch(url, { method: 'POST', headers: github(form, hook.secret, 'push', 'd4', { 'content-type': 'application/x-www-form-urlencoded' }), body: form })
  assert.equal(formResponse.status, 400); assert.match(((await formResponse.json()) as any).error, /application\/json/)
  assert.equal((await fetch(url, { method: 'POST', headers: good, body })).status, 200)
  const lines = await stored(p)
  assert.deepEqual(lines.map(l => l.event), ['github.workflow_run.completed'], 'only the valid delivery was stored; the ping was not')
  assert.equal(lines[0].timestamp, '2026-11-06T18:14:30.000Z')
})

test('who may call the hook: only a publishable key in the query string, for that project\'s signature', async () => {
  const { p, hook, url } = await setup('github')
  const other = await setup('github')
  const body = fixture('github-release.json'), headers = github(body, hook.secret, 'release', 'k1')
  const withKey = (key: string | null) => url.replace(/key=[^&]+/, key === null ? '' : `key=${key}`)
  assert.equal((await fetch(withKey(null), { method: 'POST', headers, body })).status, 401, 'no key')
  assert.equal((await fetch(withKey(p.sk), { method: 'POST', headers, body })).status, 401, 'a secret key')
  assert.equal((await fetch(withKey('slurp_pk_nope'), { method: 'POST', headers, body })).status, 401, 'an unknown key')
  assert.equal((await fetch(`${w.base}/hooks/github?key=${new URL(url).searchParams.get('key')}`, { method: 'GET' })).status, 405)
  assert.equal((await fetch(`${w.base}/hooks/bitbucket?key=${new URL(url).searchParams.get('key')}`, { method: 'POST', body })).status, 404, 'an unknown provider')
  // This project's key with another project's secret is not authentic.
  assert.equal((await fetch(url, { method: 'POST', headers: github(body, other.hook.secret, 'release', 'k2'), body })).status, 401)
})

test('a signed Stripe event is stored as stripe.<type> with its own id and time; replays outside five minutes are refused', async () => {
  const { p, hook, url } = await setup('stripe')
  const body = fixture('stripe-invoice-paid.json')
  assert.equal((await fetch(url, { method: 'POST', headers: stripe(body, hook.secret), body })).status, 200)
  assert.equal((await fetch(url, { method: 'POST', headers: stripe(body, hook.secret, Math.floor(Date.now() / 1000) - 3600), body })).status, 401, 'a replay of an old delivery')
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401, 'no signature')
  const [line, ...rest] = await stored(p)
  assert.equal(rest.length, 0)
  assert.equal(line.event, 'stripe.invoice.paid'); assert.equal(line.id, 'evt_1QdXyz2eZvKYlo2C0AbCdEfG'); assert.equal(line.sender, 'stripe')
  assert.equal(line.timestamp, new Date(1793987531 * 1000).toISOString())
  assert.equal(line.data.data.object.amount_paid, 4900)
})

test('RevenueCat sends the pasted Authorization value; an event is stored as revenuecat.<type> once, however often it is retried', async () => {
  assert.equal(authorizationOk('s3cret', 's3cret'), true)
  assert.equal(authorizationOk('Bearer s3cret', 's3cret'), true, 'a Bearer prefix is tolerated')
  assert.equal(authorizationOk('s3cret!', 's3cret'), false); assert.equal(authorizationOk('', 's3cret'), false); assert.equal(authorizationOk(null, 's3cret'), false)

  const { p, hook, url } = await setup('revenuecat')
  assert.equal(hook.keyName, 'revenuecat')
  const body = fixture('revenuecat-initial-purchase.json')
  const post = (payload: string, authorization?: string, target = url) => fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: payload })
  assert.equal((await post(body)).status, 401, 'no Authorization header')
  assert.equal((await post(body, 'wrong')).status, 401)
  assert.equal((await post(body, hook.secret)).status, 200)
  assert.equal((await post(body, hook.secret)).status, 200, 'RevenueCat retries a delivery with the same event id')
  assert.equal((await post('{"api_version":"1.0","event":{"type":"RENEWAL"}}', hook.secret)).status, 400, 'no event id')
  assert.equal((await post('[]', hook.secret)).status, 400, 'not an object')
  assert.equal((await post(fixture('revenuecat-test.json'), hook.secret)).status, 200, 'the dashboard test event')
  // Another project's secret is not valid here, and an unknown key is refused.
  const other = await setup('revenuecat')
  assert.equal((await post(body, other.hook.secret)).status, 401)
  assert.equal((await post(body, hook.secret, url.replace(/key=[^&]+/, 'key=slurp_pk_0000000000000000_' + '0'.repeat(48)))).status, 401)

  const lines = await stored(p)
  assert.deepEqual(lines.map(l => l.event).sort(), ['revenuecat.initial_purchase', 'revenuecat.test'], 'the retry is one row')
  const purchase = lines.find(l => l.event === 'revenuecat.initial_purchase')!
  assert.equal(purchase.id, 'revenuecat:7a1f0d2e-5b3c-4c8a-9e61-2f4d8b0c1a37'); assert.equal(purchase.sender, 'revenuecat')
  assert.equal(purchase.timestamp, new Date(1793987531000).toISOString())
  assert.equal(purchase.data.event.price, 9.99); assert.equal(purchase.data.event.product_id, 'pro_monthly')

  // Rotating changes the secret the provider must send; the URL stays.
  const rotated = await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'revenuecat', rotate: true }) as { url: string; secret: string }
  assert.equal(rotated.url, url); assert.notEqual(rotated.secret, hook.secret)
  assert.equal((await post(body, hook.secret)).status, 401); assert.equal((await post(body, rotated.secret)).status, 200)
})

test('the generic receiver: unsigned by default, optionally signed, with the event named by the caller or the body', async () => {
  const { p, hook, url } = await setup('generic')
  const send = (body: string, headers: Record<string, string> = {}, query = '') => fetch(url + query, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  assert.equal((await send('{"type":"deploy.finished","env":"prod"}', { 'idempotency-key': 'deploy-17' })).status, 200)
  assert.equal((await send('{"hello":"world"}', {}, '&event=build.done')).status, 200)
  assert.equal((await send('[1,2,3]')).status, 200, 'an array is wrapped')
  assert.equal((await send('plain text, not JSON')).status, 200, 'text is kept as raw')
  const signed = '{"event":"signed.one"}'
  assert.equal((await send(signed, { 'x-slurp-signature': `sha256=${hmac(hook.secret, signed)}` })).status, 200)
  assert.equal((await send(signed, { 'x-slurp-signature': `sha256=${hmac('wrong', signed)}` })).status, 401, 'when a signature is sent it must be right')
  const lines = await stored(p)
  const byEvent = (event: string) => lines.find(l => l.event === event)
  assert.equal(byEvent('deploy.finished').id, 'generic:deploy-17'); assert.equal(byEvent('deploy.finished').data.env, 'prod')
  assert.ok(byEvent('build.done')); assert.ok(byEvent('signed.one'))
  assert.deepEqual(lines.find(l => l.data.items)!.data.items, [1, 2, 3])
  assert.equal(lines.find(l => l.data.raw)!.data.raw, 'plain text, not JSON')
  assert.ok(lines.filter(l => l.event === 'webhook').length === 2, 'no event name anywhere: it is called webhook')
  assert.ok(lines.every(l => l.sender === 'generic'))
})

// A provider redelivers a delivery with the same id; the record must come out identical or the importer calls it a conflict.
const producer = (line: any) => { const { received_at, received_seq, ...rest } = line; return rest }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
/** However many copies were stored (the Worker drops an identical retry it just saw; a later one is kept and the importer skips it), they are one record. */
const oneRecord = (lines: any[]) => lines.length >= 1 && new Set(lines.map(l => JSON.stringify(producer(l)))).size === 1

test('a delivery with no time of its own keeps the time it first arrived, however late it is redelivered', async () => {
  const { p, hook, url } = await setup('github')
  const body = '{"action":"started","repository":{"full_name":"acme/shop"}}' // a watch event: no timestamp anywhere in it
  const send = () => fetch(url, { method: 'POST', headers: github(body, hook.secret, 'watch', 'late-1'), body })
  assert.equal((await send()).status, 200)
  await pause(40)
  assert.equal((await send()).status, 200, 'GitHub redelivers the same delivery id')
  assert.ok(oneRecord((await stored(p)).filter(l => l.id === 'github:late-1')), 'the two copies are identical, so the importer treats them as one event')
  // A different delivery is a different event with its own, later time.
  await pause(40)
  assert.equal((await fetch(url, { method: 'POST', headers: github(body, hook.secret, 'watch', 'late-2'), body })).status, 200)
  const all = (await stored(p)).filter(l => l.event === 'github.watch.started')
  const first = all.find(l => l.id === 'github:late-1'), other = all.find(l => l.id === 'github:late-2')
  assert.ok(first && other); assert.ok(other.timestamp > first.timestamp)
})

test('a delivery first seen long ago keeps its time: nothing ages the record out', async () => {
  const { p, hook, url } = await setup('github')
  const ago = Date.now() - 8 * 86_400_000 // longer than any provider keeps redelivering, and longer than a week
  await fetch(`${w.base}/__debug/seed-hook/${p.id}?id=${encodeURIComponent('github:old-1')}&at=${ago}`, { headers: admin })
  await fetch(`${w.base}/__debug/alarm/${p.id}`, { headers: admin }) // the alarm runs housekeeping; it must not drop the record of a delivery
  const body = '{"action":"started","repository":{"full_name":"acme/shop"}}'
  assert.equal((await fetch(url, { method: 'POST', headers: github(body, hook.secret, 'watch', 'old-1'), body })).status, 200)
  const line = (await stored(p)).find(l => l.id === 'github:old-1')
  assert.equal(line.timestamp, new Date(ago).toISOString(), 'the redelivery carries the time of the first arrival, not today')
})

test('Stripe and RevenueCat deliveries without a time are stable on redelivery too', async () => {
  const stripeHook = await setup('stripe'), rc = await setup('revenuecat')
  const noTime = '{"id":"evt_notime","type":"ping.test"}'
  const rcBody = '{"event":{"id":"rc-notime","type":"TEST"}}'
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await fetch(stripeHook.url, { method: 'POST', headers: stripe(noTime, stripeHook.hook.secret), body: noTime })).status, 200)
    assert.equal((await fetch(rc.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: rc.hook.secret }, body: rcBody })).status, 200)
    await pause(40)
  }
  for (const project of [stripeHook.p, rc.p]) {
    const lines = await stored(project)
    assert.ok(oneRecord(lines), JSON.stringify(lines.map(producer)))
  }
})

test('the generic receiver: a caller\'s id or a body time make retries identical; a body with neither is its own event each time', async () => {
  const { p, url } = await setup('generic')
  const send = (body: string, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await send('{"type":"job.done"}', { 'idempotency-key': 'job-9' })).status, 200)
    assert.equal((await send('{"type":"tick","timestamp":"2026-11-06T10:00:00Z"}')).status, 200)
    assert.equal((await send('{"type":"heartbeat"}')).status, 200)
    await pause(40)
  }
  const lines = await stored(p)
  const of = (event: string) => lines.filter(l => l.event === event)
  assert.ok(oneRecord(of('job.done')), 'same caller id, same record')
  assert.ok(oneRecord(of('tick')), 'same body and time, same record')
  assert.equal(of('tick')[0].timestamp, '2026-11-06T10:00:00.000Z')
  assert.equal(of('heartbeat').length, 2); assert.notEqual(of('heartbeat')[0].id, of('heartbeat')[1].id, 'a repeat of a body with no id and no time is a new event')
})

test('a payload over 1 MiB is refused with 413, not truncated', async () => {
  const { hook, url } = await setup('github')
  const big = JSON.stringify({ action: 'created', filler: 'x'.repeat(1024 * 1024 + 10) })
  assert.equal((await fetch(url, { method: 'POST', headers: github(big, hook.secret, 'push', 'big1'), body: big })).status, 413)
})

test('rotating changes this project\'s secrets and no other project\'s', async () => {
  const a = await setup('github'), b = await setup('github')
  const body = fixture('github-release.json')
  assert.equal((await fetch(a.url, { method: 'POST', headers: github(body, a.hook.secret, 'release', 'r1'), body })).status, 200)
  const rotated = await rpc(w.base, 'Project', 'GetWebhook', { project: a.p.id, provider: 'github', rotate: true }) as typeof a.hook
  assert.notEqual(rotated.secret, a.hook.secret); assert.equal(rotated.url, a.url, 'the key does not change, only the secret')
  assert.equal((await fetch(a.url, { method: 'POST', headers: github(body, a.hook.secret, 'release', 'r2'), body })).status, 401, 'the old secret stops working')
  assert.equal((await fetch(a.url, { method: 'POST', headers: github(body, rotated.secret, 'release', 'r3'), body })).status, 200)
  assert.equal((await fetch(b.url, { method: 'POST', headers: github(body, b.hook.secret, 'release', 'r4'), body })).status, 200, 'another project is untouched')
  assert.equal((await rpc(w.base, 'Project', 'GetWebhook', { project: a.p.id, provider: 'github' }, admin)).secret, rotated.secret, 'and the new secret is stable')
})

test('Stripe: the secret Stripe issued is stored for the project, and until it is set the hook refuses everything', async () => {
  const p = await newProject(w.base, name('hook_stripe_setup'))
  const empty = await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'stripe' }) as { url: string; secret: string }
  assert.equal(empty.secret, '', 'nothing to show before Stripe has issued one')
  const body = fixture('stripe-invoice-paid.json')
  const refused = await fetch(empty.url, { method: 'POST', headers: stripe(body, STRIPE_SECRET), body })
  assert.equal(refused.status, 401); assert.match(((await refused.json()) as any).error, /--secret/)
  const set = await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'stripe', secret: STRIPE_SECRET }) as { secret: string }
  assert.equal(set.secret, STRIPE_SECRET)
  assert.equal((await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'stripe' })).secret, STRIPE_SECRET, 'and it is remembered')
  assert.equal((await fetch(empty.url, { method: 'POST', headers: stripe(body, STRIPE_SECRET), body })).status, 200)
  assert.equal((await fetch(empty.url, { method: 'POST', headers: stripe(body, 'whsec_someone_elses_secret_value_here'), body })).status, 401)
  // Only Stripe issues its own secret; asking to rotate it here makes no sense; a malformed secret is refused.
  assert.equal((await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'stripe', rotate: true })).code, 2000)
  assert.equal((await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'stripe', secret: 'not-a-stripe-secret' })).code, 2000)
  assert.equal((await rpc(w.base, 'Project', 'GetWebhook', { project: p.id, provider: 'github', secret: STRIPE_SECRET })).code, 2000)
})
