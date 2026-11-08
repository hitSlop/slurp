// Shared helpers for the tests that run inside workerd (Vitest + @cloudflare/vitest-plugin). Everything that reaches inside a Durable
// Object by field name lives here, so a rename in src/ is fixed in one place.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { expect } from 'vitest'
import { projectStub } from '../../src/api.ts'
import { ApiError } from '../../src/client.ts'
import type { Api } from '../../src/api.gen.ts'
import { parseConfig } from '../../src/config.ts'
import worker from '../../src/index.ts'

export { ApiError }

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'
export const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` }
/** The origin the tests talk to; the Worker sees it as the request URL. */
export const BASE = 'https://slurp.test'
export const HOUR = 3_600_000
export const DAY = 86_400_000

// ---- assertions: node:assert's names on top of Vitest's expect, so the test bodies read as they did under node --test ----

/** Why `node:assert` is not imported: it needs the nodejs_compat flag, which the production Worker does not use. */
export const assert = {
  equal: (actual: unknown, expected: unknown, message?: string) => { expect(actual, message).toBe(expected) },
  notEqual: (actual: unknown, expected: unknown, message?: string) => { expect(actual, message).not.toBe(expected) },
  deepEqual: (actual: unknown, expected: unknown, message?: string) => { expect(actual, message).toStrictEqual(expected) },
  ok: (value: unknown, message?: string) => { expect(value, message).toBeTruthy() },
  match: (actual: unknown, pattern: RegExp, message?: string) => { expect(actual, message).toMatch(pattern) },
  throws: (fn: () => unknown, pattern?: RegExp) => { expect(fn).toThrow(pattern) },
  /** Like node's: the promise must reject, and `validate` (a predicate on the error) must accept it. */
  async rejects(promise: Promise<unknown>, validate?: ((error: any) => boolean) | RegExp, message?: string) {
    let error: unknown, rejected = false
    try { await promise } catch (e) { error = e; rejected = true }
    expect(rejected, message ?? 'the promise should have rejected').toBe(true)
    if (typeof validate === 'function') expect(validate(error), message ?? `the rejection was not the expected one: ${error}`).toBe(true)
    else if (validate) expect(String(error)).toMatch(validate)
  },
}

// ---- HTTP through the Worker's own fetch handler ----

type Init = Omit<RequestInit, 'body'> & { body?: BodyInit | null; cf?: object }

/**
 * Send a request to the Worker's default export, with `env` or with a copy of it that changes Worker-level settings (MAX_BODY_BYTES, GEO).
 * The body is read to the end before returning (workerd requires it) and handed back again, so callers read it as usual.
 */
function sender(handler: (req: Request) => Promise<Response>) {
  return async (path: string, init: Init = {}): Promise<Response> => {
    const res = await handler(new Request(path.startsWith('http') ? path : `${BASE}${path}`, init as RequestInit))
    const body = await res.arrayBuffer()
    return new Response([204, 205, 304].includes(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}
/** `fetch` against the Worker as deployed (the settings in wrangler.jsonc and vitest.config.ts). */
export const http = sender(req => exports.default.fetch(req))
/** `fetch` against the Worker with some of its variables changed. Project-level settings are changed per object with `withConfig`. */
export const httpWith = (vars: Record<string, string>) => {
  const changed = { ...env, ...vars } as typeof env // a new object, so the settings are parsed afresh
  return sender(req => worker.fetch(req, changed))
}

/** The typed control API call, through the Worker. Throws `ApiError` as `src/client.ts` does. */
export async function call<M extends keyof Api>(token: string, method: M, req: Api[M]['req']): Promise<Api[M]['res']> {
  const response = await http(`/v1/rpc/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(req) })
  const text = await response.text()
  if (!response.ok) {
    let body: any
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    throw new ApiError(response.status, body?.error?.code, body?.error?.message ?? text.slice(0, 200))
  }
  return JSON.parse(text)
}

/** A valid record: only `event` is required; `id` makes a retry safe. */
export const evt = (id: string, extra: object = {}) => JSON.stringify({ id, type: 'track', event: 'signup', timestamp: '2026-11-06T00:00:00Z', data: { n: 1 }, ...extra })
/** `POST /v1/events` with a publishable key. */
export const post = (key: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  http('/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...headers }, body })
export const randomName = (prefix: string) => `${prefix}_${Math.random().toString(16).slice(2, 8)}`

export interface Project { id: string; pk: string; sk: string }
/** A new project (`label` plus a random suffix, so names never collide) with its default publishable key and a secret key. */
export async function newProject(label: string): Promise<Project> {
  const created = await call(ADMIN_TOKEN, 'CreateProject', { name: randomName(label.replace(/-/g, '_')) })
  const sk = (await call(ADMIN_TOKEN, 'CreateKey', { project: created.project.id, scope: 'secret' })).key.key!
  return { id: created.project.id, pk: created.publishableKey, sk }
}

/** Publish everything buffered, through the API. */
export const publish = (p: { id: string }) => call(ADMIN_TOKEN, 'Publish', { project: p.id })

export const gzip = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
export const hmacHex = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface Archive { seq: number; raw: string; bytes: Uint8Array; inflated: number; envelopes: any[]; records: any[] }
/** Download every archive with the project's secret key. `envelopes` are the stored lines, `records` the client records inside them. */
export async function archives(p: { id: string; sk: string }): Promise<Archive[]> {
  const out: Archive[] = []
  let after: number | undefined
  for (;;) {
    const page = await call(p.sk, 'ListArchives', { project: p.id, ...(after !== undefined ? { after } : {}) })
    for (const a of page.archives) {
      const bytes = new Uint8Array(await (await http(`/v1/projects/${p.id}/archives/${a.seq}`, { headers: { Authorization: `Bearer ${p.sk}` } })).arrayBuffer())
      const inflated = await gunzip(bytes)
      const raw = new TextDecoder().decode(inflated)
      const envelopes = raw.trim() === '' ? [] : raw.trim().split('\n').map(l => JSON.parse(l))
      out.push({ seq: a.seq, raw, bytes, inflated: inflated.length, envelopes, records: envelopes.map(e => e.record) })
    }
    if (page.next === undefined) return out
    after = page.next
  }
}
/** Publish, then read everything back. */
export async function archived(p: { id: string; sk: string }): Promise<Archive[]> {
  await publish(p)
  return archives(p)
}
export const ids = (arcs: Archive[]) => arcs.flatMap(a => a.records.map(r => r.id))
export const records = (arcs: Archive[]) => arcs.flatMap(a => a.records)
/** An envelope line is `{"received_at":..,"sender":..,["geo":..,]"record":..}`; all of them across archives. */
export const envelopes = (arcs: Archive[]) => arcs.flatMap(a => a.envelopes)
export const seqs = (arcs: { seq: number }[]) => arcs.map(a => a.seq)

// ---- inside a project's Durable Object ----

/** Run `fn` inside the project's object, with its instance (private fields included) and its storage. */
export const inside = <R>(p: string | { id: string }, fn: (instance: any, state: DurableObjectState) => R | Promise<R>): Promise<R> =>
  runInDurableObject(projectStub(env, typeof p === 'string' ? p : p.id), fn)
export const stubOf = (p: string | { id: string }) => projectStub(env, typeof p === 'string' ? p : p.id)
/** Run the object's alarm now, whatever time it is set for; true when it ran. The handler publishes only what is due. */
export const alarm = (p: string | { id: string }) => runDurableObjectAlarm(stubOf(p))
/** Rows of a query against the object's own tables. */
export const sql = <R = any>(p: string | { id: string }, query: string, ...bindings: SqlStorageValue[]) =>
  inside(p, (_i, state) => state.storage.sql.exec(query, ...bindings).toArray() as R[])
export const count = async (p: string | { id: string }, table: string, where = '1') => (await sql<{ n: number }>(p, `SELECT COUNT(*) n FROM ${table} WHERE ${where}`))[0].n
export const alarmAt = (p: string | { id: string }) => inside(p, (_i, state) => state.storage.getAlarm())
/** The `settings` table (failures, retry_at) as an object. */
export const settings = async (p: string | { id: string }) => Object.fromEntries((await sql<{ k: string; v: string }>(p, 'SELECT k, v FROM settings')).map(r => [r.k, r.v]))
/** What the object holds right now: the numbers the old `/__debug/stats` route reported. */
export const stats = (p: string | { id: string }) => inside(p, async (i, state) => {
  const n = (table: string, where = '1') => state.storage.sql.exec(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).one().n as number
  return {
    ready: i.ready as boolean,
    pending: i.coverage().pending as boolean,
    queued: i.queue.length as number,
    bufferedBytes: i.publisher.bufferedBytes as number,
    chunks: n('chunks'), manifest: n('manifest'), live: n('manifest', 'deleted_at IS NULL'),
    intent: (state.storage.sql.exec('SELECT seq, through_chunk FROM intent').toArray()[0] ?? null) as { seq: number; through_chunk: number } | null,
    alarm: await state.storage.getAlarm(),
    armed: i.publisher.armed as number | null,
    rowsWritten: i.db.rowsWritten as number,
    alarmWrites: i.db.alarmWrites as number,
  }
})

/**
 * Change the project's settings (the same variables as wrangler.jsonc). This REPLACES the Config on the object and on its Publisher,
 * and never changes the shared one: `configOf` caches a single Config per env, so mutating it would leak into every later object.
 */
export const withConfig = (p: string | { id: string }, vars: Record<string, string>) => inside(p, i => {
  const config = parseConfig({ ...env, ...vars })
  i.cfg = config
  i.publisher.cfg = config
})

/**
 * Make the stored facts older, so the schedule they imply is due without waiting: the chunks were committed `ms` earlier and the
 * archives published `ms` earlier (the alarm and retention both derive from these times).
 */
export const age = (p: string | { id: string }, ms: number) => inside(p, (_i, state) => {
  state.storage.sql.exec('UPDATE chunks SET at_ms = at_ms - ?', ms)
  state.storage.sql.exec('UPDATE manifest SET created_at = created_at - ?', ms)
})
/** Make a scheduled retry due by moving its stored time back (the retry time is a fact in `settings`). */
export const dueRetry = (p: string | { id: string }) => inside(p, (_i, state) => { state.storage.sql.exec("UPDATE settings SET v = CAST(v AS INTEGER) - 3600000 WHERE k = 'retry_at'") })

/** An R2 bucket whose writes fail: `put: 'throw'` before storing, `'after'` after storing (the object is in R2 but the manifest never hears), and `delete: 'throw'`. */
export function failingArchive(real: R2Bucket, mode: { put?: 'throw' | 'after'; delete?: 'throw' } = { put: 'throw' }): R2Bucket {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'put' && mode.put) return async (...a: Parameters<R2Bucket['put']>) => {
        if (mode.put === 'throw') throw new Error('injected archive failure')
        await target.put(...a)
        throw new Error('injected failure after the R2 put')
      }
      if (prop === 'delete' && mode.delete) return async () => { throw new Error('injected archive delete failure') }
      const v = (target as any)[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
/** Swap this object's bucket for a failing one, and back. Only this object is affected; a restart brings the real bucket back too. */
export const breakArchive = (p: string | { id: string }, mode?: Parameters<typeof failingArchive>[1]) => inside(p, i => { i.publisher.archive = failingArchive(env.ARCHIVE, mode) })
export const healArchive = (p: string | { id: string }) => inside(p, i => { i.publisher.archive = env.ARCHIVE })

/** Make the next group commit fail once (the chunk insert throws), as a full disk would. */
export const failNextCommit = (p: string | { id: string }) => inside(p, i => {
  const rows = i.db.rows
  i.db.rows = function (this: unknown, query: string, ...bindings: unknown[]) {
    if (/INSERT INTO chunks/.test(query)) { delete i.db.rows; throw new Error('injected commit failure') }
    return rows.call(i.db, query, ...bindings)
  }
})
/** Make the next `setAlarm` throw once. */
export const failNextSetAlarm = (p: string | { id: string }) => inside(p, (_i, state) => {
  const storage = state.storage as any
  storage.setAlarm = async () => { delete storage.setAlarm; throw new Error('injected alarm failure') }
})
