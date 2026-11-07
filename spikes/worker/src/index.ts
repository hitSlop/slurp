import { type Env, sha256Hex, hmacHex, timingSafeEqual, b64url, fromB64url } from './util.ts'
import * as w from './slurp.gen.ts'
import type { SourceRow, KeyRow, Result } from './registry.ts'
export { RegistryDO } from './registry.ts'
export { SourceDO } from './source.ts'

type Principal = { kind: 'admin' } | { kind: 'key'; source: string; scope: string } | null
interface Ctx { env: Env; principal: Principal; origin: string }

const bearer = (req: Request) => /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
const sourceDO = (env: Env, id: string) => env.SOURCE.get(env.SOURCE.idFromName(id))

async function authenticate(req: Request, env: Env, allowQueryKey = false): Promise<Principal> {
  const token = bearer(req) ?? (allowQueryKey ? new URL(req.url).searchParams.get('key') : null)
  if (!token) return null
  if (timingSafeEqual(token, env.ADMIN_TOKEN)) return { kind: 'admin' }
  const r = await registry(env).resolveKey(await sha256Hex(token))
  return r ? { kind: 'key', source: r.source, scope: r.scope } : null
}

const unwrap = <T>(r: Result<T>): T => {
  if (r.ok) return r.value
  if (r.code === 'notfound') throw new w.NotFoundError()
  if (r.code === 'exists') throw new w.AlreadyExistsError()
  throw new w.InvalidArgumentError({ cause: r.message })
}
const needAdmin = (c: Ctx) => { if (!c.principal) throw new w.UnauthenticatedError(); if (c.principal.kind !== 'admin') throw new w.ForbiddenError() }
const info = (s: SourceRow): w.SourceInfo => ({ id: s.id, name: s.name, title: s.title ?? undefined, ownerId: s.owner_id, createdAt: s.created_at, geoEnabled: !!s.geo_enabled, role: 'owner' })
const keyInfo = (k: KeyRow): w.ApiKey => ({ keyId: k.key_id, source: k.source, scope: k.scope, name: k.name, createdAt: k.created_at, revokedAt: k.revoked_at ?? undefined })
const ingestUrl = (c: Ctx) => `${c.origin}/v1/events`

async function resolveOrThrow(c: Ctx, ref: string): Promise<SourceRow> {
  const s = await registry(c.env).getSource(ref)
  if (!s) throw new w.NotFoundError()
  return s
}
const notMember = (): never => { throw new w.ForbiddenError({ cause: 'memberships are not used in self-hosted mode' }) }

const sourceService: w.SourceServer<Ctx> = {
  async getSource(c, r) { needAdmin(c); const s = await resolveOrThrow(c, r.source); return { source: info(s), ingestUrl: ingestUrl(c) } },
  async updateSource(c, r) {
    needAdmin(c); return { source: info(unwrap(await registry(c.env).updateSource(r.source, r))) }
  },
  async addMember() { return notMember() },
  async removeMember() { return notMember() },
  async listSources(c) { needAdmin(c); return { sources: (await registry(c.env).listSources()).map(info) } },
  async listMemberships() { return { memberships: [] } },
  async createSource(c, r) {
    needAdmin(c)
    const v = unwrap(await registry(c.env).createSource(r))
    return { source: info(v.source), publishableKey: v.key, ingestUrl: ingestUrl(c) }
  },
  async createKey(c, r) { needAdmin(c); return unwrap(await registry(c.env).createKey(r.source, r.scope, r.name)) },
  async listKeys(c, r) {
    needAdmin(c); const ks = await registry(c.env).listKeys(r.source, r.scope)
    if (!ks) throw new w.NotFoundError(); return { keys: ks.map(keyInfo) }
  },
  async revokeKey(c, r) { needAdmin(c); return { key: keyInfo(unwrap(await registry(c.env).revokeKey(r.source, r.keyId))) } },
}

const healthService: w.HealthServer<Ctx> = {
  async version() { return { server: 'slurp-worker-spike/0.0.0', schema: w.WebrpcSchemaVersion, webrpc: w.WebrpcVersion } },
}

const SIG_TTL_S = 3600
async function signedUrl(c: Ctx, r2key: string): Promise<{ url: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + SIG_TTL_S
  const sig = await hmacHex(c.env.SIGNING_SECRET, `${r2key}\n${exp}`)
  return { url: `${c.origin}/v1/objects/${b64url(new TextEncoder().encode(r2key))}?exp=${exp}&sig=${sig}`, exp }
}
const RETENTION_S = 90 * 86400
const iso = (ms: number) => new Date(ms).toISOString()

async function archiveAuth(c: Ctx, sourceRef: string): Promise<SourceRow> {
  if (!c.principal) throw new w.UnauthenticatedError()
  const s = await resolveOrThrow(c, sourceRef)
  if (c.principal.kind === 'key' && (c.principal.scope !== 'secret' || c.principal.source !== s.id)) throw new w.ForbiddenError()
  return s
}
const archiveService: w.ArchiveServer<Ctx> = {
  async listObjects(c, r) {
    const s = await archiveAuth(c, r.source)
    const limit = Math.min(r.limit ?? 1000, 5000)
    if (r.after !== undefined && r.after !== null && !/^\d+$/.test(r.after)) throw new w.InvalidArgumentError({ cause: 'after' })
    const sd = sourceDO(c.env, s.id)
    const cov = await sd.coverage()
    if (!cov) return { objects: [] }
    const after = r.after != null ? Number(r.after) : Number(cov.firstRetained) - 1
    if (r.after != null && Number(r.after) + 1 < Number(cov.firstRetained)) throw new w.RetentionGapError()
    const rows = await sd.listObjects(after, limit + 1)
    const page = rows.slice(0, limit)
    let expiresAt = 0
    const objects: w.ArchiveObject[] = []
    for (const m of page) {
      const { url, exp } = await signedUrl(c, m.r2key); expiresAt = exp * 1000
      objects.push({ seq: String(m.seq), name: m.name, size: m.size, sha256: m.sha256, url })
    }
    return {
      coverage: { archiveId: cov.archiveId, firstRetained: cov.firstRetained, latestPublished: cov.latestPublished ?? undefined, latestPublishedAt: cov.latestPublishedAt ? iso(cov.latestPublishedAt) : undefined, retentionSeconds: RETENTION_S },
      objects,
      nextAfter: rows.length > limit ? String(page[page.length - 1].seq) : undefined,
      expiresAt: expiresAt ? iso(expiresAt) : undefined,
    }
  },
  async getCoverage(c, r) {
    const s = await archiveAuth(c, r.source)
    const cov = await sourceDO(c.env, s.id).coverage()
    if (!cov) return {}
    return { coverage: { archiveId: cov.archiveId, firstRetained: cov.firstRetained, latestPublished: cov.latestPublished ?? undefined, latestPublishedAt: cov.latestPublishedAt ? iso(cov.latestPublishedAt) : undefined, retentionSeconds: RETENTION_S } }
  },
}

const MAX_BODY = 1024 * 1024
async function ingest(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } })
  const p = await authenticate(req, env, true)
  if (!p) return new Response('authentication required', { status: 401 })
  if (p.kind !== 'key' || p.scope !== 'publishable') return new Response('publishable key required', { status: 403 })
  const body = await req.text()
  if (body.length > MAX_BODY) return new Response('payload too large', { status: 413 })
  const res = await sourceDO(env, p.source).ingest(p.source, body)
  if (!res.ok) return new Response(res.reason, { status: res.status })
  return Response.json({ accepted: res.accepted, duplicate: res.duplicate, rowsWritten: res.rowsWritten })
}

async function download(req: Request, env: Env, token: string): Promise<Response> {
  const u = new URL(req.url)
  const exp = Number(u.searchParams.get('exp')), sig = u.searchParams.get('sig') ?? ''
  let r2key: string
  try { r2key = new TextDecoder().decode(fromB64url(token)) } catch { return new Response('bad token', { status: 400 }) }
  if (!exp || exp < Date.now() / 1000) return new Response('expired', { status: 403 })
  if (!timingSafeEqual(sig, await hmacHex(env.SIGNING_SECRET, `${r2key}\n${exp}`))) return new Response('bad signature', { status: 403 })
  const obj = await env.ARCHIVE.get(r2key)
  if (!obj) return new Response('not found', { status: 404 })
  return new Response(obj.body, { headers: { 'content-type': 'application/gzip', 'content-length': String(obj.size), etag: obj.httpEtag } })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const ctx: Ctx = { env, principal: await authenticate(req, env), origin: url.origin }
    if (url.pathname === '/v1/events') return ingest(req, env)
    if (url.pathname.startsWith('/v1/objects/')) return download(req, env, url.pathname.slice('/v1/objects/'.length))
    if (url.pathname === '/__debug/zstd') {
      const out: any = {}
      for (const f of ['zstd', 'gzip', 'deflate', 'brotli']) {
        try { new CompressionStream(f as any); out[f] = 'compress ok' } catch (e: any) { out[f] = 'compress: ' + e.message }
        try { new DecompressionStream(f as any); out[f] += ' / decompress ok' } catch (e: any) { out[f] += ' / decompress: ' + e.message }
      }
      return Response.json(out)
    }
    if (url.pathname === '/v1/health') return Response.json({ ok: true, capabilities: { sink: 'do', archive: true } })
    if (url.pathname.startsWith('/__debug/seal/') && ctx.principal?.kind === 'admin') {
      const id = url.pathname.split('/').pop()!
      return Response.json(await sourceDO(env, id).seal())
    }
    if (url.pathname.startsWith('/__debug/stats/') && ctx.principal?.kind === 'admin')
      return Response.json(await sourceDO(env, url.pathname.split('/').pop()!).stats())
    return (await w.serveHealthRpc(healthService, ctx, req))
      ?? (await w.serveSourceRpc(sourceService, ctx, req))
      ?? (await w.serveArchiveRpc(archiveService, ctx, req))
      ?? new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
