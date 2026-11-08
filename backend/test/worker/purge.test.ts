// Its own file because it deletes every project in the Worker's storage, and each file of a Vitest run has storage of its own.
import { abortAllDurableObjects } from 'cloudflare:test'
import { afterEach, test } from 'vitest'
import { ADMIN_TOKEN, admin, assert, call, evt, http, newProject, post, publish } from './helpers.ts'

afterEach(abortAllDurableObjects)

test('purge removes every project, archive and stray object so a deployment can be deleted', async () => {
  const a = await newProject('purge_a'), b = await newProject('purge_b')
  for (const s of [a, b]) { assert.equal((await post(s.pk, evt('p1'))).status, 200); await publish(s) }
  const url = `/v1/projects/${a.id}/archives/1`
  assert.equal((await http(url, { headers: admin })).status, 200)
  const purge = (body: string, headers: Record<string, string> = admin) => http('/v1/admin/purge', { method: 'POST', headers, body })
  assert.equal((await purge('{"confirm":"delete-all-data"}', {})).status, 401)
  assert.equal((await purge('{"confirm":"delete-all-data"}', { Authorization: `Bearer ${a.sk}` })).status, 403)
  assert.equal((await purge('{}')).status, 400)
  assert.equal((await call(ADMIN_TOKEN, 'ListProjects', {})).projects.length, 2, 'nothing was deleted without confirmation')
  const done = await (await purge('{"confirm":"delete-all-data"}')).json() as any
  assert.deepEqual([done.ok, done.projects, done.archives], [true, 2, 2])
  assert.equal((await http(url, { headers: admin })).status, 404, 'archive object is gone from R2')
  assert.equal((await call(ADMIN_TOKEN, 'ListProjects', {})).projects.length, 0)
  assert.equal((await post(a.pk, evt('p2'))).status, 401, 'keys are gone')
  // the deployment is usable again from scratch
  const again = await newProject('after')
  assert.equal((await post(again.pk, evt('p3'))).status, 200)
})
