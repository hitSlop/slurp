import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Archive, Health, Project } from '../src/slurp.gen.ts'

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token-0123456789abcdef'
export const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` }

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) })
  s.on('error', reject)
})

export interface Worker { base: string; stop: () => Promise<void>; clients: { project: Project; archive: Archive; health: Health } }

/** Boot the real Worker under `wrangler dev --local` with isolated storage. Pass BASE to reuse a running one. */
export async function startWorker(vars: Record<string, string> = {}): Promise<Worker> {
  const f = (i: any, init?: any) => fetch(i, init)
  const wrap = (base: string, stop: () => Promise<void>): Worker => ({ base, stop, clients: { project: new Project(base, f), archive: new Archive(base, f), health: new Health(base, f) } })
  if (process.env.BASE) return wrap(process.env.BASE, async () => {})
  let last = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = await tryStart(vars)
    if ('base' in started) return wrap(started.base, started.stop)
    last = started.log
    if (!/Address already in use|EADDRINUSE/.test(last)) break // only port collisions between parallel test files are retried
  }
  throw new Error(`wrangler did not start: ${last.slice(-2000)}`)
}

async function tryStart(vars: Record<string, string>): Promise<{ base: string; stop: () => Promise<void> } | { log: string }> {
  const [port, inspector] = [await freePort(), await freePort()]
  const state = mkdtempSync(join(tmpdir(), 'slurp-worker-'))
  const all = { ADMIN_TOKEN, DEBUG: '1', GROUP_COMMIT_MS: '20', SEAL_INTERVAL_MS: '3600000', ...vars }
  const args = ['wrangler', 'dev', '--local', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', state, '--log-level', 'warn', ...Object.entries(all).flatMap(([k, v]) => ['--var', `${k}:${v}`])]
  const child: ChildProcess = spawn('npx', args, { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout!.on('data', d => { log += d }); child.stderr!.on('data', d => { log += d })
  const base = `http://127.0.0.1:${port}`
  const stop = async () => {
    child.kill('SIGTERM')
    await new Promise(r => { child.once('exit', r); setTimeout(r, 3000) })
    rmSync(state, { recursive: true, force: true })
  }
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) { rmSync(state, { recursive: true, force: true }); return { log } }
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, stop } } catch {}
    if (Date.now() > deadline) { await stop(); return { log: `timeout: ${log}` } }
    await new Promise(r => setTimeout(r, 250))
  }
}

export const evt = (id: string, extra: object = {}) => JSON.stringify({ id, type: 'track', event: 'signup', timestamp: '2026-11-06T00:00:00Z', data: { n: 1 }, ...extra })
export const rpc = async (base: string, service: string, method: string, body: object, headers: Record<string, string> = admin) =>
  (await fetch(`${base}/rpc/${service}/${method}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>
export const post = (base: string, key: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...headers }, body: body as any })
export const stats = async (base: string, src: string) => (await fetch(`${base}/__debug/stats/${src}`, { headers: admin })).json() as Promise<any>
export const debug = async (base: string, op: string, src: string) => (await fetch(`${base}/__debug/${op}/${src}`, { headers: admin })).json() as Promise<any>
export async function newProject(base: string, name: string, geo = false) {
  const created = await rpc(base, 'Project', 'CreateProject', { name: name.replace(/-/g, '_'), geoEnabled: geo })
  const sk = (await rpc(base, 'Project', 'CreateKey', { project: created.project.id, scope: 'secret' })).key as string
  return { id: created.project.id as string, pk: created.publishableKey as string, sk }
}
export async function readArchives(base: string, project: string, sk: string): Promise<{ name: string; lines: any[]; raw: string }[]> {
  const { gunzipSync } = await import('node:zlib')
  const list = await rpc(base, 'Archive', 'ListObjects', { project }, { Authorization: `Bearer ${sk}` })
  const out = []
  for (const o of list.objects ?? []) {
    const raw = gunzipSync(Buffer.from(await (await fetch(o.url)).arrayBuffer())).toString()
    out.push({ name: o.name, raw, lines: raw.trim().split('\n').map(l => JSON.parse(l.replace(/9007199254740993123456789/g, '"BIG"'))) })
  }
  return out
}
