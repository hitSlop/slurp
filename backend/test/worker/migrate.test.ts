// Versioned storage: `migrate` against a real Durable Object's SQLite, and what the project and registry objects do with it.
// A restart is `abortAllDurableObjects()`; the next request rebuilds the object from its tables.
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, test } from 'vitest'
import { PROJECT_STEPS } from '../../src/db.ts'
import { SchemaTooNew, migrate } from '../../src/migrate.ts'
import { RELEASE } from '../../src/version.ts'
import { ADMIN_TOKEN, ApiError, admin, alarm, assert, call, count, evt, http, inside, newProject, post, publish, sql, stubOf } from './helpers.ts'

afterEach(abortAllDurableObjects)

/** A project id nothing has used: its object is empty, so a test can run its own steps in it. */
const freshId = () => 'prj_' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')
const version = async (id: string) => (await sql<{ version: number }>(id, 'SELECT version FROM _schema')).map(r => r.version)
const tables = async (id: string) => (await sql<{ name: string }>(id, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r.name)
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName('registry'))

test('migrate applies the steps in order, once each, and a second run changes nothing', async () => {
  const id = freshId()
  const steps = ['CREATE TABLE t(n INTEGER)', 'INSERT INTO t VALUES(1)', 'INSERT INTO t VALUES(2); ALTER TABLE t ADD COLUMN extra TEXT']
  await inside(id, (_i, state) => migrate(state.storage, steps.slice(0, 2)))
  assert.deepEqual(await version(id), [2])
  assert.deepEqual((await sql(id, 'SELECT n FROM t')).map(r => r.n), [1])
  await inside(id, (_i, state) => migrate(state.storage, steps))
  assert.deepEqual(await version(id), [3])
  assert.deepEqual((await sql(id, 'SELECT n FROM t ORDER BY n')).map(r => r.n), [1, 2], 'the first two steps did not run again')
  await inside(id, (_i, state) => { migrate(state.storage, steps); migrate(state.storage, steps) })
  assert.deepEqual(await version(id), [3], 'still one row')
  assert.equal(await count(id, 't'), 2)
})

test('a step that throws rolls back with its version bump, and the next run tries it again', async () => {
  const id = freshId()
  const steps = ['CREATE TABLE t(n INTEGER)', 'INSERT INTO t VALUES(1); CREATE TABLE t(n INTEGER)']
  await assert.rejects(inside(id, (_i, state) => migrate(state.storage, steps)), /already exists/)
  assert.deepEqual(await version(id), [1], 'step 0 stays applied')
  assert.equal(await count(id, 't'), 0, 'the failed step left no rows behind')
  const fixed = [steps[0], 'INSERT INTO t VALUES(1)']
  await inside(id, (_i, state) => migrate(state.storage, fixed))
  assert.deepEqual(await version(id), [2])
  assert.equal(await count(id, 't'), 1)
})

test('a stored version above the last step throws SchemaTooNew and writes nothing', async () => {
  const id = freshId()
  await inside(id, (_i, state) => migrate(state.storage, ['CREATE TABLE t(n INTEGER)', 'INSERT INTO t VALUES(1)', 'INSERT INTO t VALUES(2)']))
  const thrown = await inside(id, (_i, state) => {
    try { migrate(state.storage, ['CREATE TABLE t(n INTEGER)']) } catch (e) { return e }
    return null
  })
  assert.ok(thrown instanceof SchemaTooNew, 'SchemaTooNew')
  assert.deepEqual([(thrown as SchemaTooNew).stored, (thrown as SchemaTooNew).supported], [3, 1])
  assert.deepEqual(await version(id), [3])
  assert.equal(await count(id, 't'), 2)
})

test('a project object that restarts does not run its steps again, and keeps its version', async () => {
  const p = await newProject('restart')
  assert.deepEqual(await version(p.id), [PROJECT_STEPS.length])
  const before = await sql(p.id, 'SELECT * FROM keys ORDER BY key_id')
  await abortAllDurableObjects()
  assert.equal((await post(p.pk, evt('r1'))).status, 200, 'the restarted object serves its keys')
  assert.deepEqual(await version(p.id), [PROJECT_STEPS.length])
  assert.deepEqual(await sql(p.id, 'SELECT * FROM keys ORDER BY key_id'), before)
})

test('a project object whose data is newer than its code answers 503 / unavailable and writes nothing', async () => {
  const p = await newProject('toonew')
  assert.equal((await post(p.pk, evt('n1'))).status, 200)
  const newer = PROJECT_STEPS.length + 1
  await sql(p.id, 'UPDATE _schema SET version=?', newer)
  const snapshot = async () => ({
    tables: await tables(p.id), keys: await sql(p.id, 'SELECT * FROM keys ORDER BY key_id'),
    chunks: await count(p.id, 'chunks'), manifest: await count(p.id, 'manifest'), version: await version(p.id),
  })
  const before = await snapshot()
  await abortAllDurableObjects() // the next request builds the object again, from the newer tables

  // ingest, directly and over HTTP
  const direct = await stubOf(p).ingest(p.pk, [evt('n2')], null)
  assert.equal(direct.ok, false)
  if (!direct.ok) { assert.equal(direct.status, 503); assert.match(direct.reason, /newer than its code; deploy the newer Worker/) }
  const over = await post(p.pk, evt('n3'))
  assert.equal(over.status, 503)
  assert.match(((await over.json()) as any).error, /newer than its code/)

  // RPC-style methods: the failure shape, and the control API's 503 `unavailable`
  const unavailable = { ok: false, code: 'unavailable', message: "this Worker's data is newer than its code; deploy the newer Worker" }
  assert.deepEqual(await stubOf(p).sourceKey('default'), unavailable)
  assert.deepEqual(await stubOf(p).createKey('secret', undefined, undefined), unavailable)
  assert.deepEqual(await stubOf(p).listKeys(), unavailable)
  assert.deepEqual(await stubOf(p).revokeKey('x'), unavailable)
  assert.deepEqual(await stubOf(p).connectWebhook('stripe', '', null), unavailable)
  assert.deepEqual(await stubOf(p).init(), unavailable)
  assert.deepEqual(await stubOf(p).archives(undefined, 10), unavailable)
  assert.deepEqual(await stubOf(p).publish(), unavailable)
  for (const run of [
    () => call(ADMIN_TOKEN, 'ListKeys', { project: p.id }),
    () => call(ADMIN_TOKEN, 'SourceKey', { project: p.id, source: 'web' }),
    () => call(ADMIN_TOKEN, 'Publish', { project: p.id }),
    () => call(ADMIN_TOKEN, 'ListArchives', { project: p.id }),
  ]) await assert.rejects(run(), (e: ApiError) => e instanceof ApiError && e.status === 503 && e.code === 'unavailable')
  // a request that must present a project key to be authenticated is refused too, not told its key is wrong
  await assert.rejects(call(p.sk, 'Whoami', {}), (e: ApiError) => e instanceof ApiError && e.status === 503 && e.code === 'unavailable')
  assert.equal((await http(`/v1/projects/${p.id}/archives/1`, { headers: admin })).status, 503)

  // the alarm does nothing
  await alarm(p)
  assert.deepEqual(await snapshot(), before, 'no table, key, chunk, manifest row or version changed')
})

test('a forged key for a project that does not exist gets 401 and leaves its object without tables', async () => {
  const id = freshId()
  const hex = id.slice(4)
  assert.equal((await post(`slurp_pk_${hex}_default_${'0'.repeat(48)}`, evt('f1'))).status, 401)
  assert.equal((await post(`slurp_sk_${hex}_${'0'.repeat(48)}`, evt('f2'))).status, 401)
  await assert.rejects(call(`slurp_sk_${hex}_${'0'.repeat(48)}`, 'Whoami', {}), (e: ApiError) => e.status === 401)
  assert.deepEqual(await tables(id), [])
})

test('the registry keeps its version through a restart and after a purge', async () => {
  const latest = async () => (await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec('SELECT version FROM _schema').toArray())).map((r: any) => r.version)
  await newProject('reg')
  assert.deepEqual(await latest(), [1])
  await abortAllDurableObjects()
  assert.ok((await call(ADMIN_TOKEN, 'ListProjects', {})).projects.length >= 1)
  assert.deepEqual(await latest(), [1])
  const done = await http('/v1/admin/purge', { method: 'POST', headers: admin, body: '{"confirm":"delete-all-data"}' })
  assert.equal(done.status, 200)
  assert.deepEqual(await latest(), [1], 'purge leaves the registry at the latest version')
  assert.equal((await call(ADMIN_TOKEN, 'ListProjects', {})).projects.length, 0, 'including the project whose data was newer than the code')
  await newProject('after_purge')
  assert.equal((await call(ADMIN_TOKEN, 'ListProjects', {})).projects.length, 1)
})

test('ListArchives entries carry the archive format, and /v1/health names the release', async () => {
  const p = await newProject('format')
  assert.equal((await post(p.pk, evt('a1'))).status, 200)
  await publish(p)
  const page = await call(p.sk, 'ListArchives', { project: p.id })
  assert.equal(page.archives.length, 1)
  assert.equal(page.archives[0].format, 1)
  const health = (await (await http('/v1/health')).json()) as any
  assert.equal(health.release, RELEASE)
})
