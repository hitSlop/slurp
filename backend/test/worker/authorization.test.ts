// Who may do what, checked against the real Worker. The credentials are the admin token, a project's secret key (reads that
// project's archives) and a publishable key (sends events for one source). There are no signed links: downloads use a bearer too.
import { abortAllDurableObjects } from 'cloudflare:test'
import { afterEach, test } from 'vitest'
import { ADMIN_TOKEN, admin, assert, call, evt, http, newProject, post, publish, randomName as name, stats } from './helpers.ts'

afterEach(abortAllDurableObjects)

type Who = 'anonymous' | 'publishableA' | 'secretA' | 'publishableB' | 'secretB' | 'admin'
const WHO: Who[] = ['anonymous', 'publishableA', 'secretA', 'publishableB', 'secretB', 'admin']
type Keys = { a: Awaited<ReturnType<typeof newProject>>; b: Awaited<ReturnType<typeof newProject>> }
const bearer = (who: Who, k: Keys): Record<string, string> => {
  const token = { anonymous: '', publishableA: k.a.pk, secretA: k.a.sk, publishableB: k.b.pk, secretB: k.b.sk, admin: ADMIN_TOKEN }[who]
  return token ? { Authorization: `Bearer ${token}` } : {}
}
const rpcStatus = async (method: string, body: object, headers: Record<string, string>) =>
  (await http(`/v1/rpc/${method}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status

/** The expected HTTP status for each credential; anything not named is `otherwise`. */
const expect = (otherwise: number, overrides: Partial<Record<Who, number>>): Record<Who, number> =>
  Object.fromEntries(WHO.map(who => [who, overrides[who] ?? otherwise])) as Record<Who, number>

test('every API method answers each credential exactly as intended', async () => {
  const k: Keys = { a: await newProject('authz_a'), b: await newProject('authz_b') }
  const spare = async () => ((await (await http(`/v1/rpc/CreateKey`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ project: k.a.id, scope: 'publishable', source: 'spare' }) })).json()) as any).key.keyId as string
  // A project's own secret key reads its archives; nothing else does. The control plane is the admin token only.
  const archiveRead = expect(403, { anonymous: 401, secretA: 200, admin: 200 })
  const adminOnly = expect(403, { anonymous: 401, admin: 200 })
  const matrix: [string, () => Promise<object>, Record<Who, number>][] = [
    ['Whoami', async () => ({}), expect(200, { anonymous: 401 })],
    ['ListArchives', async () => ({ project: k.a.id }), archiveRead],
    ['ListProjects', async () => ({}), adminOnly],
    ['GetProject', async () => ({ project: k.a.id }), adminOnly],
    ['CreateProject', async () => ({ name: name('authz_new') }), adminOnly],
    ['SourceKey', async () => ({ project: k.a.id, source: 'web' }), adminOnly],
    ['CreateKey', async () => ({ project: k.a.id, scope: 'publishable', source: 'extra' }), adminOnly],
    ['ListKeys', async () => ({ project: k.a.id }), adminOnly],
    ['ConnectWebhook', async () => ({ project: k.a.id, provider: 'github' }), adminOnly],
    ['RevokeKey', async () => ({ project: k.a.id, keyId: await spare() }), adminOnly],
    ['Publish', async () => ({ project: k.a.id }), archiveRead],
  ]
  for (const [method, body, expected] of matrix)
    for (const who of WHO)
      assert.equal(await rpcStatus(method, await body(), bearer(who, k)), expected[who], `${method} as ${who}`)
})

test('events are accepted only for a publishable key, whichever way it is presented', async () => {
  const k: Keys = { a: await newProject('authz_ing_a'), b: await newProject('authz_ing_b') }
  const expected = expect(403, { anonymous: 401, publishableA: 200, publishableB: 200 })
  for (const who of WHO) {
    const response = await http(`/v1/events`, { method: 'POST', headers: bearer(who, k), body: evt(`ing-${who}`) })
    assert.equal(response.status, expected[who], `POST /v1/events as ${who}`)
  }
  // A publishable key may travel in the query string (browsers cannot always set headers); a secret key may not.
  assert.equal((await http(`/v1/events?key=${k.a.pk}`, { method: 'POST', body: evt('q1') })).status, 200)
  assert.equal((await http(`/v1/events?key=${k.a.sk}`, { method: 'POST', body: evt('q2') })).status, 401)
  assert.equal((await http(`/v1/events?key=${k.a.pk}&key=${k.b.pk}`, { method: 'POST', body: evt('q3') })).status, 401, 'two keys are refused, not merged')
  // The compatibility endpoints take the same credential: publishable keys only.
  const segment = (key: string | null) => http(`/v1/t${key ? `?key=${key}` : ''}`, { method: 'POST', body: JSON.stringify({ event: 'x', userId: 'u' }) })
  assert.equal((await segment(k.a.pk)).status, 200); assert.equal((await segment(k.a.sk)).status, 400); assert.equal((await segment(null)).status, 400) // Segment SDKs drop a 400; a 401 is retried
  const sentry = (key: string | null) => http(`/api/1/envelope/${key ? `?sentry_key=${key}` : ''}`, { method: 'POST', body: '{"event_id":"' + 'a'.repeat(32) + '"}\n' })
  assert.equal((await sentry(k.a.pk)).status, 200); assert.equal((await sentry(k.a.sk)).status, 403); assert.equal((await sentry(null)).status, 403)
})

test('a key revoked while its body is still uploading stores nothing: the project object checks the key at enqueue', async () => {
  const p = await newProject('authz_race')
  const keys = (await call(ADMIN_TOKEN, 'ListKeys', { project: p.id, scope: 'publishable' })).keys
  const keyId = keys.find((k: any) => k.key === p.pk)!.keyId as string
  const enc = new TextEncoder()
  let release!: () => void
  const second = new Promise<void>(resolve => { release = resolve })
  const body = new ReadableStream<Uint8Array>({
    async start(c) { c.enqueue(enc.encode(evt('race-1') + '\n')); await second; c.enqueue(enc.encode(evt('race-2') + '\n')); c.close() },
  })
  const sending = http(`/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${p.pk}` }, body })
  await new Promise(r => setTimeout(r, 300)) // the Worker has the first half and is waiting for the rest
  await call(ADMIN_TOKEN, 'RevokeKey', { project: p.id, keyId })
  release()
  const response = await sending
  assert.equal(response.status, 401)
  const st = await stats(p)
  assert.deepEqual([st.chunks, st.queued, st.bufferedBytes], [0, 0, 0], 'nothing was stored')
  assert.equal((await post(p.pk, evt('after'))).status, 401, 'and the key stays refused')
})

test('archive downloads: the admin or that project\'s secret key, and nothing else', async () => {
  const k: Keys = { a: await newProject('authz_dl_a'), b: await newProject('authz_dl_b') }
  assert.equal((await post(k.a.pk, evt('d1'))).status, 200)
  await publish(k.a)
  const get = (who: Who, method = 'GET') => http(`/v1/projects/${k.a.id}/archives/1`, { method, headers: bearer(who, k) })
  const expected = expect(403, { anonymous: 401, secretA: 200, admin: 200 })
  for (const who of WHO) {
    assert.equal((await get(who)).status, expected[who], `GET as ${who}`)
    assert.equal((await get(who, 'HEAD')).status, expected[who], `HEAD as ${who}`)
  }
  // a link is no longer a credential: signatures in the query string mean nothing
  assert.equal((await http(`/v1/projects/${k.a.id}/archives/1?exp=9999999999&sig=abc`)).status, 401)
})

test('the purge route is for the admin token alone', async () => {
  const k: Keys = { a: await newProject('authz_purge_a'), b: await newProject('authz_purge_b') }
  const purge = (who: Who, body: object) => http(`/v1/admin/purge`, { method: 'POST', headers: bearer(who, k), body: JSON.stringify(body) })
  for (const who of WHO) {
    if (who === 'admin') continue
    assert.equal((await purge(who, { confirm: 'delete-all-data' })).status, who === 'anonymous' ? 401 : 403, `purge as ${who}`)
  }
  assert.equal((await purge('admin', {})).status, 400, 'the admin must also confirm')
})
