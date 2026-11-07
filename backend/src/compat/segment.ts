import { MAX_RECORD_BYTES, validateRecord } from '../canonical.ts'
import { sha256Hex } from '../util.ts'
import { type CompatHost, BodyTooLarge, ingestFailure, json, preflight, readBody } from './common.ts'

/**
 * Segment-compatible ingestion: point an existing Segment SDK at this Worker and events land in the project
 * that owns the key, next to events from the native SDK. Segment's "write key" is a Slurp publishable key.
 *
 * Written from the SDKs' observable behavior (the HTTP calls they make and the responses they accept).
 * Events are re-serialized as canonical records, not stored byte for byte like the native endpoint, and the
 * translation is deterministic so a retried batch produces identical bytes and dedupes.
 */

const SINGLE: Record<string, string> = { t: 'track', i: 'identify', p: 'page', s: 'screen', g: 'group', a: 'alias' }
const ALLOW_HEADERS = 'Authorization, Content-Type, X-Retry-Count'

export type SegmentRoute = { kind: 'single'; type: string } | { kind: 'batch' } | { kind: 'settings'; key: string }

export function segmentRoute(method: string, path: string): SegmentRoute | null {
  let m = /^\/v1\/([tipsga])$/.exec(path)
  if (m) return { kind: 'single', type: SINGLE[m[1]] }
  if (path === '/v1/b' || path === '/v1/batch') return { kind: 'batch' }
  m = /^\/v1\/projects\/([^/]+)\/settings$/.exec(path)
  if (m && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')) return { kind: 'settings', key: decodeURIComponent(m[1]) }
  return null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v === '' ? undefined : v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function timestampOf(msg: Record<string, unknown>, sentAt: string | undefined, now: number): string {
  for (const v of [msg.timestamp, msg.originalTimestamp]) {
    if (typeof v === 'string' || typeof v === 'number') {
      const ms = new Date(v).getTime()
      if (Number.isFinite(ms)) return new Date(ms).toISOString()
    }
  }
  const ms = sentAt ? new Date(sentAt).getTime() : NaN
  return new Date(Number.isFinite(ms) ? ms : now).toISOString()
}

/** Translate one Segment message into a canonical record line, or explain why it cannot be. */
export async function translateMessage(raw: unknown, type: string | undefined, sentAt: string | undefined, now: number): Promise<{ line: string } | { reason: string }> {
  if (!isObject(raw)) return { reason: 'message must be an object' }
  const kind = type ?? (typeof raw.type === 'string' ? raw.type : undefined)
  if (!kind || !['track', 'identify', 'page', 'screen', 'group', 'alias'].includes(kind)) return { reason: 'unknown message type' }
  const userId = text(raw.userId)
  const anonymousId = text(raw.anonymousId)
  const properties = isObject(raw.properties) ? raw.properties : {}
  const traits = isObject(raw.traits) ? raw.traits : isObject((raw.context as any)?.traits) && kind === 'identify' ? (raw.context as any).traits : {}
  let canonicalType: 'track' | 'identify' = 'track'
  let event: string | undefined
  let data: Record<string, unknown>
  switch (kind) {
    case 'track':
      event = text(raw.event)
      if (!event) return { reason: 'track needs an event name' }
      data = properties
      break
    case 'identify':
      if (userId) { canonicalType = 'identify'; data = traits } else { event = 'identify'; data = traits }
      break
    case 'page':
    case 'screen':
      event = kind
      data = { ...properties, ...(text(raw.name) ? { name: text(raw.name) } : {}), ...(text(raw.category) ? { category: text(raw.category) } : {}) }
      break
    case 'group':
      event = 'group'
      data = { ...traits, group_id: text(raw.groupId) ?? null }
      break
    default:
      event = 'alias'
      data = { previous_id: text(raw.previousId) ?? null }
  }
  const context: Record<string, unknown> = isObject(raw.context) ? { ...raw.context } : {}
  delete context.geo // reserved for server enrichment
  if (kind === 'identify') delete context.traits
  context.compat = 'segment'
  const timestamp = timestampOf(raw, sentAt, now)
  const id = text(raw.messageId) ?? `segment-${await sha256Hex(JSON.stringify([kind, userId, anonymousId, event, timestamp, data]))}`
  const record: Record<string, unknown> = { id, type: canonicalType, ...(event !== undefined ? { event } : {}), timestamp }
  if (userId) record.user_id = userId
  if (anonymousId) record.anonymous_id = anonymousId
  record.data = data
  record.context = context
  return { line: JSON.stringify(record) }
}

function keyFrom(req: Request, body: unknown): string | null {
  const auth = /^Basic (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  if (auth) {
    try { const user = atob(auth).split(':')[0]; if (user) return user } catch { /* fall through to the body */ }
  }
  const bearer = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  if (bearer) return bearer
  if (isObject(body) && typeof body.writeKey === 'string' && body.writeKey) return body.writeKey
  return new URL(req.url).searchParams.get('key')
}

export async function segmentIngest(req: Request, route: SegmentRoute, host: CompatHost): Promise<Response> {
  const origin = new URL(req.url).origin
  if (route.kind === 'settings') return settings(req, route.key, origin, host)
  if (req.method === 'OPTIONS') return preflight(ALLOW_HEADERS)
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' })
  let bytes: Uint8Array
  try { bytes = await readBody(req, host.maxBody) } catch (e) {
    if (e instanceof BodyTooLarge) return json(413, { error: 'body too large' })
    return json(400, { error: 'unreadable body' })
  }
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) } catch { return json(400, { error: 'body must be JSON' }) }
  const principal = await host.publishable(keyFrom(req, body))
  if (!principal) return json(401, { error: 'invalid write key (use a Slurp publishable key)' })
  const sentAt = isObject(body) && typeof body.sentAt === 'string' ? body.sentAt : undefined
  let messages: unknown[]
  let type: string | undefined
  if (route.kind === 'batch') {
    if (!isObject(body) || !Array.isArray(body.batch)) return json(400, { error: 'batch must be an array' })
    messages = body.batch
  } else {
    messages = [body]
    type = route.type
  }
  const now = Date.now()
  const lines: string[] = []
  let rejected = 0
  const encoder = new TextEncoder()
  for (const m of messages) {
    const t = await translateMessage(m, type, sentAt, now)
    // Judge each event on its own: one bad event must not cost the rest of its batch, because Segment SDKs drop a whole 400.
    if ('reason' in t || 'reason' in validateRecord(t.line) || encoder.encode(t.line).length > MAX_RECORD_BYTES) { rejected++; continue }
    lines.push(t.line)
  }
  if (lines.length === 0) {
    if (messages.length === 0) return json(200, { success: true, accepted: 0, rejected: 0 })
    return json(400, { error: 'no valid events in the request', rejected })
  }
  const res = await host.ingest(principal, encoder.encode(lines.join('\n') + '\n'), host.geoFor(req, principal.geo))
  if (!res.ok) return ingestFailure(res)
  return json(200, { success: true, accepted: lines.length, rejected })
}

async function settings(req: Request, key: string, origin: string, host: CompatHost): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight(ALLOW_HEADERS)
  if (!(await host.publishable(key))) return json(404, { error: 'unknown project' })
  return json(200, {
    integrations: { 'Segment.io': { apiKey: key, apiHost: `${new URL(origin).host}/v1`, protocol: new URL(origin).protocol === 'http:' ? 'http' : 'https', addBundledMetadata: true, unbundledIntegrations: [] } },
    plan: { track: { __default: { enabled: true, integrations: {} } }, identify: { __default: { enabled: true } }, group: { __default: { enabled: true } } },
    edgeFunction: {}, analyticsNextEnabled: true, middlewareSettings: {}, enabledMiddleware: {}, metrics: { sampleRate: 0 },
    legacyVideoPluginsEnabled: false, remotePlugins: [],
  }, { 'cache-control': 'public, max-age=60' })
}
