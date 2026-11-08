// A real Worker under `wrangler dev --local`, for the tests that need a real HTTP listener: the Rust CLI, the Python and Swift SDKs, and
// the JS SDK's gateway test. Everything else runs inside workerd with Vitest (test/worker/), which is much faster.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { call } from '../../src/client.ts'

export { call, ApiError } from '../../src/client.ts'

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token-0123456789abcdef'

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) })
  s.on('error', reject)
})

export interface Worker {
  base: string
  stop: () => Promise<void>
}

/** Boot the real Worker under `wrangler dev --local` with isolated storage. Pass BASE to reuse a running one. */
export async function startWorker(vars: Record<string, string> = {}): Promise<Worker> {
  if (process.env.BASE) return { base: process.env.BASE, stop: async () => {} }
  const state = mkdtempSync(join(tmpdir(), 'slurp-worker-'))
  const all = { ADMIN_TOKEN, GROUP_COMMIT_MS: '20', SEAL_INTERVAL_MS: '3600000', ...vars }
  let last = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    const [port, inspector] = [await freePort(), await freePort()]
    const proc = { child: undefined as ChildProcess | undefined }
    const started = await boot(proc, port, inspector, state, all)
    if (started === true) {
      return {
        base: `http://127.0.0.1:${port}`,
        stop: async () => {
          const child = proc.child!
          if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 3000) }) }
          rmSync(state, { recursive: true, force: true })
        },
      }
    }
    last = started
    if (!/Address already in use|EADDRINUSE/.test(last)) break // only port collisions between parallel test files are retried
  }
  rmSync(state, { recursive: true, force: true })
  throw new Error(`wrangler did not start: ${last.slice(-2000)}`)
}

/** Start `wrangler dev` into `proc.child` and wait until it answers. Returns true, or the log when it failed. */
async function boot(proc: { child?: ChildProcess }, port: number, inspector: number, state: string, vars: Record<string, string>): Promise<true | string> {
  const args = ['wrangler', 'dev', '--local', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', state, '--log-level', 'warn', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])]
  const child = spawn('npx', args, { cwd: join(dirname(fileURLToPath(import.meta.url)), '../..'), stdio: ['ignore', 'pipe', 'pipe'] })
  proc.child = child
  let log = ''
  child.stdout!.on('data', d => { log += d }); child.stderr!.on('data', d => { log += d })
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) return log
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true } catch {}
    if (Date.now() > deadline) { child.kill('SIGTERM'); return `timeout: ${log}` }
    await new Promise(r => setTimeout(r, 250))
  }
}

/** Publish everything buffered, through the API (the Publish RPC). */
export const publish = (base: string, project: string) => call(base, ADMIN_TOKEN, 'Publish', { project })

export async function newProject(base: string, name: string) {
  const created = await call(base, ADMIN_TOKEN, 'CreateProject', { name: name.replace(/-/g, '_') })
  const sk = (await call(base, ADMIN_TOKEN, 'CreateKey', { project: created.project.id, scope: 'secret' })).key.key!
  return { id: created.project.id, pk: created.publishableKey, sk }
}

export interface Archive { seq: number; raw: string; bytes: Buffer; envelopes: any[]; records: any[] }
/** Download every archive with the project's secret key. `envelopes` are the stored lines, `records` the client records inside them. */
export async function readArchives(base: string, project: string, sk: string): Promise<Archive[]> {
  const out: Archive[] = []
  let after: number | undefined
  for (;;) {
    const page = await call(base, sk, 'ListArchives', { project, ...(after !== undefined ? { after } : {}) })
    for (const a of page.archives) {
      const bytes = Buffer.from(await (await fetch(`${base}/v1/projects/${project}/archives/${a.seq}`, { headers: { Authorization: `Bearer ${sk}` } })).arrayBuffer())
      const raw = gunzipSync(bytes).toString()
      const envelopes = raw.trim() === '' ? [] : raw.trim().split('\n').map(l => JSON.parse(l))
      out.push({ seq: a.seq, raw, bytes, envelopes, records: envelopes.map(e => e.record) })
    }
    if (page.next === undefined) return out
    after = page.next
  }
}
export const records = (arcs: Archive[]) => arcs.flatMap(a => a.records)
/** An envelope line is `{"received_at":..,"sender":..,["geo":..,]"record":..}`; all of them across archives. */
export const envelopes = (arcs: Archive[]) => arcs.flatMap(a => a.envelopes)
/** Publish, then read everything back. */
export async function archived(base: string, p: { id: string; sk: string }): Promise<Archive[]> {
  await publish(base, p.id)
  return readArchives(base, p.id, p.sk)
}
export const randomName = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}`
