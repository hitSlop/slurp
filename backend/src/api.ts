import type { ApiKey, Coverage, ErrorCode, ProjectInfo } from './api.gen.ts'
import { type Auth, MIN_ADMIN_TOKEN, adminConfigured } from './auth.ts'
import type { Config } from './config.ts'
import { type Handlers } from './client.ts'
import { providerList, providerOf, isObject } from './compat/providers.ts'
import { archiveKey } from './publisher.ts'
import type { KeyRow } from './project.ts'
import type { ProjectRow, Result } from './registry.ts'
import { type Env, randomHex } from './util.ts'

/** The control API (docs/contracts.md, "Control API"): one handler per method, typed by `Handlers` so none can be missing. */
export interface Ctx { env: Env; cfg: Config; auth: Auth | null; origin: string }

export class ApiFailure extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) { super(message); this.code = code }
}
const STATUS: Record<ErrorCode, number> = { invalid_argument: 400, unauthenticated: 401, forbidden: 403, not_found: 404, already_exists: 409, unavailable: 503 }
const bad = (message: string) => new ApiFailure('invalid_argument', message)

// ---- request fields: small checks, since the handlers receive whatever JSON was sent ----
type Req = Record<string, unknown>
const bytes = (s: string) => new TextEncoder().encode(s).length
function text(r: Req, k: string, max = 200): string {
  const v = r[k]
  if (typeof v !== 'string' || v === '') throw bad(`${k} must be a non-empty string`)
  if (bytes(v) > max) throw bad(`${k} is too long`)
  return v
}
const optText = (r: Req, k: string, max?: number) => (r[k] === undefined ? undefined : text(r, k, max))
function optInt(r: Req, k: string, min: number, max: number): number | undefined {
  const v = r[k]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${k} must be an integer from ${min} to ${max}`)
  return v
}
function optOneOf<T extends string>(r: Req, k: string, values: readonly T[]): T | undefined {
  const v = r[k]
  if (v === undefined) return undefined
  if (!values.includes(v as T)) throw bad(`${k} must be ${values.join(' or ')}`)
  return v as T
}

// ---- authorization ----
function needAdmin(c: Ctx) {
  if (!adminConfigured(c.env)) throw new ApiFailure('unavailable', `ADMIN_TOKEN is not configured (needs at least ${MIN_ADMIN_TOKEN} characters)`)
  if (!c.auth) throw new ApiFailure('unauthenticated', 'a bearer token is required')
  if (c.auth.kind !== 'admin') throw new ApiFailure('forbidden', 'the admin token is required')
}
/** Admin, or the secret key of this project. */
function needRead(c: Ctx, project: string) {
  if (!c.auth) throw new ApiFailure('unauthenticated', 'a bearer token is required')
  if (c.auth.kind === 'key' && (c.auth.scope !== 'secret' || c.auth.project !== project)) throw new ApiFailure('forbidden', "this key cannot read that project's archives")
}

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
export const projectStub = (env: Env, id: string) => env.PROJECT.get(env.PROJECT.idFromName(id))

const unwrap = <T>(r: Result<T>): T => {
  if (r.ok) return r.value
  throw new ApiFailure(r.code === 'notfound' ? 'not_found' : r.code === 'exists' ? 'already_exists' : r.code === 'unavailable' ? 'unavailable' : 'invalid_argument', r.message)
}
async function resolve(c: Ctx, ref: string): Promise<ProjectRow> {
  const row = await registry(c.env).get(ref)
  if (!row) throw new ApiFailure('not_found', `no project ${ref}`)
  return row
}
const info = (p: ProjectRow): ProjectInfo => ({ id: p.id, name: p.name, ...(p.title ? { title: p.title } : {}), createdAt: p.created_at })
/** A key as the API shows it. A publishable key can always be shown again; a secret key only when it is first created (`reveal`). */
const keyInfo = (project: string, k: KeyRow, reveal = false): ApiKey => ({
  keyId: k.key_id, project, scope: k.scope,
  ...(k.source ? { source: k.source } : {}), ...(k.name ? { name: k.name } : {}),
  createdAt: k.created_at, ...(k.revoked_at ? { revokedAt: k.revoked_at } : {}),
  ...(k.plain && (k.scope === 'publishable' || reveal) ? { key: k.plain } : {}),
})
const ingestUrl = (c: Ctx) => `${c.origin}/v1/events`

export const handlers: Handlers<Ctx> = {
  async Whoami(c) {
    if (!c.auth) throw new ApiFailure('unauthenticated', 'a bearer token is required')
    if (c.auth.kind === 'admin') return { scope: 'admin' }
    return { scope: c.auth.scope, project: c.auth.project, ...(c.auth.source ? { source: c.auth.source } : {}), ...(c.auth.name ? { name: c.auth.name } : {}) }
  },

  // Two steps that can each be repeated: claim the name in the registry, then set up the project's own object. A crash in between is
  // finished by calling this again.
  async CreateProject(c, r) {
    needAdmin(c)
    const claimed = unwrap(await registry(c.env).claim({ name: text(r, 'name', 63), title: optText(r, 'title') }))
    const key = unwrap(await projectStub(c.env, claimed.project.id).init())
    return { project: info(claimed.project), created: claimed.created, publishableKey: key.plain!, ingestUrl: ingestUrl(c) }
  },
  async GetProject(c, r) {
    needAdmin(c)
    return { project: info(await resolve(c, text(r, 'project'))), ingestUrl: ingestUrl(c) }
  },
  async ListProjects(c) {
    needAdmin(c)
    return { projects: (await registry(c.env).list()).map(info) }
  },

  async SourceKey(c, r) {
    needAdmin(c)
    const p = await resolve(c, text(r, 'project'))
    return { key: keyInfo(p.id, unwrap(await projectStub(c.env, p.id).sourceKey(text(r, 'source')))) }
  },
  async CreateKey(c, r) {
    needAdmin(c)
    const p = await resolve(c, text(r, 'project'))
    const scope = optOneOf(r, 'scope', ['publishable', 'secret'] as const)
    if (!scope) throw bad('scope must be publishable or secret')
    return { key: keyInfo(p.id, unwrap(await projectStub(c.env, p.id).createKey(scope, optText(r, 'source'), optText(r, 'name'))), true) }
  },
  async ListKeys(c, r) {
    needAdmin(c)
    const p = await resolve(c, text(r, 'project'))
    return { keys: unwrap(await projectStub(c.env, p.id).listKeys(optOneOf(r, 'scope', ['publishable', 'secret'] as const))).map(k => keyInfo(p.id, k)) }
  },
  async RevokeKey(c, r) {
    needAdmin(c)
    const p = await resolve(c, text(r, 'project'))
    return { key: keyInfo(p.id, unwrap(await projectStub(c.env, p.id).revokeKey(text(r, 'keyId')))) }
  },

  async ConnectWebhook(c, r) {
    needAdmin(c)
    const name = text(r, 'provider')
    const provider = providerOf(name)
    if (!provider) throw bad(`provider must be ${providerList()}`)
    const p = await resolve(c, text(r, 'project'))
    const given = optText(r, 'secret', 500) ?? null
    if (given !== null && (provider.secret === 'generated' || !provider.secret.issued.test(given)))
      throw bad(provider.secret === 'generated' ? `${name} does not take a secret: Slurp generates it` : provider.secret.hint)
    const fresh = provider.secret === 'generated' ? randomHex(32) : ''
    const hook = unwrap(await projectStub(c.env, p.id).connectWebhook(name, fresh, given))
    return { provider: name, url: `${c.origin}/hooks/${name}?key=${hook.key}`, secret: hook.secret, sender: name, steps: provider.steps }
  },

  async ListArchives(c, r) {
    if (!c.auth) throw new ApiFailure('unauthenticated', 'a bearer token is required')
    const p = await resolve(c, text(r, 'project'))
    needRead(c, p.id)
    return unwrap(await projectStub(c.env, p.id).archives(optInt(r, 'after', 0, Number.MAX_SAFE_INTEGER), optInt(r, 'limit', 1, 5000) ?? 1000))
  },
  async Publish(c, r) {
    needAdmin(c)
    const p = await resolve(c, text(r, 'project'))
    let published: Result<Coverage>
    try { published = await projectStub(c.env, p.id).publish() } catch (e) {
      console.error('publish failed', e)
      throw new ApiFailure('unavailable', 'archive storage is unavailable; the events are kept and will be published later')
    }
    return { coverage: unwrap(published) }
  },
}

/** `POST /v1/rpc/<Method>`. */
export async function rpc(req: Request, c: Ctx, method: string): Promise<Response> {
  const fail = (e: ApiFailure) => Response.json({ error: { code: e.code, message: e.message } }, { status: STATUS[e.code] })
  if (req.method !== 'POST') return Response.json({ error: { code: 'invalid_argument', message: 'use POST' } }, { status: 405, headers: { Allow: 'POST' } })
  if (!Object.hasOwn(handlers, method)) return fail(new ApiFailure('not_found', `unknown method ${method}`))
  try {
    const raw = (await req.text()).trim()
    let body: unknown = {}
    if (raw !== '') try { body = JSON.parse(raw) } catch { throw bad('the body must be JSON') }
    if (!isObject(body)) throw bad('the body must be a JSON object')
    return Response.json(await (handlers as unknown as Record<string, (c: Ctx, r: Req) => Promise<unknown>>)[method](c, body))
  } catch (e) {
    if (e instanceof ApiFailure) return fail(e)
    console.error(`${method} failed`, e)
    return fail(new ApiFailure('unavailable', 'storage is unavailable'))
  }
}

/** `GET|HEAD /v1/projects/<id>/archives/<seq>`: the archive's gzip bytes, for the admin or that project's secret key. */
export async function download(req: Request, c: Ctx, project: string, seq: string): Promise<Response> {
  const plain = (status: number, message: string) => new Response(message, { status })
  try { needRead(c, project) } catch (e) { return plain(STATUS[(e as ApiFailure).code], (e as ApiFailure).message) }
  const n = /^\d{1,15}$/.test(seq) ? Number(seq) : 0
  const found = n >= 1 ? await projectStub(c.env, project).hasArchive(n) : { ok: true as const, value: false }
  if (!found.ok) return plain(STATUS.unavailable, found.message)
  if (!found.value) return plain(404, 'no such archive')
  const key = archiveKey(project, n)
  const obj = req.method === 'HEAD' ? await c.env.ARCHIVE.head(key) : await c.env.ARCHIVE.get(key)
  if (!obj) return plain(404, 'no such archive')
  return new Response(req.method === 'HEAD' ? null : (obj as R2ObjectBody).body, {
    headers: { 'content-type': 'application/gzip', 'content-length': String(obj.size), etag: obj.httpEtag, 'cache-control': 'private, no-transform' },
  })
}
