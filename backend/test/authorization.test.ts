// Who may do what, checked against the real Worker. Two kinds of credential are kept apart on purpose:
//  - bearer credentials (the admin token and project keys) authorize every API call and event ingestion;
//  - a signed download link is itself the credential for /v1/objects/...: anyone holding a valid link can fetch that archive. What must
//    hold is that another project's key cannot obtain the link, and that links expire and cannot be altered.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ADMIN_TOKEN, admin, debug, evt, newProject, post, startWorker, type Worker } from './harness.ts'

let w: Worker
before(async () => { w = await startWorker() })
after(async () => { await w.stop() })
const name = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`

type Who = 'anonymous' | 'publishableA' | 'secretA' | 'publishableB' | 'secretB' | 'admin'
const WHO: Who[] = ['anonymous', 'publishableA', 'secretA', 'publishableB', 'secretB', 'admin']
type Keys = { a: Awaited<ReturnType<typeof newProject>>; b: Awaited<ReturnType<typeof newProject>> }
const bearer = (who: Who, k: Keys): Record<string, string> => {
  const token = { anonymous: '', publishableA: k.a.pk, secretA: k.a.sk, publishableB: k.b.pk, secretB: k.b.sk, admin: ADMIN_TOKEN }[who]
  return token ? { Authorization: `Bearer ${token}` } : {}
}
const rpcStatus = async (service: string, method: string, body: object, headers: Record<string, string>) =>
  (await fetch(`${w.base}/rpc/${service}/${method}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status

/** The expected HTTP status for each credential; anything not named is `otherwise`. */
const expect = (otherwise: number, overrides: Partial<Record<Who, number>>): Record<Who, number> =>
  Object.fromEntries(WHO.map(who => [who, overrides[who] ?? otherwise])) as Record<Who, number>

test('every API method answers each credential exactly as intended', async () => {
  const k: Keys = { a: await newProject(w.base, name('authz_a')), b: await newProject(w.base, name('authz_b')) }
  const spare = async () => ((await (await fetch(`${w.base}/rpc/Project/CreateKey`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ project: k.a.id, scope: 'publishable', name: 'spare' }) })).json()) as any).keyId as string
  // A project's own secret key reads its archives; nothing else does. The control plane is the admin token only.
  const archiveRead = expect(403, { anonymous: 401, secretA: 200, admin: 200 })
  const adminOnly = expect(403, { anonymous: 401, admin: 200 })
  const matrix: [string, string, () => Promise<object>, Record<Who, number>][] = [
    ['Health', 'Version', async () => ({}), expect(200, {})],
    ['Auth', 'Whoami', async () => ({}), expect(200, { anonymous: 401 })],
    ['Archive', 'ListObjects', async () => ({ project: k.a.id }), archiveRead],
    ['Archive', 'GetCoverage', async () => ({ project: k.a.id }), archiveRead],
    ['Project', 'ListProjects', async () => ({}), adminOnly],
    ['Project', 'GetProject', async () => ({ project: k.a.id }), adminOnly],
    ['Project', 'UpdateProject', async () => ({ project: k.a.id, title: 'T' }), adminOnly],
    ['Project', 'CreateProject', async () => ({ name: name('authz_new') }), adminOnly],
    ['Project', 'CreateKey', async () => ({ project: k.a.id, scope: 'publishable', name: 'extra' }), adminOnly],
    ['Project', 'ListKeys', async () => ({ project: k.a.id }), adminOnly],
    ['Project', 'GetWebhook', async () => ({ project: k.a.id, provider: 'github' }), adminOnly],
    ['Project', 'RevokeKey', async () => ({ project: k.a.id, keyId: await spare() }), adminOnly],
  ]
  for (const [service, method, body, expected] of matrix)
    for (const who of WHO)
      assert.equal(await rpcStatus(service, method, await body(), bearer(who, k)), expected[who], `${service}.${method} as ${who}`)
})

test('events are accepted only for a publishable key, whichever way it is presented', async () => {
  const k: Keys = { a: await newProject(w.base, name('authz_ing_a')), b: await newProject(w.base, name('authz_ing_b')) }
  const expected = expect(403, { anonymous: 401, publishableA: 200, publishableB: 200 })
  for (const who of WHO) {
    const response = await fetch(`${w.base}/v1/events`, { method: 'POST', headers: bearer(who, k), body: evt(`ing-${who}`) })
    assert.equal(response.status, expected[who], `POST /v1/events as ${who}`)
  }
  // A publishable key may travel in the query string (browsers cannot always set headers); a secret key may not.
  assert.equal((await fetch(`${w.base}/v1/events?key=${k.a.pk}`, { method: 'POST', body: evt('q1') })).status, 200)
  assert.equal((await fetch(`${w.base}/v1/events?key=${k.a.sk}`, { method: 'POST', body: evt('q2') })).status, 401)
  assert.equal((await fetch(`${w.base}/v1/events?key=${k.a.pk}&key=${k.b.pk}`, { method: 'POST', body: evt('q3') })).status, 401, 'two keys are refused, not merged')
  // The compatibility endpoints take the same credential: publishable keys only.
  const segment = (key: string | null) => fetch(`${w.base}/v1/t${key ? `?key=${key}` : ''}`, { method: 'POST', body: JSON.stringify({ event: 'x', userId: 'u' }) })
  assert.equal((await segment(k.a.pk)).status, 200); assert.equal((await segment(k.a.sk)).status, 401); assert.equal((await segment(null)).status, 401)
  const sentry = (key: string | null) => fetch(`${w.base}/api/1/envelope/${key ? `?sentry_key=${key}` : ''}`, { method: 'POST', body: '{"event_id":"' + 'a'.repeat(32) + '"}\n' })
  assert.equal((await sentry(k.a.pk)).status, 200); assert.equal((await sentry(k.a.sk)).status, 403); assert.equal((await sentry(null)).status, 403)
})

test('the purge route is for the admin token alone', async () => {
  const k: Keys = { a: await newProject(w.base, name('authz_purge_a')), b: await newProject(w.base, name('authz_purge_b')) }
  const purge = (who: Who, body: object) => fetch(`${w.base}/v1/admin/purge`, { method: 'POST', headers: bearer(who, k), body: JSON.stringify(body) })
  for (const who of WHO) {
    if (who === 'admin') continue
    assert.equal((await purge(who, { confirm: 'delete-all-data' })).status, who === 'anonymous' ? 401 : 403, `purge as ${who}`)
  }
  assert.equal((await purge('admin', {})).status, 400, 'the admin must also confirm')
})

// The last test: it purges the Worker to prove a link outlives nothing, so nothing after it may rely on stored data.
test('signed download links: the link is the credential, other projects cannot get one, and links cannot be extended or altered', async () => {
  const a = await newProject(w.base, name('dl_a')), b = await newProject(w.base, name('dl_b'))
  assert.equal((await post(w.base, a.pk, evt('d1'))).status, 200)
  await debug(w.base, 'seal', a.id)
  const list = (project: string, token: string) => fetch(`${w.base}/rpc/Archive/ListObjects`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ project }) })
  // Project B's key cannot obtain project A's links, with either of its keys.
  assert.equal((await list(a.id, b.sk)).status, 403)
  assert.equal((await list(a.id, b.pk)).status, 403)
  const url = ((await (await list(a.id, a.sk)).json()) as any).objects[0].url as string
  const link = new URL(url)
  // Holding a valid link is enough, by design: no credential at all, or someone else's, makes no difference.
  assert.equal((await fetch(url)).status, 200)
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${b.sk}` } })).status, 200)
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  // Expired: asking for a later expiry or an earlier one both fail, because the signature covers it.
  const withParams = (change: (p: URLSearchParams) => void) => { const u = new URL(url); change(u.searchParams); return u.toString() }
  assert.equal((await fetch(withParams(p => p.set('exp', '1')))).status, 403, 'an expiry in the past')
  assert.equal((await fetch(withParams(p => p.set('exp', String(Number(p.get('exp')) + 86400))))).status, 403, 'a longer lifetime than was signed')
  // Tampered: the signature, the object path, and a link with no signature at all.
  assert.equal((await fetch(withParams(p => p.set('sig', p.get('sig')!.replace(/.$/, c => (c === '0' ? '1' : '0')))))).status, 403)
  assert.equal((await fetch(withParams(p => p.delete('sig')))).status, 403)
  const other = Buffer.from('v1/projects/prj_0000000000000000/archives/x/events/y.jsonl.gz').toString('base64url')
  assert.equal((await fetch(`${link.origin}/v1/objects/${other}${link.search}`)).status, 403, 'another path with this link\'s signature')
  assert.equal((await fetch(`${link.origin}/v1/objects/%%%${link.search}`)).status, 400, 'not even a token')
  // A link whose object is gone is a 404: purge the Worker, then use the link that was valid a moment ago.
  assert.equal((await fetch(`${w.base}/v1/admin/purge`, { method: 'POST', headers: admin, body: JSON.stringify({ confirm: 'delete-all-data' }) })).status, 200)
  assert.equal((await fetch(url)).status, 404)
})
