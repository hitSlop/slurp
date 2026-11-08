import { type Ctx, download, projectStub, rpc } from './api.ts'
import { adminConfigured, authenticate, bearer } from './auth.ts'
import { type Adapter, type Host, json } from './compat/common.ts'
import { hooks } from './compat/hooks.ts'
import { segment } from './compat/segment.ts'
import { sentry } from './compat/sentry.ts'
import { configOf } from './config.ts'
import { setupPage } from './landing.ts'
import { native } from './native.ts'
import type { Env } from './util.ts'
export { RegistryDO } from './registry.ts'
export { ProjectDO } from './project.ts'

/** The protocols that feed the one ingest path, tried in order. A failure inside any of them is a 503 the sender retries. */
const ADAPTERS: Adapter<any>[] = [native, segment, sentry, hooks]

const makeHost = (env: Env): Host => ({
  cfg: configOf(env),
  authenticate: token => authenticate(env, token),
  ingest: (sender, lines, geo) => projectStub(env, sender.project).ingest(sender.token, lines, geo),
  webhookSecret: (project, provider) => Promise.resolve(projectStub(env, project).webhookSecret(provider)),
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
    if (path === '/v1/health') return Response.json({ ok: true, apiVersion: 2, configured: adminConfigured(env), build: env.SLURP_BUILD ?? null, geo: host.cfg.geo })

    const ctx: Ctx = { env, cfg: host.cfg, auth: await authenticate(env, bearer(req)), origin: url.origin }
    const method = /^\/v1\/rpc\/([A-Za-z]+)$/.exec(path)?.[1]
    if (method) return rpc(req, ctx, method)
    const archive = /^\/v1\/projects\/(prj_[0-9a-f]{16})\/archives\/([^/]+)$/.exec(path)
    if (archive) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
      return download(req, ctx, archive[1], archive[2])
    }
    if (path === '/v1/admin/purge') return purge(req, env, ctx)
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
