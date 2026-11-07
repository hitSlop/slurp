import { type Env, sha256Hex, hmacHex, timingSafeEqual, b64url, fromB64url } from './util.ts'
import { normalizeGeo } from './canonical.ts'
import { setupPage } from './landing.ts'
import * as w from './slurp.gen.ts'
import type { SourceRow, KeyRow, Result } from './registry.ts'
export { RegistryDO } from './registry.ts'
export { SourceDO } from './source.ts'

type Principal = { kind: 'admin' } | { kind: 'key'; source: string; scope: string; geo: boolean } | null
interface Ctx { env: Env; principal: Principal; origin: string }

const MIN_ADMIN_TOKEN = 20
const DEFAULT_MAX_BODY = 10 * 1024 * 1024
const SIGNED_URL_TTL_S = 3600
const RETENTION_FALLBACK_S = 90 * 86400

const bearer = (req: Request) => /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
const sourceDO = (env: Env, id: string) => env.SOURCE.get(env.SOURCE.idFromName(id))

// Key lookups are cached briefly per isolate; a revoked key stops working within this window.
const KEY_CACHE_MS = 5000
const keyCache = new Map<string, { exp: number; v: { source: string; scope: string; geo: boolean } | null }>()

async function authenticate(req: Request, env: Env, allowQueryKey = false): Promise<Principal> {
  let token = bearer(req)
  if (allowQueryKey) {
    const q = new URL(req.url).searchParams.getAll('key')
    // Query credentials are publishable only, even when a valid header is also supplied.
    if (q.length) { if (q.length !== 1 || !q[0].startsWith('slurp_pk_')) return null; token = q[0] }
  }
  if (!token) return null
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN)) return { kind: 'admin' }
  const hash = await sha256Hex(token)
  const hit = keyCache.get(hash)
  let v = hit && hit.exp > Date.now() ? hit.v : undefined
  if (v === undefined) {
    v = await registry(env).resolveKey(hash)
    keyCache.set(hash, { exp: Date.now() + KEY_CACHE_MS, v })
    if (keyCache.size > 1000) keyCache.delete(keyCache.keys().next().value!)
  }
  return v ? { kind: 'key', ...v } : null
}

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
const info = (s: SourceRow): w.SourceInfo => ({ id: s.id, name: s.name, title: s.title ?? undefined, ownerId: s.owner_id, createdAt: s.created_at, geoEnabled: !!s.geo_enabled, role: 'owner' })
const keyInfo = (k: KeyRow): w.ApiKey => ({ keyId: k.key_id, source: k.source, scope: k.scope, name: k.name, createdAt: k.created_at, revokedAt: k.revoked_at ?? undefined })
const ingestUrl = (c: Ctx) => `${c.origin}/v1/events`

async function resolveOrThrow(c: Ctx, ref: string): Promise<SourceRow> {
  const s = await registry(c.env).getSource(ref)
  if (!s) throw new w.NotFoundError()
  return s
}
const noMembers = (): never => { throw new w.ForbiddenError({ cause: 'memberships are not used by a self-hosted deployment; the admin token owns every source' }) }

const sourceService: w.SourceServer<Ctx> = {
  async getSource(c, r) { needAdmin(c); const s = await resolveOrThrow(c, r.source); return { source: info(s), ingestUrl: ingestUrl(c) } },
  async updateSource(c, r) { needAdmin(c); return { source: info(unwrap(await registry(c.env).updateSource(r.source, r))) } },
  async addMember() { return noMembers() },
  async removeMember() { return noMembers() },
  async listSources(c) { needAdmin(c); return { sources: (await registry(c.env).listSources()).map(info) } },
  async listMemberships() { return { memberships: [] } },
  async createSource(c, r) {
    needAdmin(c)
    const v = unwrap(await registry(c.env).createSource(r))
    return { source: info(v.source), publishableKey: v.key, ingestUrl: ingestUrl(c) }
  },
  async createKey(c, r) { needAdmin(c); return unwrap(await registry(c.env).createKey(r.source, r.scope, r.name)) },
  async listKeys(c, r) {
    needAdmin(c)
    const ks = await registry(c.env).listKeys(r.source, r.scope)
    if (!ks) throw new w.NotFoundError()
    return { keys: ks.map(keyInfo) }
  },
  async revokeKey(c, r) {
    needAdmin(c)
    const res = unwrap(await registry(c.env).revokeKey(r.source, r.keyId))
    keyCache.clear()
    return { key: keyInfo(res) }
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

async function archiveAuth(c: Ctx, ref: string): Promise<SourceRow> {
  if (!c.principal) throw new w.UnauthenticatedError()
  const s = await resolveOrThrow(c, ref)
  if (c.principal.kind === 'key' && (c.principal.scope !== 'secret' || c.principal.source !== s.id)) throw new w.ForbiddenError()
  return s
}
const retentionSeconds = (env: Env) => (Number(env.RETENTION_DAYS) > 0 ? Number(env.RETENTION_DAYS) * 86400 : RETENTION_FALLBACK_S)
const covOut = (c: Ctx, cov: { archiveId: string; firstRetained: string; latestPublished: string; latestPublishedAt: number }): w.Coverage =>
  ({ archiveId: cov.archiveId, firstRetained: cov.firstRetained, latestPublished: cov.latestPublished, latestPublishedAt: iso(cov.latestPublishedAt), retentionSeconds: retentionSeconds(c.env) })

const archiveService: w.ArchiveServer<Ctx> = {
  async listObjects(c, r) {
    const s = await archiveAuth(c, r.source)
    const limit = Math.min(Math.max(r.limit ?? 1000, 1), 5000)
    if (r.after != null && !/^\d+$/.test(r.after)) throw new w.InvalidArgumentError({ cause: 'after must be a decimal sequence' })
    const sd = sourceDO(c.env, s.id)
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
    const s = await archiveAuth(c, r.source)
    const stub = sourceDO(c.env, s.id)
    const cov = await stub.coverage()
    const st = await stub.stats()
    const publication = { state: st.alarm === null ? 'idle' : 'pending', observedAt: iso(Date.now()), intervalSeconds: Math.round(Number(c.env.SEAL_INTERVAL_MS) / 1000), ...(st.alarm !== null ? { estimatedAt: iso(st.alarm) } : {}) }
    return { coverage: cov ? covOut(c, cov) : undefined, publication }
  },
}

// Hosted-only services. Self-hosted deployments authenticate with the admin token, not a user session or billing plan.
const selfHosted = (what: string) => new w.UnavailableError({ cause: `${what} is not used by a self-hosted deployment` })
const authService: w.AuthServer<Ctx> = {
  async beginLogin() { throw selfHosted('browser login') },
  async pollLogin() { throw selfHosted('browser login') },
  async refresh() { throw selfHosted('token refresh') },
  async logout() { return { ok: true } },
  async currentUser(c) { needAdmin(c); return { user: { id: 'admin', email: 'admin@self-hosted' } } },
}
const usageService: w.UsageServer<Ctx> = { async getUsage() { throw selfHosted('usage metering') } }
const billingService: w.BillingServer<Ctx> = {
  async getStatus() { throw selfHosted('billing') },
  async createCheckout() { throw selfHosted('billing') },
  async createPortal() { throw selfHosted('billing') },
  async setLimit() { throw selfHosted('billing') },
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After, Slurp-Duplicate' }
const jsonError = (status: number, error: string, extra: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...CORS, ...extra } })

async function ingest(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '86400' } })
  if (req.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST, OPTIONS' })
  const p = await authenticate(req, env, true)
  if (!p) return jsonError(401, 'invalid token')
  if (p.kind !== 'key' || p.scope !== 'publishable') return jsonError(403, 'publishable key required')
  const max = Number(env.MAX_BODY_BYTES) > 0 ? Number(env.MAX_BODY_BYTES) : DEFAULT_MAX_BODY
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > max) return jsonError(413, 'body too large')
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.length > max) return jsonError(413, 'body too large')
  // Geo comes only from Cloudflare's own request metadata, never from client-supplied headers.
  const geo = p.geo ? normalizeGeo((req as Request & { cf?: any }).cf) : null
  let res
  try { res = await sourceDO(env, p.source).ingest(p.source, body, geo) } catch (e) {
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

/** Admin only. Deletes all data so the Worker and bucket can be removed: every source's archives and storage, any stray R2 objects, and the registry. */
async function purge(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST' })
  if (ctx.principal?.kind !== 'admin') return jsonError(ctx.principal ? 403 : 401, ctx.principal ? 'admin token required' : 'invalid token')
  const body = (await req.json().catch(() => ({}))) as { confirm?: string }
  if (body.confirm !== 'delete-all-data') return jsonError(400, 'send {"confirm":"delete-all-data"} to confirm')
  const reg = registry(env)
  const sources = await reg.listSources()
  let archives = 0
  for (const s of sources) archives += (await sourceDO(env, s.id).purge()).archives
  let strays = 0
  for (;;) {
    const page = await env.ARCHIVE.list({ limit: 1000 })
    if (page.objects.length === 0) break
    await env.ARCHIVE.delete(page.objects.map(o => o.key))
    strays += page.objects.length
  }
  await reg.purge()
  keyCache.clear()
  return Response.json({ ok: true, sources: sources.length, archives, strays })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/v1/events') return ingest(req, env)
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
      const stub = sourceDO(env, id)
      if (op === 'flush') { await stub.flush(); return Response.json(await stub.stats()) }
      if (op === 'seal') { await stub.flush(); return Response.json(await stub.seal()) }
      if (op === 'rotate') { await stub.flush(); return Response.json(await stub.rotate()) }
      if (op === 'sweep') { await stub.sweep(); return Response.json(await stub.stats()) }
      if (op === 'stats') return Response.json(await stub.stats())
    }
    return (await w.serveHealthRpc(healthService, ctx, req))
      ?? (await w.serveSourceRpc(sourceService, ctx, req))
      ?? (await w.serveArchiveRpc(archiveService, ctx, req))
      ?? (await w.serveAuthRpc(authService, ctx, req))
      ?? (await w.serveUsageRpc(usageService, ctx, req))
      ?? (await w.serveBillingRpc(billingService, ctx, req))
      ?? new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
