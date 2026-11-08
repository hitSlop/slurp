import { type Ctx, download, projectStub, rpc } from './api.ts'
import { type Auth, Unavailable, adminConfigured, authenticate, bearer } from './auth.ts'
import { type Adapter, type Host, json } from './compat/common.ts'
import { hooks } from './compat/hooks.ts'
import { segment } from './compat/segment.ts'
import { sentry } from './compat/sentry.ts'
import { type Config, configOf } from './config.ts'
import { dashboardPage } from './dashboard.ts'
import { setupPage } from './landing.ts'
import { native } from './native.ts'
import { collectStatus } from './status.ts'
import type { Env } from './util.ts'
import { RELEASE } from './version.ts'
export { RegistryDO } from './registry.ts'
export { ProjectDO } from './project.ts'

/** The protocols that feed the one ingest path, tried in order. A failure inside any of them is a 503 the sender retries. */
const ADAPTERS: Adapter<any>[] = [native, segment, sentry, hooks]

const makeHost = (env: Env): Host => ({
  cfg: configOf(env),
  authenticate: token => authenticate(env, token),
  ingest: (sender, lines, geo) => projectStub(env, sender.project).ingest(sender.token, lines, geo),
  webhookSecret: async (project, provider) => {
    const secret = await projectStub(env, project).webhookSecret(provider)
    if (!secret.ok) throw new Unavailable(secret.message)
    return secret.value
  },
})

/** Admin only. Deletes all data so the Worker and bucket can be removed: every project's archives and storage, any stray R2 objects, and the registry. */
async function purge(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers: { Allow: 'POST' } })
  if (ctx.auth?.kind !== 'admin') return Response.json({ error: ctx.auth ? 'admin token required' : 'invalid token' }, { status: ctx.auth ? 403 : 401 })
  const body = (await req.json().catch(() => ({}))) as { confirm?: string }
  if (body.confirm !== 'delete-all-data') return Response.json({ error: 'send {"confirm":"delete-all-data"} to confirm' }, { status: 400 })
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
  const projects = await registry.list()
  let archives = 0
  for (const p of projects) archives += (await projectStub(env, p.id).purge()).archives
  let strays = 0
  for (;;) {
    const page = await env.ARCHIVE.list({ prefix: 'projects/', limit: 1000 })
    if (page.objects.length === 0) break
    await env.ARCHIVE.delete(page.objects.map(o => o.key))
    strays += page.objects.length
  }
  await registry.purge()
  return Response.json({ ok: true, projects: projects.length, archives, strays })
}

/** Admin only. Every project and its problems, for the dashboard. */
async function status(req: Request, env: Env, ctx: Ctx, cfg: Config): Promise<Response> {
  if (req.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405, headers: { Allow: 'GET' } })
  if (ctx.auth?.kind !== 'admin') return Response.json({ error: ctx.auth ? 'admin token required' : 'invalid token' }, { status: ctx.auth ? 403 : 401 })
  try {
    return Response.json(await collectStatus(env, cfg, { release: RELEASE, build: env.SLURP_BUILD ?? null }), { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    console.error('status failed', e)
    return Response.json({ error: 'storage is unavailable' }, { status: 503, headers: { 'Retry-After': '5' } })
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const host = makeHost(env)
    for (const adapter of ADAPTERS) {
      const route = adapter.match(req.method, url)
      if (route === null) continue
      try { return await adapter.handle(req, route, host) } catch (e) {
        console.error(`${adapter.name} ingest failed`, e)
        return json(503, { error: 'unavailable' }, { 'Retry-After': '5' })
      }
    }

    const path = url.pathname
    if (path === '/healthz') return new Response('ok\n')
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD'))
      return new Response(req.method === 'HEAD' ? null : setupPage(url.origin, adminConfigured(env)), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } })
    if (path === '/dashboard' && (req.method === 'GET' || req.method === 'HEAD')) {
      // The page is static and holds no data; it fetches /v1/admin/status with the admin token. Its one script is allowed by nonce.
      const nonce = btoa(crypto.randomUUID())
      return new Response(req.method === 'HEAD' ? null : dashboardPage(nonce), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, 'x-content-type-options': 'nosniff' } })
    }
    if (path === '/v1/health') return Response.json({ ok: true, apiVersion: 2, release: RELEASE, configured: adminConfigured(env), build: env.SLURP_BUILD ?? null, geo: host.cfg.geo })

    // A project key is checked by its object, which refuses (`Unavailable`) when its stored data is newer than this code.
    let auth: Auth | null
    try { auth = await authenticate(env, bearer(req)) } catch (e) {
      console.error('authentication failed', e)
      return Response.json({ error: { code: 'unavailable', message: 'storage is unavailable' } }, { status: 503, headers: { 'Retry-After': '5' } })
    }
    const ctx: Ctx = { env, cfg: host.cfg, auth, origin: url.origin }
    const method = /^\/v1\/rpc\/([A-Za-z]+)$/.exec(path)?.[1]
    if (method) return rpc(req, ctx, method)
    const archive = /^\/v1\/projects\/(prj_[0-9a-f]{16})\/archives\/([^/]+)$/.exec(path)
    if (archive) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
      return download(req, ctx, archive[1], archive[2])
    }
    if (path === '/v1/admin/purge') return purge(req, env, ctx)
    if (path === '/v1/admin/status') return status(req, env, ctx, host.cfg)
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
