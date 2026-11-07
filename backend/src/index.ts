import { type Env, sha256Hex, hmacHex, timingSafeEqual, b64url, fromB64url } from './util.ts'
import { normalizeGeo } from './canonical.ts'
import { setupPage } from './landing.ts'
import * as w from './slurp.gen.ts'
import type { ProjectRow, Result } from './registry.ts'
import type { KeyRow } from './project.ts'
import type { CompatHost } from './compat/common.ts'
import { segmentIngest, segmentRoute } from './compat/segment.ts'
import { sentryIngest, sentryRoute } from './compat/sentry.ts'
export { RegistryDO } from './registry.ts'
export { ProjectDO } from './project.ts'

type Principal = { kind: 'admin' } | { kind: 'key'; project: string; scope: string; keyId: string; name: string; geo: boolean } | null
interface Ctx { env: Env; principal: Principal; origin: string }

const MIN_ADMIN_TOKEN = 20
const DEFAULT_MAX_BODY = 10 * 1024 * 1024
const SIGNED_URL_TTL_S = 3600

const bearer = (req: Request) => /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
const projectDO = (env: Env, id: string) => env.PROJECT.get(env.PROJECT.idFromName(id))
// A key names its project, so a request goes straight to that project's own object. Hex only: no character needs escaping anywhere.
const KEY = /^slurp_(?:pk|sk)_([0-9a-f]{16})_[0-9a-f]{48}$/

/** The credential on a request: the bearer token, or (ingest only) one publishable key in the query string. */
function presentedToken(req: Request, allowQueryKey: boolean): string | null | undefined {
  let token = bearer(req)
  if (allowQueryKey) {
    const q = new URL(req.url).searchParams.getAll('key')
    // Query credentials are publishable only, even when a valid header is also supplied.
    if (q.length) { if (q.length !== 1 || !q[0].startsWith('slurp_pk_')) return undefined; token = q[0] }
  }
  return token
}

async function authenticate(req: Request, env: Env, allowQueryKey = false): Promise<Principal> {
  const token = presentedToken(req, allowQueryKey)
  return token ? principalFor(token, env) : null
}

async function principalFor(token: string | null, env: Env): Promise<Principal> {
  if (!token) return null
  if (isAdmin(token, env)) return { kind: 'admin' }
  const m = KEY.exec(token)
  if (!m) return null
  const project = 'prj_' + m[1]
  const a = await projectDO(env, project).authorize(token)
  return a ? { kind: 'key', project, ...a } : null
}
const isAdmin = (token: string, env: Env) => !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN)

const signingSecret = (env: Env) => hmacHex(env.ADMIN_TOKEN, 'slurp-object-url-v1')

const unwrap = <T>(r: Result<T>): T => {
  if (r.ok) return r.value
  if (r.code === 'notfound') throw new w.NotFoundError()
  if (r.code === 'exists') throw new w.AlreadyExistsError()
  throw new w.InvalidArgumentError({ cause: r.message })
}
const needAdmin = (c: Ctx) => {
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < MIN_ADMIN_TOKEN)
    throw new w.UnavailableError({ cause: `ADMIN_TOKEN is not configured (needs at least ${MIN_ADMIN_TOKEN} characters)` })
  if (!c.principal) throw new w.UnauthenticatedError()
  if (c.principal.kind !== 'admin') throw new w.ForbiddenError()
}
const info = (s: ProjectRow): w.ProjectInfo => ({ id: s.id, name: s.name, title: s.title ?? undefined, createdAt: s.created_at })
const keyInfo = (project: string, k: KeyRow): w.ApiKey => ({ keyId: k.key_id, project, scope: k.scope, name: k.name, createdAt: k.created_at, revokedAt: k.revoked_at ?? undefined, key: k.plain ?? undefined })
const ingestUrl = (c: Ctx) => `${c.origin}/v1/events`

async function resolveOrThrow(c: Ctx, ref: string): Promise<ProjectRow> {
  const s = await registry(c.env).get(ref)
  if (!s) throw new w.NotFoundError()
  return s
}

const projectService: w.ProjectServer<Ctx> = {
  async getProject(c, r) {
    needAdmin(c)
    const s = await resolveOrThrow(c, r.project)
    return { project: info(s), ingestUrl: ingestUrl(c), geoEnabled: await projectDO(c.env, s.id).geoEnabled() }
  },
  async updateProject(c, r) {
    needAdmin(c)
    const s = unwrap(await registry(c.env).update(r.project, r))
    const stub = projectDO(c.env, s.id)
    if (r.geoEnabled !== undefined) await stub.setGeo(r.geoEnabled)
    return { project: info(s), geoEnabled: await stub.geoEnabled() }
  },
  async listProjects(c) { needAdmin(c); return { projects: (await registry(c.env).list()).map(info) } },
  // Two steps that can each be repeated: claim the name in the registry, then set up the project's own object. A crash in
  // between is finished by calling this again.
  async createProject(c, r) {
    needAdmin(c)
    const claimed = unwrap(await registry(c.env).claim(r))
    const { key } = await projectDO(c.env, claimed.project.id).init(!!r.geoEnabled)
    return { project: info(claimed.project), created: claimed.created, publishableKey: key, ingestUrl: ingestUrl(c) }
  },
  async createKey(c, r) {
    needAdmin(c)
    const s = await resolveOrThrow(c, r.project)
    return unwrap(await projectDO(c.env, s.id).createKey(r.scope, r.name ?? ''))
  },
  async listKeys(c, r) {
    needAdmin(c)
    const s = await resolveOrThrow(c, r.project)
    if (r.scope !== undefined && r.scope !== 'publishable' && r.scope !== 'secret') throw new w.InvalidArgumentError({ cause: 'scope must be publishable or secret' })
    return { keys: (await projectDO(c.env, s.id).listKeys(r.scope)).map(k => keyInfo(s.id, k)) }
  },
  async revokeKey(c, r) {
    needAdmin(c)
    const s = await resolveOrThrow(c, r.project)
    return { key: keyInfo(s.id, unwrap(await projectDO(c.env, s.id).revokeKey(r.keyId))) }
  },
}

const healthService: w.HealthServer<Ctx> = {
  async version() { return { server: 'slurp-worker', schema: w.WebrpcSchemaVersion, webrpc: w.WebrpcVersion } },
}

async function signedUrl(c: Ctx, r2key: string): Promise<{ url: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S
  const sig = await hmacHex(await signingSecret(c.env), `${r2key}\n${exp}`)
  return { url: `${c.origin}/v1/objects/${b64url(new TextEncoder().encode(r2key))}?exp=${exp}&sig=${sig}`, exp }
}
const iso = (ms: number) => new Date(ms).toISOString()

async function archiveAuth(c: Ctx, ref: string): Promise<ProjectRow> {
  if (!c.principal) throw new w.UnauthenticatedError()
  const s = await resolveOrThrow(c, ref)
  if (c.principal.kind === 'key' && (c.principal.scope !== 'secret' || c.principal.project !== s.id)) throw new w.ForbiddenError()
  return s
}
/** The archive retention window in seconds; 0 means archives are kept until they are deleted. */
const retentionSeconds = (env: Env) => (Number(env.RETENTION_DAYS) > 0 ? Number(env.RETENTION_DAYS) * 86400 : 0)
const covOut = (c: Ctx, cov: { archiveId: string; firstRetained: string; latestPublished: string; latestPublishedAt: number }): w.Coverage =>
  ({ archiveId: cov.archiveId, firstRetained: cov.firstRetained, latestPublished: cov.latestPublished, latestPublishedAt: iso(cov.latestPublishedAt), retentionSeconds: retentionSeconds(c.env) })

const archiveService: w.ArchiveServer<Ctx> = {
  async listObjects(c, r) {
    const s = await archiveAuth(c, r.project)
    const limit = Math.min(Math.max(r.limit ?? 1000, 1), 5000)
    if (r.after != null && !/^\d+$/.test(r.after)) throw new w.InvalidArgumentError({ cause: 'after must be a decimal sequence' })
    const sd = projectDO(c.env, s.id)
    const cov = await sd.coverage()
    if (!cov) return { objects: [] }
    if (r.after != null && Number(r.after) + 1 < Number(cov.firstRetained)) throw new w.RetentionGapError()
    const after = r.after != null ? Number(r.after) : Number(cov.firstRetained) - 1
    const rows = await sd.listObjects(after, limit + 1)
    const page = rows.slice(0, limit)
    let expiresAt = 0
    const objects: w.ArchiveObject[] = []
    for (const m of page) {
      const { url, exp } = await signedUrl(c, m.r2key)
      expiresAt = exp * 1000
      objects.push({ seq: String(m.seq), name: m.name, size: m.size, sha256: m.sha256, url })
    }
    return { coverage: covOut(c, cov), objects, nextAfter: rows.length > limit ? String(page[page.length - 1].seq) : undefined, expiresAt: expiresAt ? iso(expiresAt) : undefined }
  },
  async getCoverage(c, r) {
    const s = await archiveAuth(c, r.project)
    const stub = projectDO(c.env, s.id)
    const cov = await stub.coverage()
    const st = await stub.stats()
    const publication = { state: st.pending ? 'pending' : 'idle', observedAt: iso(Date.now()), intervalSeconds: Math.round(Number(c.env.SEAL_INTERVAL_MS) / 1000), ...(st.pending && st.alarm !== null ? { estimatedAt: iso(st.alarm) } : {}) }
    return { coverage: cov ? covOut(c, cov) : undefined, publication }
  },
}

// Auth: a self-hosted Worker has no logins or sessions, only the admin token and per-project keys. Whoami says which one a bearer is.
const authService: w.AuthServer<Ctx> = {
  async whoami(c) {
    const p = c.principal
    if (!p) throw new w.UnauthenticatedError()
    return p.kind === 'admin' ? { scope: 'admin' } : { scope: p.scope, project: p.project, name: p.name }
  },
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After, Slurp-Duplicate' }
const jsonError = (status: number, error: string, extra: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...CORS, ...extra } })

async function ingest(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '86400' } })
  if (req.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST, OPTIONS' })
  const token = presentedToken(req, true)
  if (!token) return jsonError(401, 'invalid token')
  if (isAdmin(token, env)) return jsonError(403, 'publishable key required')
  const m = KEY.exec(token)
  if (!m) return jsonError(401, 'invalid token')
  const max = Number(env.MAX_BODY_BYTES) > 0 ? Number(env.MAX_BODY_BYTES) : DEFAULT_MAX_BODY
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > max) return jsonError(413, 'body too large')
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.length > max) return jsonError(413, 'body too large')
  // Geo comes only from Cloudflare's own request metadata, never from client-supplied headers; the project drops it unless it opted in.
  const geo = normalizeGeo((req as Request & { cf?: any }).cf)
  let res
  try { res = await projectDO(env, 'prj_' + m[1]).ingestKey(token, body, geo) } catch (e) {
    console.error('ingest failed', e)
    return jsonError(503, 'unavailable', { 'Retry-After': '5' })
  }
  if (!res.ok) return jsonError(res.status, res.reason, res.retryAfter ? { 'Retry-After': String(res.retryAfter) } : {})
  return Response.json({ ok: true, publication: res.publication }, { headers: { ...CORS, ...(res.duplicate ? { 'Slurp-Duplicate': '1' } : {}) } })
}

async function download(req: Request, env: Env, token: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
  const u = new URL(req.url)
  const exp = Number(u.searchParams.get('exp'))
  const sig = u.searchParams.get('sig') ?? ''
  let r2key: string
  try { r2key = new TextDecoder().decode(fromB64url(token)) } catch { return new Response('bad token', { status: 400 }) }
  if (!exp || exp < Date.now() / 1000) return new Response('expired', { status: 403 })
  if (!timingSafeEqual(sig, await hmacHex(await signingSecret(env), `${r2key}\n${exp}`))) return new Response('bad signature', { status: 403 })
  const obj = await env.ARCHIVE.get(r2key)
  if (!obj) return new Response('not found', { status: 404 })
  return new Response(req.method === 'HEAD' ? null : obj.body, { headers: { 'content-type': 'application/gzip', 'content-length': String(obj.size), etag: obj.httpEtag, 'cache-control': 'private, no-transform' } })
}

/** Admin only. Deletes all data so the Worker and bucket can be removed: every project's archives and storage, any stray R2 objects, and the registry. */
async function purge(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST' })
  if (ctx.principal?.kind !== 'admin') return jsonError(ctx.principal ? 403 : 401, ctx.principal ? 'admin token required' : 'invalid token')
  const body = (await req.json().catch(() => ({}))) as { confirm?: string }
  if (body.confirm !== 'delete-all-data') return jsonError(400, 'send {"confirm":"delete-all-data"} to confirm')
  const reg = registry(env)
  const projects = await reg.list()
  let archives = 0
  for (const s of projects) archives += (await projectDO(env, s.id).purge()).archives
  let strays = 0
  for (;;) {
    const page = await env.ARCHIVE.list({ limit: 1000 })
    if (page.objects.length === 0) break
    await env.ARCHIVE.delete(page.objects.map(o => o.key))
    strays += page.objects.length
  }
  await reg.purge()
  return Response.json({ ok: true, projects: projects.length, archives, strays })
}

/** Segment-compatible and Sentry-compatible endpoints reuse the same key check and ingest path. */
function compatHost(env: Env): CompatHost {
  return {
    async publishable(token) {
      if (!token?.startsWith('slurp_pk_')) return null
      const p = await principalFor(token, env)
      return p?.kind === 'key' && p.scope === 'publishable' ? { project: p.project, sender: p.name, geo: p.geo } : null
    },
    ingest: (p, body, geo) => projectDO(env, p.project).ingest(p.sender, body, geo),
    geoFor: (req, geo) => (geo ? normalizeGeo((req as Request & { cf?: any }).cf) : null),
    maxBody: Number(env.MAX_BODY_BYTES) > 0 ? Number(env.MAX_BODY_BYTES) : DEFAULT_MAX_BODY,
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/v1/events') return ingest(req, env)
    const sentry = sentryRoute(url.pathname)
    if (sentry) {
      try { return await sentryIngest(req, sentry, compatHost(env)) } catch (e) {
        console.error('sentry ingest failed', e)
        return jsonError(503, 'unavailable', { 'Retry-After': '5' })
      }
    }
    const segment = segmentRoute(req.method, url.pathname)
    if (segment) {
      try { return await segmentIngest(req, segment, compatHost(env)) } catch (e) {
        console.error('segment ingest failed', e)
        return jsonError(503, 'unavailable', { 'Retry-After': '5' })
      }
    }
    if (url.pathname.startsWith('/v1/objects/')) return download(req, env, url.pathname.slice('/v1/objects/'.length))
    if (url.pathname === '/healthz') return new Response('ok\n')
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD'))
      return new Response(req.method === 'HEAD' ? null : setupPage(url.origin, !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } })
    if (url.pathname === '/v1/health')
      return Response.json({ ok: true, apiVersion: w.WebrpcSchemaVersion, capabilities: { sink: 'durable-object', archive: 'jsonl.gz', geo: true }, configured: !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN, build: env.SLURP_BUILD ?? null })
    const ctx: Ctx = { env, principal: await authenticate(req, env), origin: url.origin }
    if (url.pathname === '/v1/admin/purge') return purge(req, env, ctx)
    if (env.DEBUG === '1' && ctx.principal?.kind === 'admin' && url.pathname.startsWith('/__debug/')) {
      const [, , op, id] = url.pathname.split('/')
      const stub = projectDO(env, id)
      if (op === 'flush') { await stub.flush(); return Response.json(await stub.stats()) }
      if (op === 'seal') { await stub.flush(); return Response.json(await stub.seal()) }
      if (op === 'rotate') { await stub.flush(); return Response.json(await stub.rotate()) }
      if (op === 'sweep') { await stub.sweep(); return Response.json(await stub.stats()) }
      if (op === 'fail-flush') { await stub.failNextFlush(); return Response.json({ ok: true }) }
      if (op === 'stats') return Response.json(await stub.stats())
    }
    return (await w.serveHealthRpc(healthService, ctx, req))
      ?? (await w.serveProjectRpc(projectService, ctx, req))
      ?? (await w.serveArchiveRpc(archiveService, ctx, req))
      ?? (await w.serveAuthRpc(authService, ctx, req))
      ?? new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
