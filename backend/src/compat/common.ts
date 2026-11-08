import type { Auth } from '../auth.ts'
import type { Config } from '../config.ts'
import type { IngestResult } from '../project.ts'
import { type Bad, type Geo, type Line, MAX_REJECTED, normalizeGeo, recordError } from '../record.ts'

/** A publishable key resolved: its project and the source it sends as (taken from the stored key). */
export interface Sender { project: string; source: string }

/** What the adapters need from the Worker: key lookup, the ingest path and webhook secrets. */
export interface Host {
  cfg: Config
  authenticate(token: string | null | undefined): Promise<Auth | null>
  ingest(sender: Sender, lines: string[], geo: Geo | null): Promise<IngestResult>
  /** The provider's signing secret for this project, '' when not given yet, or null when the provider is not connected. */
  webhookSecret(project: string, provider: string): Promise<string | null>
}

/** One protocol the Worker speaks: it claims requests by method and URL, then handles them. */
export interface Adapter<Route = unknown> {
  name: string
  match(method: string, url: URL): Route | null
  handle(req: Request, route: Route, host: Host): Promise<Response>
}

export const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After' }

export const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS, ...extra } })

export const preflight = (methods: string, allowHeaders: string) =>
  new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': methods, 'access-control-allow-headers': allowHeaders, 'access-control-max-age': '86400' } })

/** The publishable key behind a token (any other kind of credential is null). */
export async function publishable(host: Host, token: string | null | undefined): Promise<Sender | null> {
  const auth = token?.startsWith('slurp_pk_') ? await host.authenticate(token) : null
  return auth?.kind === 'key' && auth.scope === 'publishable' ? { project: auth.project, source: auth.source! } : null
}

/** Request location from Cloudflare's own metadata, never from client-supplied headers. The project's GEO setting decides whether it is stored. */
export const requestGeo = (req: Request): Geo | null => normalizeGeo((req as Request & { cf?: any }).cf)

export class BodyTooLarge extends Error {}

/**
 * Read a request body without ever holding more than `max` bytes: it is read as a stream and cancelled as soon as it is over the limit,
 * so a request with no Content-Length (chunked) cannot make the Worker buffer all of it first. With `gunzip`, a gzip body is decoded and
 * the limit applies to the decoded bytes.
 */
export async function readBounded(req: Request, max: number, options: { gunzip: boolean }): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length') ?? 0) > max) throw new BodyTooLarge()
  const encoding = (req.headers.get('content-encoding') ?? '').toLowerCase().trim()
  if (!req.body) return new Uint8Array()
  const source = options.gunzip && (encoding === 'gzip' || encoding === 'x-gzip') ? req.body.pipeThrough(new DecompressionStream('gzip')) : req.body
  const reader = source.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel(); throw new BodyTooLarge() }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/** The compatibility endpoints (Segment, Sentry, webhooks) accept gzip bodies, as their SDKs send them. */
export const readBody = (req: Request, max: number): Promise<Uint8Array> => readBounded(req, max, { gunzip: true })

/** Map an ingest failure to the response an SDK expects: 4xx drops the data, 5xx and 429 retry it. */
export const ingestFailure = (res: Extract<IngestResult, { ok: false }>) =>
  json(res.status, { error: res.reason }, res.retryAfter ? { 'Retry-After': String(res.retryAfter) } : {})

/**
 * The one way events enter: validate every line, then store the valid ones. With `invalid: 'fail'` any bad line rejects the whole request
 * (400 listing every bad line). With `'skip'` bad lines are dropped and reported, because Segment and Sentry SDKs drop a whole request on a
 * 400. Returns a Response for a failure, or what was stored (nothing is stored when no line is valid).
 */
export async function submit(host: Host, sender: Sender, lines: Line[], opts: { invalid: 'skip' | 'fail'; geo: Geo | null }): Promise<Response | { accepted: number; rejected: Bad[] }> {
  const valid: string[] = []
  const rejected: Bad[] = []
  for (const l of lines) {
    const reason = l.error ?? recordError(l.text)
    if (!reason) valid.push(l.text!)
    else if (rejected.length < MAX_REJECTED) rejected.push({ line: l.n, reason })
    else if (opts.invalid === 'fail') break
  }
  if (rejected.length && opts.invalid === 'fail') return json(400, { error: 'invalid records', rejected })
  if (valid.length === 0) return { accepted: 0, rejected }
  const result = await host.ingest(sender, valid, opts.geo)
  return result.ok ? { accepted: result.accepted, rejected } : ingestFailure(result)
}
