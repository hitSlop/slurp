import { abortAllDurableObjects } from 'cloudflare:test'
import { afterEach, test } from 'vitest'
import { authorizationOk, githubSignatureOk, providerNames, stripeSignatureOk } from '../../src/compat/providers.ts'
import { ADMIN_TOKEN, ApiError, BASE, archived, assert, call, envelopes, hmacHex as hmac, http, newProject } from './helpers.ts'
import githubRelease from '../../fixtures/webhooks/github-release.json?raw'
import githubReleasePretty from '../../fixtures/webhooks/github-release-pretty.json?raw'
import githubWorkflowRun from '../../fixtures/webhooks/github-workflow-run.json?raw'
import revenuecatPurchase from '../../fixtures/webhooks/revenuecat-initial-purchase.json?raw'
import revenuecatTest from '../../fixtures/webhooks/revenuecat-test.json?raw'
import stripeInvoicePaid from '../../fixtures/webhooks/stripe-invoice-paid.json?raw'

afterEach(abortAllDurableObjects)
const FIXTURES: Record<string, string> = {
  'github-release.json': githubRelease, 'github-release-pretty.json': githubReleasePretty, 'github-workflow-run.json': githubWorkflowRun,
  'revenuecat-initial-purchase.json': revenuecatPurchase, 'revenuecat-test.json': revenuecatTest, 'stripe-invoice-paid.json': stripeInvoicePaid,
}
const fixture = (file: string) => FIXTURES[file].trim()
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: ApiError) => e instanceof ApiError && e.code === code)

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
  const t = Math.floor(now / 1000), sig = await hmac(secret, `${t}.{"id":"evt_1"}`)
  assert.equal(await stripeSignatureOk(body, `t=${t},v1=${sig}`, secret, now), true)
  assert.equal(await stripeSignatureOk(body, `t=${t},v1=${'0'.repeat(64)},v1=${sig}`, secret, now), true, 'during secret rotation Stripe sends several')
  assert.equal(await stripeSignatureOk(body, `t=${t},v1=${sig},v0=legacy`, secret, now), true, 'unknown schemes are ignored')
  assert.equal(await stripeSignatureOk(body, `t=${t + 1},v1=${sig}`, secret, now), false, 'a signature does not move to another timestamp')
  assert.equal(await stripeSignatureOk(body, `t=${t - 301},v1=${await hmac(secret, `${t - 301}.{"id":"evt_1"}`)}`, secret, now), false, 'a replay outside five minutes')
  assert.equal(await stripeSignatureOk(body, `t=${t + 301},v1=${await hmac(secret, `${t + 301}.{"id":"evt_1"}`)}`, secret, now), false, 'a timestamp from the future')
  assert.equal(await stripeSignatureOk(body, 'garbage', secret, now), false)
  assert.equal(await stripeSignatureOk(body, null, secret, now), false)
})

// Built at run time: a literal that looks like a Stripe secret trips secret scanners, and this is only a test value.
const STRIPE_SECRET = ['whsec', '0123456789abcdef'.repeat(2)].join('_')
type Hook = { provider: string; url: string; secret: string; sender: string; steps: string[] }
const connect = (project: string, provider: string, secret?: string): Promise<Hook> =>
  call(ADMIN_TOKEN, 'ConnectWebhook', { project, provider, ...(secret !== undefined ? { secret } : {}) })
async function setup(provider: string) {
  const p = await newProject(`hook_${provider}`)
  // Stripe issues its own secret per endpoint, so it is given to Slurp; the others are generated.
  const hook = await connect(p.id, provider, provider === 'stripe' ? STRIPE_SECRET : undefined)
  return { p, hook, url: hook.url }
}
const github = async (body: string, secret: string, event: string, delivery: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
  'x-hub-signature-256': `sha256=${await hmac(secret, body)}`, ...extra,
})
const stripe = async (body: string, secret: string, t = Math.floor(Date.now() / 1000)) => ({ 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${await hmac(secret, `${t}.${body}`)}` })
const stored = async (p: Awaited<ReturnType<typeof newProject>>) => envelopes(await archived(p))
const rawOf = async (p: Awaited<ReturnType<typeof newProject>>) => (await archived(p)).map(a => a.raw).join('')
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

test('ConnectWebhook is idempotent: one key whose source is the provider, the same URL and secret each time, steps from the registry', async () => {
  const { p, hook } = await setup('github')
  assert.equal(hook.sender, 'github'); assert.equal(hook.provider, 'github')
  assert.match(hook.url, new RegExp(`^${BASE}/hooks/github\\?key=slurp_pk_${p.id.slice(4)}_github_[0-9a-f]{48}$`))
  assert.match(hook.secret, /^[0-9a-f]{64}$/)
  assert.ok(hook.steps.length >= 4 && hook.steps.some(s => /Settings > Webhooks/.test(s)) && /key revoke PROJECT KEY_ID/.test(hook.steps.at(-1)!), 'setup steps end with how to rotate')
  assert.deepEqual(await connect(p.id, 'github'), hook)
  const keys = (await call(ADMIN_TOKEN, 'ListKeys', { project: p.id, scope: 'publishable' })).keys
  assert.equal(keys.filter(k => k.source === 'github').length, 1)
  assert.notEqual((await connect(p.id, 'generic')).secret, hook.secret, 'each provider has its own secret')
  // the providers come from one registry, and an unknown one names them
  for (const provider of providerNames()) assert.ok((await connect(p.id, provider, provider === 'stripe' ? STRIPE_SECRET : undefined)).steps.length >= 3, provider)
  await assert.rejects(connect(p.id, 'bitbucket'), (e: ApiError) => e.code === 'invalid_argument' && e.message.includes('github, stripe, revenuecat or generic'))
})

test('a signed GitHub release is stored whole, as the github sender; a redelivery stores the same record again for the importer to skip', async () => {
  const { p, hook, url } = await setup('github')
  const body = fixture('github-release.json')
  const headers = await github(body, hook.secret, 'release', 'f4b2c3d4-1111-2222-3333-444455556666')
  const first = await http(url, { method: 'POST', headers, body })
  assert.equal(first.status, 200, await first.clone().text())
  assert.equal((await http(url, { method: 'POST', headers, body })).status, 200, 'a redelivery is acknowledged')
  const lines = (await stored(p)).filter(l => l.record.event === 'github.release.published')
  assert.equal(lines.length, 2, 'the Worker does not dedupe; the importer does, by (sender, id)')
  assert.equal(JSON.stringify(lines[0].record), JSON.stringify(lines[1].record), 'both copies are the same record, byte for byte')
  const [{ sender, record }] = lines
  assert.equal(sender, 'github')
  assert.equal(record.id, 'github:f4b2c3d4-1111-2222-3333-444455556666')
  assert.equal(record.timestamp, '2026-11-06T18:02:11.000Z', 'the time comes from the release, not from when GitHub called')
  assert.deepEqual(record.context.webhook, { provider: 'github', delivery: 'f4b2c3d4-1111-2222-3333-444455556666' })
  assert.equal(record.data.release.tag_name, 'v1.4.0')
  const raw = await rawOf(p)
  assert.ok(raw.includes(`"data":${body}`), 'the payload is embedded exactly as sent')
  assert.ok(raw.includes('12345678901234567890'), 'a number beyond double precision survives')
  assert.ok(!('geo' in lines[0]), 'the caller is the provider\'s server: no geo')
})

test('a pretty-printed payload is one archive line per delivery, and still the whole payload', async () => {
  const { p, hook, url } = await setup('github')
  const body = fixture('github-release-pretty.json')
  assert.ok(body.split('\n').length > 10, 'the fixture is multi-line')
  const headers = await github(body, hook.secret, 'release', 'aaaa0000-1111-2222-3333-444455556666')
  for (let i = 0; i < 2; i++) assert.equal((await http(url, { method: 'POST', headers, body })).status, 200)
  const raw = await rawOf(p)
  const lines = raw.split('\n').filter(l => l !== '')
  assert.equal(lines.length, 2, 'one line per delivery')
  assert.ok(raw.endsWith('\n') && !raw.includes('\r'))
  for (const l of lines) {
    const { record } = JSON.parse(l)
    assert.equal(record.data.release.tag_name, 'v1.4.0')
    assert.ok(l.includes('12345678901234567890'), 'a number beyond double precision survives')
  }
})

test('GitHub: missing and wrong signatures, ping, and a body that is not JSON are refused or ignored', async () => {
  const { p, hook, url } = await setup('github')
  const body = fixture('github-workflow-run.json')
  const good = await github(body, hook.secret, 'workflow_run', 'd1')
  assert.equal((await http(url, { method: 'POST', headers: { ...good, 'x-hub-signature-256': '' }, body })).status, 401, 'no signature')
  assert.equal((await http(url, { method: 'POST', headers: await github(body, 'the-wrong-secret', 'workflow_run', 'd1'), body })).status, 401, 'wrong secret')
  assert.equal((await http(url, { method: 'POST', headers: good, body: body.replace('failure', 'success') })).status, 401, 'body changed after signing')
  const ping = '{"zen":"Keep it logically awesome.","hook_id":1}'
  const pinged = await http(url, { method: 'POST', headers: await github(ping, hook.secret, 'ping', 'd2'), body: ping })
  assert.equal(pinged.status, 200); assert.equal(((await pinged.json()) as any).ignored, 'ping')
  const text = 'not json at all'
  assert.equal((await http(url, { method: 'POST', headers: await github(text, hook.secret, 'push', 'd3'), body: text })).status, 400)
  const form = 'payload=%7B%7D'
  const formResponse = await http(url, { method: 'POST', headers: await github(form, hook.secret, 'push', 'd4', { 'content-type': 'application/x-www-form-urlencoded' }), body: form })
  assert.equal(formResponse.status, 400); assert.match(((await formResponse.json()) as any).error, /application\/json/)
  assert.equal((await http(url, { method: 'POST', headers: good, body })).status, 200)
  const lines = await stored(p)
  assert.deepEqual(lines.map(l => l.record.event), ['github.workflow_run.completed'], 'only the valid delivery was stored; the ping was not')
  assert.equal(lines[0].record.timestamp, '2026-11-06T18:14:30.000Z')
})

test('who may call the hook: only a publishable key for that provider, in the query string, with that project\'s signature', async () => {
  const { p, hook, url } = await setup('github')
  const other = await setup('github')
  const body = fixture('github-release.json'), headers = await github(body, hook.secret, 'release', 'k1')
  const key = new URL(url).searchParams.get('key')!
  const withKey = (k: string | null) => url.replace(/key=[^&]+/, k === null ? '' : `key=${k}`)
  assert.equal((await http(withKey(null), { method: 'POST', headers, body })).status, 401, 'no key')
  assert.equal((await http(withKey(p.sk), { method: 'POST', headers, body })).status, 401, 'a secret key')
  assert.equal((await http(withKey('slurp_pk_nope'), { method: 'POST', headers, body })).status, 401, 'an unknown key')
  assert.equal((await http(withKey(p.pk), { method: 'POST', headers, body })).status, 401, 'the project\'s default key is for the default source, not for github')
  assert.equal((await http(`/hooks/github?key=${key}`, { method: 'GET' })).status, 405)
  const unknown = await http(`/hooks/bitbucket?key=${key}`, { method: 'POST', body })
  assert.equal(unknown.status, 404, 'an unknown provider'); assert.match(((await unknown.json()) as any).error, /github, stripe, revenuecat or generic/)
  // This project's key with another project's secret is not authentic.
  assert.equal((await http(url, { method: 'POST', headers: await github(body, other.hook.secret, 'release', 'k2'), body })).status, 401)
  // A provider that was never connected has a key (CreateKey) but no secret: refused with a pointer
  await call(ADMIN_TOKEN, 'CreateKey', { project: p.id, scope: 'publishable', source: 'generic' })
  const generic = (await call(ADMIN_TOKEN, 'SourceKey', { project: p.id, source: 'generic' })).key.key!
  const notConnected = await http(`/hooks/generic?key=${generic}`, { method: 'POST', body: '{}' })
  assert.equal(notConnected.status, 401); assert.match(((await notConnected.json()) as any).error, /not connected/)
})

test('a signed Stripe event is stored as stripe.<type> with its own id and time; replays outside five minutes are refused', async () => {
  const { p, hook, url } = await setup('stripe')
  const body = fixture('stripe-invoice-paid.json')
  assert.equal((await http(url, { method: 'POST', headers: await stripe(body, hook.secret), body })).status, 200)
  assert.equal((await http(url, { method: 'POST', headers: await stripe(body, hook.secret, Math.floor(Date.now() / 1000) - 3600), body })).status, 401, 'a replay of an old delivery')
  assert.equal((await http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401, 'no signature')
  const [line, ...rest] = await stored(p)
  assert.equal(rest.length, 0)
  assert.equal(line.record.event, 'stripe.invoice.paid'); assert.equal(line.record.id, 'evt_1QdXyz2eZvKYlo2C0AbCdEfG'); assert.equal(line.sender, 'stripe')
  assert.equal(line.record.timestamp, new Date(1793987531 * 1000).toISOString())
  assert.equal(line.record.data.data.object.amount_paid, 4900)
})

test('RevenueCat sends the pasted Authorization value; an event is stored as revenuecat.<type>, and a retry is the same record', async () => {
  assert.equal(authorizationOk('s3cret', 's3cret'), true)
  assert.equal(authorizationOk('Bearer s3cret', 's3cret'), true, 'a Bearer prefix is tolerated')
  assert.equal(authorizationOk('s3cret!', 's3cret'), false); assert.equal(authorizationOk('', 's3cret'), false); assert.equal(authorizationOk(null, 's3cret'), false)

  const { p, hook, url } = await setup('revenuecat')
  assert.equal(hook.sender, 'revenuecat')
  const body = fixture('revenuecat-initial-purchase.json')
  const post = (payload: string, authorization?: string, target = url) => http(target, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: payload })
  assert.equal((await post(body)).status, 401, 'no Authorization header')
  assert.equal((await post(body, 'wrong')).status, 401)
  assert.equal((await post(body, hook.secret)).status, 200)
  assert.equal((await post(body, hook.secret)).status, 200, 'RevenueCat retries a delivery with the same event id')
  assert.equal((await post('{"api_version":"1.0","event":{"type":"RENEWAL"}}', hook.secret)).status, 400, 'no event id')
  assert.equal((await post('[]', hook.secret)).status, 400, 'not an object')
  assert.equal((await post(fixture('revenuecat-test.json'), hook.secret)).status, 200, 'the dashboard test event')
  const other = await setup('revenuecat')
  assert.equal((await post(body, other.hook.secret)).status, 401)
  assert.equal((await post(body, hook.secret, url.replace(/key=[^&]+/, 'key=slurp_pk_0000000000000000_revenuecat_' + '0'.repeat(48)))).status, 401)

  const lines = await stored(p)
  const purchases = lines.filter(l => l.record.event === 'revenuecat.initial_purchase')
  assert.equal(purchases.length, 2); assert.equal(JSON.stringify(purchases[0].record), JSON.stringify(purchases[1].record))
  assert.deepEqual(lines.map(l => l.record.event).sort(), ['revenuecat.initial_purchase', 'revenuecat.initial_purchase', 'revenuecat.test'])
  const { record, sender } = purchases[0]
  assert.equal(record.id, 'revenuecat:7a1f0d2e-5b3c-4c8a-9e61-2f4d8b0c1a37'); assert.equal(sender, 'revenuecat')
  assert.equal(record.timestamp, new Date(1793987531000).toISOString())
  assert.equal(record.data.event.price, 9.99); assert.equal(record.data.event.product_id, 'pro_monthly')
})

test('rotating a webhook is revoking its key and connecting again: a new URL and a new secret, and the old ones stop working', async () => {
  const a = await setup('github'), b = await setup('github')
  const body = fixture('github-release.json')
  assert.equal((await http(a.url, { method: 'POST', headers: await github(body, a.hook.secret, 'release', 'r1'), body })).status, 200)
  const key = (await call(ADMIN_TOKEN, 'ListKeys', { project: a.p.id, scope: 'publishable' })).keys.find(k => k.key && a.url.includes(k.key))!
  await call(ADMIN_TOKEN, 'RevokeKey', { project: a.p.id, keyId: key.keyId })
  assert.equal((await http(a.url, { method: 'POST', headers: await github(body, a.hook.secret, 'release', 'r2'), body })).status, 401, 'the revoked key no longer opens the hook')
  const again = await connect(a.p.id, 'github')
  assert.notEqual(again.url, a.url, 'a new key, so a new URL'); assert.notEqual(again.secret, a.hook.secret, 'and a new secret')
  assert.deepEqual(await connect(a.p.id, 'github'), again, 'connecting again changes nothing more')
  assert.equal((await http(a.url, { method: 'POST', headers: await github(body, a.hook.secret, 'release', 'r3'), body })).status, 401, 'old URL and old secret')
  assert.equal((await http(again.url, { method: 'POST', headers: await github(body, a.hook.secret, 'release', 'r4'), body })).status, 401, 'new URL, old secret')
  assert.equal((await http(again.url, { method: 'POST', headers: await github(body, again.secret, 'release', 'r5'), body })).status, 200)
  assert.equal((await http(b.url, { method: 'POST', headers: await github(body, b.hook.secret, 'release', 'r6'), body })).status, 200, 'another project is untouched')
})

test('the generic receiver: unsigned by default, optionally signed, with the event named by the caller or the body', async () => {
  const { p, hook, url } = await setup('generic')
  const send = (body: string, headers: Record<string, string> = {}, query = '') => http(url + query, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  assert.equal((await send('{"type":"deploy.finished","env":"prod"}', { 'idempotency-key': 'deploy-17' })).status, 200)
  assert.equal((await send('{"hello":"world"}', {}, '&event=build.done')).status, 200)
  assert.equal((await send('[1,2,3]')).status, 200, 'an array is wrapped')
  assert.equal((await send('plain text, not JSON')).status, 200, 'text is kept as raw')
  const signed = '{"event":"signed.one"}'
  assert.equal((await send(signed, { 'x-slurp-signature': `sha256=${await hmac(hook.secret, signed)}` })).status, 200)
  assert.equal((await send(signed, { 'x-slurp-signature': `sha256=${await hmac('wrong', signed)}` })).status, 401, 'when a signature is sent it must be right')
  const lines = (await stored(p)).map(l => l.record)
  const byEvent = (event: string) => lines.find(l => l.event === event)
  assert.equal(byEvent('deploy.finished').id, 'generic:deploy-17'); assert.equal(byEvent('deploy.finished').data.env, 'prod')
  assert.ok(byEvent('build.done')); assert.ok(byEvent('signed.one'))
  assert.deepEqual(lines.find(l => l.data.items)!.data.items, [1, 2, 3])
  assert.equal(lines.find(l => l.data.raw)!.data.raw, 'plain text, not JSON')
  assert.equal(lines.filter(l => l.event === 'webhook').length, 2, 'no event name anywhere: it is called webhook')
})

test('nothing is invented: a delivery without a time or id of its own has none in its record', async () => {
  const { p, hook, url } = await setup('github')
  const body = '{"action":"started","repository":{"full_name":"acme/shop"}}' // a watch event: no timestamp anywhere in it
  const send = async (delivery: string) => http(url, { method: 'POST', headers: await github(body, hook.secret, 'watch', delivery), body })
  assert.equal((await send('late-1')).status, 200); await pause(40); assert.equal((await send('late-1')).status, 200)
  const lines = (await stored(p)).filter(l => l.record.id === 'github:late-1')
  assert.equal(lines.length, 2)
  assert.ok(!('timestamp' in lines[0].record), 'no timestamp: the importer defaults it to received_at')
  assert.equal(JSON.stringify(lines[0].record), JSON.stringify(lines[1].record), 'a redelivery produces the identical record, however late')
  assert.notEqual(lines[0].received_at, lines[1].received_at, 'only the envelope differs')

  const stripeHook = await setup('stripe'), rc = await setup('revenuecat')
  const noTime = '{"id":"evt_notime","type":"ping.test"}', rcBody = '{"event":{"id":"rc-notime","type":"TEST"}}'
  assert.equal((await http(stripeHook.url, { method: 'POST', headers: await stripe(noTime, stripeHook.hook.secret), body: noTime })).status, 200)
  assert.equal((await http(rc.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: rc.hook.secret }, body: rcBody })).status, 200)
  for (const project of [stripeHook.p, rc.p]) { const [line] = await stored(project); assert.ok(!('timestamp' in line.record), JSON.stringify(line.record)) }
})

test('the generic receiver: a caller\'s id or a body time make retries identical; a body with neither has no id and is its own event each time', async () => {
  const { p, url } = await setup('generic')
  const send = (body: string, headers: Record<string, string> = {}) => http(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await send('{"type":"job.done"}', { 'idempotency-key': 'job-9' })).status, 200)
    assert.equal((await send('{"type":"job.done"}', { 'x-request-id': 'req-1' })).status, 200)
    assert.equal((await send('{"type":"tick","timestamp":"2026-11-06T10:00:00Z"}')).status, 200)
    assert.equal((await send('{"type":"heartbeat"}')).status, 200)
    await pause(40)
  }
  const lines = (await stored(p)).map(l => l.record)
  const of = (event: string) => lines.filter(l => l.event === event)
  const same = (rs: any[]) => rs.length === 2 && JSON.stringify(rs[0]) === JSON.stringify(rs[1])
  assert.equal(of('job.done').length, 4)
  assert.deepEqual([...new Set(of('job.done').map(l => l.id))].sort(), ['generic:job-9', 'generic:req-1'])
  assert.ok(same(of('tick')), 'same body and time, same record'); assert.match(of('tick')[0].id, /^generic:sha256-[0-9a-f]{64}$/)
  assert.equal(of('tick')[0].timestamp, '2026-11-06T10:00:00.000Z')
  assert.equal(of('heartbeat').length, 2)
  assert.ok(of('heartbeat').every(l => !('id' in l) && !('timestamp' in l)), 'no id and no time, so each POST is its own event')
})

test('a payload over 1 MiB is refused with 413, not truncated', async () => {
  const { hook, url } = await setup('github')
  const big = JSON.stringify({ action: 'created', filler: 'x'.repeat(1024 * 1024 + 10) })
  assert.equal((await http(url, { method: 'POST', headers: await github(big, hook.secret, 'push', 'big1'), body: big })).status, 413)
})

test('Stripe: the secret Stripe issued is given to Slurp and kept, and until it is set the hook refuses everything', async () => {
  const p = await newProject('hook_stripe_setup')
  const empty = await connect(p.id, 'stripe')
  assert.equal(empty.secret, '', 'nothing to show before Stripe has issued one')
  assert.ok(empty.steps.some(s => /--secret whsec_/.test(s)))
  const body = fixture('stripe-invoice-paid.json')
  const refused = await http(empty.url, { method: 'POST', headers: await stripe(body, STRIPE_SECRET), body })
  assert.equal(refused.status, 401); assert.match(((await refused.json()) as any).error, /--secret/)
  assert.equal((await connect(p.id, 'stripe', STRIPE_SECRET)).secret, STRIPE_SECRET)
  assert.equal((await connect(p.id, 'stripe')).secret, STRIPE_SECRET, 'and it is remembered')
  assert.equal((await http(empty.url, { method: 'POST', headers: await stripe(body, STRIPE_SECRET), body })).status, 200)
  assert.equal((await http(empty.url, { method: 'POST', headers: await stripe(body, 'whsec_someone_elses_secret_value_here'), body })).status, 401)
  // passing a secret again replaces it
  const second = ['whsec', 'fedcba9876543210'.repeat(2)].join('_')
  assert.equal((await connect(p.id, 'stripe', second)).secret, second)
  assert.equal((await http(empty.url, { method: 'POST', headers: await stripe(body, STRIPE_SECRET), body })).status, 401)
  // only Stripe issues its own secret, and it must look like one
  await rejects(connect(p.id, 'stripe', 'not-a-stripe-secret'), 'invalid_argument')
  await rejects(connect(p.id, 'github', STRIPE_SECRET), 'invalid_argument')
})
