import type { Line } from '../record.ts'
import { isoOrUndefined } from '../util.ts'
import { type Adapter, type Host, BodyTooLarge, json, preflight, publishable, readBody, requestGeo, submit } from './common.ts'
import { isObject } from './providers.ts'

/**
 * Sentry-compatible ingestion: set an existing Sentry SDK's DSN to point at this Worker and its errors are
 * archived next to your product events. Written from Sentry's public developer documentation (envelope
 * format, DSN and auth) and by running the real SDKs; no Sentry server code is used.
 *
 * Error events are stored whole as one `error` record (the full Sentry event JSON as sent, under `data`),
 * so nothing is cut or reshaped on the way in; SQL pulls fields out at query time (the `errors` view).
 * Sessions, transactions, replays, attachments, profiles, spans, logs and metrics are accepted and dropped.
 *
 * DSN: a publishable key is made only of word characters (`slurp_pk_<project hex>_<source>_<random hex>`), which is all Sentry SDKs
 * accept in a DSN's public key, so the DSN carries the key itself: https://<slurp_pk_...>@<worker-host>/1
 * Nothing is invented: an event's id is Sentry's `event_id` and its time is the payload's `timestamp`; one that is missing is left out.
 */

const ALLOW_HEADERS = 'X-Sentry-Auth, Content-Type, Sentry-Trace, Baggage, Authorization, Content-Encoding'
const EXPOSE = { 'access-control-expose-headers': 'X-Sentry-Rate-Limits, Retry-After' }

/** Sentry puts a project number in the URL; Slurp ignores it (the key says which project). */
export type SentryRoute = { kind: 'envelope' | 'store' }

export function sentryRoute(path: string): SentryRoute | null {
  const m = /^\/api\/[^/]+\/(envelope|store)\/?$/.exec(path)
  return m ? { kind: m[1] as 'envelope' | 'store' } : null
}

/** The DSN, the X-Sentry-Auth header and the query string all carry the publishable key itself. */
const publishableKey = (value: string | null | undefined): string | null => (value?.startsWith('slurp_pk_') ? value : null)

const keyFromDsn = (dsn: unknown): string | null => {
  if (typeof dsn !== 'string') return null
  const m = /^[a-z]+:\/\/([^:@/]+)(?::[^@]*)?@/i.exec(dsn)
  return m ? m[1] : null
}

/** Every credential the request carries must agree; none at all is a 403, as in Sentry's own spec. */
function credentials(req: Request, headerDsn: unknown): { key: string | null } | 'conflict' {
  const found = new Set<string>()
  const auth = /sentry_key=([^,\s]+)/.exec(req.headers.get('x-sentry-auth') ?? '')?.[1]
  const query = new URL(req.url).searchParams.get('sentry_key')
  for (const v of [auth, query, keyFromDsn(headerDsn)]) if (v) found.add(publishableKey(v) ?? `invalid:${v}`)
  if (found.size > 1) return 'conflict'
  return { key: found.size === 1 ? [...found][0] : null }
}

export interface EnvelopeItem { type: string; header: Record<string, unknown>; payload: Uint8Array }
export interface Envelope { header: Record<string, unknown>; items: EnvelopeItem[] }

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

/** Parse an envelope: a JSON header line, then item header lines each followed by a payload (length-prefixed or to the next newline). */
export function parseEnvelope(bytes: Uint8Array): Envelope {
  const NL = 0x0a
  let at = 0
  const line = (): Uint8Array | null => {
    if (at >= bytes.length) return null
    let end = bytes.indexOf(NL, at)
    if (end === -1) end = bytes.length
    const out = bytes.subarray(at, end)
    at = Math.min(end + 1, bytes.length)
    return out
  }
  const jsonLine = (b: Uint8Array): Record<string, unknown> => {
    const v = JSON.parse(decoder.decode(b))
    if (!isObject(v)) throw new Error('header must be an object')
    return v
  }
  const first = line()
  if (!first) throw new Error('empty envelope')
  const header = jsonLine(first)
  const items: EnvelopeItem[] = []
  for (;;) {
    let h = line()
    while (h && h.length === 0) h = line() // tolerate blank lines between items and at the end
    if (!h) break
    const itemHeader = jsonLine(h)
    const length = itemHeader.length
    let payload: Uint8Array
    if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
      if (at + length > bytes.length) throw new Error('item length exceeds the body')
      payload = bytes.subarray(at, at + length)
      at += length
      if (at < bytes.length) { if (bytes[at] !== NL) throw new Error('item payload is not followed by a newline'); at++ }
    } else {
      payload = line() ?? new Uint8Array()
    }
    items.push({ type: typeof itemHeader.type === 'string' ? itemHeader.type : '', header: itemHeader, payload })
  }
  return { header, items }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The event's own time (unix seconds, as a float, or a string), or undefined: a client can send any number (`1e300` is valid JSON). */
const timestampOf = (v: unknown): string | undefined => (typeof v === 'number' ? isoOrUndefined(v * 1000) : isoOrUndefined(v))

/** True for a real exception. captureMessage with attachStacktrace carries a synthetic one, which is a message. */
const hasException = (e: Record<string, unknown>) => {
  const x = e.exception
  const values = isObject(x) && Array.isArray(x.values) ? x.values : Array.isArray(x) ? x : []
  return values.some(v => isObject(v) && !(isObject(v.mechanism) && v.mechanism.synthetic === true))
}

/**
 * One Sentry item as a record, or why it is skipped. `null` means dropped on purpose. Only an error or message event has an id (the
 * protocol's `event_id`); the other items have none of their own (a user report carries the id of the event it is about).
 */
export function translateItem(item: EnvelopeItem, header: Record<string, unknown>): { line: string } | { reason: string } | null {
  const kind = item.type
  if (kind !== 'event' && kind !== 'user_report' && kind !== 'feedback' && kind !== 'check_in') return null
  let payload: unknown
  try { payload = JSON.parse(decoder.decode(item.payload)) } catch { return { reason: `${kind} payload is not JSON` } }
  if (!isObject(payload)) return { reason: `${kind} payload is not an object` }
  const user = isObject(payload.user) ? payload.user : {}
  const userId = text(user.id) ?? (typeof user.id === 'number' ? String(user.id) : undefined) ?? text(user.email) ?? text(user.username)
  const sdk = isObject(payload.sdk) ? payload.sdk : null
  const context: Record<string, unknown> = { compat: 'sentry' }
  if (sdk && text(sdk.name)) context.library = { name: sdk.name, ...(text(sdk.version) ? { version: sdk.version } : {}) }
  let event: string
  let id: string | undefined
  if (kind === 'event') {
    event = hasException(payload) || ['error', 'fatal'].includes(String(payload.level)) ? 'error' : 'message'
    id = text(header.event_id) ?? text(payload.event_id)
  } else {
    event = kind === 'check_in' ? 'check_in' : 'user_feedback'
  }
  const timestamp = timestampOf(payload.timestamp)
  const record: Record<string, unknown> = { ...(id ? { id } : {}), type: 'track', event, ...(timestamp ? { timestamp } : {}) }
  if (userId) record.user_id = userId
  record.data = payload
  record.context = context
  return { line: JSON.stringify(record) }
}

async function ingest(req: Request, route: SentryRoute, host: Host): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight('POST, GET, OPTIONS', ALLOW_HEADERS)
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => json(status, body, { ...EXPOSE, ...extra })
  if (req.method !== 'POST') return reply(405, { detail: 'method not allowed' }, { Allow: 'POST, OPTIONS' })
  let bytes: Uint8Array
  try { bytes = await readBody(req, host.cfg.maxBodyBytes) } catch (e) {
    if (e instanceof BodyTooLarge) return reply(413, { detail: 'body too large' })
    return reply(400, { detail: 'unreadable body' })
  }
  let envelope: Envelope
  try {
    if (route.kind === 'envelope') envelope = parseEnvelope(bytes)
    else {
      const event = JSON.parse(decoder.decode(bytes))
      if (!isObject(event)) throw new Error('event must be an object')
      envelope = { header: { event_id: event.event_id }, items: [{ type: 'event', header: { type: 'event' }, payload: bytes }] }
    }
  } catch (e) {
    return reply(400, { detail: `malformed envelope: ${(e as Error).message}` })
  }
  const creds = credentials(req, envelope.header.dsn)
  if (creds === 'conflict') return reply(403, { detail: 'conflicting credentials' })
  const principal = await publishable(host, creds.key)
  if (!principal) return reply(403, { detail: 'invalid or missing sentry_key (use the DSN Slurp prints for this project)' })
  const lines: Line[] = []
  for (const item of envelope.items) {
    const t = translateItem(item, envelope.header)
    if (t && 'line' in t) lines.push({ n: lines.length + 1, text: t.line }) // dropped on purpose, or not storable: the SDK has nothing to retry
  }
  // An item that is not a valid record is skipped, never an error: Sentry SDKs would retry a whole envelope.
  const result = await submit(host, principal, lines, { invalid: 'skip', geo: requestGeo(req) })
  return result instanceof Response ? new Response(result.body, { status: result.status, headers: { ...Object.fromEntries(result.headers), ...EXPOSE } }) : reply(200, { id: text(envelope.header.event_id) ?? '' })
}

export const sentry: Adapter<SentryRoute> = { name: 'sentry', match: (_method, url) => sentryRoute(url.pathname), handle: ingest }

