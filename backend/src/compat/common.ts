import type { IngestResult } from '../source.ts'
import type { Geo } from '../canonical.ts'

/** What the compatibility adapters need from the Worker: key lookup and the normal ingest path. */
export interface CompatHost {
  /** Resolve a publishable key to its source, or null (unknown, revoked, or not publishable). */
  publishable(token: string | null): Promise<{ source: string; geo: boolean } | null>
  ingest(source: string, body: Uint8Array, geo: Geo | null): Promise<IngestResult>
  /** Geo from Cloudflare's own request metadata, only when the source opted in. */
  geoFor(req: Request, geo: boolean): Geo | null
  maxBody: number
}

export const COMPAT_CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Retry-After',
}

export const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...COMPAT_CORS, ...extra } })

export const preflight = (allowHeaders: string) =>
  new Response(null, { status: 204, headers: { ...COMPAT_CORS, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': allowHeaders, 'access-control-max-age': '86400' } })

export class BodyTooLarge extends Error {}

/** Read a request body, gunzipping when the client says it compressed it. The size limit applies to the decoded bytes. */
export async function readBody(req: Request, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length') ?? 0) > max) throw new BodyTooLarge()
  const encoding = (req.headers.get('content-encoding') ?? '').toLowerCase().trim()
  if (!req.body) return new Uint8Array()
  const source = encoding === 'gzip' || encoding === 'x-gzip' ? req.body.pipeThrough(new DecompressionStream('gzip')) : req.body
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

/** Map an ingest failure to the response an SDK expects: 4xx drops the data, 5xx and 429 retry it. */
export const ingestFailure = (res: Extract<IngestResult, { ok: false }>) =>
  json(res.status, { error: res.reason }, res.retryAfter ? { 'Retry-After': String(res.retryAfter) } : {})
