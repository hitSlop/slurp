// The operator's view: who may see it, what it reports for a healthy and a failing project, and that the page itself holds no data.
import { abortAllDurableObjects } from 'cloudflare:test'
import { afterEach, test } from 'vitest'
import type { ProjectRow } from '../../src/registry.ts'
import { type Outcome, type ProjectHealth, buildReport, issuesOf, projectStatus } from '../../src/status.ts'
import { ADMIN_TOKEN, admin, assert, breakArchive, call, evt, http, httpWith, newProject, post, publish, randomName } from './helpers.ts'

afterEach(abortAllDurableObjects)

const status = async (fetcher: typeof http = http, headers: Record<string, string> = admin) => {
  const res = await fetcher('/v1/admin/status', { headers })
  return { status: res.status, body: (res.status === 200 ? await res.json() : null) as any }
}
const named = (report: any, id: string, name: string) => report.projects.find((p: any) => p.name === name || p.id === id)

// ---- who may see it ----

test('only the admin token reads the status; every other credential is refused', async () => {
  const p = await newProject('status_auth')
  assert.equal((await status(http, {})).status, 401)
  assert.equal((await status(http, { Authorization: `Bearer ${p.pk}` })).status, 403)
  assert.equal((await status(http, { Authorization: `Bearer ${p.sk}` })).status, 403)
  assert.equal((await status(http, { Authorization: 'Bearer nope' })).status, 401)
  assert.equal((await status()).status, 200)
  assert.equal((await http('/v1/admin/status', { method: 'POST', headers: admin })).status, 405)
})

test('the dashboard page is public, static and holds no project data', async () => {
  const name = randomName('dash_secret')
  await call(ADMIN_TOKEN, 'CreateProject', { name })
  const res = await http('/dashboard')
  const html = await res.text()
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.ok(!html.includes(name), 'no project name appears in the page')
  const nonce = /script nonce="([^"]+)"/.exec(html)?.[1]
  assert.ok(nonce, 'the one script carries a nonce')
  const csp = res.headers.get('content-security-policy') ?? ''
  assert.ok(csp.includes(`script-src 'nonce-${nonce}'`) && csp.includes("connect-src 'self'") && !csp.includes("script-src 'unsafe-inline'"), csp)
  const other = (await http('/dashboard')).headers.get('content-security-policy')
  assert.notEqual(other, csp, 'the nonce is new for every response')
  assert.equal((await http('/dashboard', { method: 'HEAD' })).status, 200)
  assert.equal((await http('/dashboard', { method: 'POST' })).status, 404, 'only GET and HEAD are the page')
})

test('the setup page keeps its strict policy and links to the dashboard', async () => {
  const res = await http('/')
  const html = await res.text()
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'")
  assert.ok(html.includes('/dashboard'))
  assert.ok(!html.includes('<script'))
  const unfinished = await (await httpWith({ ADMIN_TOKEN: '' })('/')).text()
  assert.ok(unfinished.includes('Not finished'))
})

// ---- what it reports ----

test('a healthy project is listed with its sources, archives and no issues', async () => {
  const p = await newProject('status_ok')
  assert.equal((await post(p.pk, evt('s1'))).status, 200)
  await publish(p)
  const { body } = await status()
  const mine = named(body, p.id, '')
  assert.equal(mine.status, 'ok'); assert.deepEqual(mine.issues, [])
  assert.deepEqual(mine.sources, ['default'])
  assert.equal(mine.archives, 1); assert.equal(mine.events, 1); assert.equal(mine.pending, false)
  assert.ok(mine.lastArchiveAt && mine.bytes > 0)
  assert.ok(!body.issues.some((i: any) => i.project === mine.name))
  assert.equal(body.summary.projects >= 1, true)
  assert.equal(typeof body.release, 'string')
})

test('events still waiting for an archive show as pending and as buffered bytes', async () => {
  const p = await newProject('status_pending')
  assert.equal((await post(p.pk, evt('w1'))).status, 200)
  const mine = named((await status()).body, p.id, '')
  assert.equal(mine.pending, true); assert.ok(mine.bufferedBytes > 0); assert.equal(mine.archives, 0)
  assert.equal(mine.status, 'ok')
})

test('a failing archive is reported as an error with its retry time, and clears when it heals', async () => {
  const p = await newProject('status_fail')
  assert.equal((await post(p.pk, evt('f1'))).status, 200)
  await breakArchive(p)
  assert.equal((await http(`/v1/rpc/Publish`, { method: 'POST', headers: admin, body: JSON.stringify({ project: p.id }) })).status, 503)
  const { body } = await status()
  const mine = named(body, p.id, '')
  assert.equal(mine.status, 'error')
  assert.match(mine.issues[0].message, /failed 1 time in a row, next try \d{4}-/)
  assert.ok(body.issues.some((i: any) => i.project === mine.name && i.level === 'error'), 'it is in the top-level list too')
  assert.ok(body.summary.errors >= 1)
  assert.equal(body.projects[0].status, 'error', 'problems are listed first')
})

test('a nearly full and a full buffer are reported, using the Worker-level cap', async () => {
  const p = await newProject('status_buf')
  const body = Array.from({ length: 8 }, (_, i) => evt(`b${i}`, { data: { pad: 'x'.repeat(60) } })).join('\n')
  assert.equal((await post(p.pk, body)).status, 200)
  const buffered = named((await status()).body, p.id, '').bufferedBytes as number
  assert.ok(buffered > 1000)
  const warn = named((await status(httpWith({ BUFFER_CAP_BYTES: String(Math.ceil(buffered / 0.9)) }))).body, p.id, '')
  assert.equal(warn.status, 'warn'); assert.match(warn.issues[0].message, /% full/)
  const full = named((await status(httpWith({ BUFFER_CAP_BYTES: String(buffered) }))).body, p.id, '')
  assert.equal(full.status, 'error'); assert.match(full.issues[0].message, /buffer is full/)
})

test('a project created but never set up is a warning, not a failure of the report', async () => {
  // Claiming a name in the registry without the project's own init is what a crash between the two steps leaves behind.
  const name = randomName('status_unset')
  const { env } = await import('cloudflare:workers')
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
  await registry.claim({ name })
  const { status: code, body } = await status()
  assert.equal(code, 200)
  const mine = named(body, '', name)
  assert.equal(mine.status, 'warn'); assert.match(mine.issues[0].message, /never set up/)
})

// ---- the rules, on their own ----

const row = (name: string): ProjectRow => ({ id: `prj_${name.padEnd(16, '0')}`, name, title: null, created_at: '2026-11-08T00:00:00.000Z' } as ProjectRow)
const health = (over: Partial<ProjectHealth> = {}): ProjectHealth => ({
  coverage: { pending: false }, failures: 0, retryAt: null, bufferedBytes: 0, oldestBufferedAt: null, archives: 0, events: 0, bytes: 0, sources: ['default'], ...over,
})
const CAP = { bufferCapBytes: 1000 }

test('issue rules: each outcome maps to its level and message', () => {
  const ok = (h: Partial<ProjectHealth>): Outcome => ({ kind: 'ok', health: health(h) })
  assert.deepEqual(issuesOf(ok({}), CAP), [])
  assert.deepEqual(issuesOf(ok({ bufferedBytes: 799 }), CAP), [], 'under 80% is quiet')
  assert.equal(issuesOf(ok({ bufferedBytes: 800 }), CAP)[0].level, 'warn')
  assert.equal(issuesOf(ok({ bufferedBytes: 1000 }), CAP)[0].level, 'error')
  assert.match(issuesOf(ok({ failures: 3, retryAt: Date.UTC(2026, 10, 8) }), CAP)[0].message, /failed 3 times in a row, next try 2026-11-08/)
  assert.deepEqual(issuesOf(ok({ failures: 1, bufferedBytes: 1000 }), CAP).map(i => i.level), ['error', 'error'])
  assert.equal(issuesOf({ kind: 'unreachable' }, CAP)[0].level, 'error')
  assert.match(issuesOf({ kind: 'blocked', message: 'data is newer than code' }, CAP)[0].message, /newer than code/)
  assert.equal(issuesOf({ kind: 'unset' }, CAP)[0].level, 'warn')
})

test('the report lists problems first and counts them; one unreachable project does not hide the rest', () => {
  const rows = [
    projectStatus(row('zeta'), { kind: 'ok', health: health() }, CAP),
    projectStatus(row('alpha'), { kind: 'unreachable' }, CAP),
    projectStatus(row('beta'), { kind: 'unset' }, CAP),
    projectStatus(row('gamma'), { kind: 'ok', health: health() }, CAP),
  ]
  const report = buildReport(rows, { release: '9.9.9', build: null, now: new Date('2026-11-08T00:00:00Z') })
  assert.deepEqual(report.projects.map(p => p.name), ['alpha', 'beta', 'gamma', 'zeta'])
  assert.deepEqual(report.projects.map(p => p.status), ['error', 'warn', 'ok', 'ok'])
  assert.deepEqual(report.issues.map(i => [i.project, i.level]), [['alpha', 'error'], ['beta', 'warn']])
  assert.deepEqual(report.summary, { projects: 4, errors: 1, warnings: 1 })
})
