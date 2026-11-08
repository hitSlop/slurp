/**
 * Record validation and envelopes (docs/contracts.md, "Sending events"). A record is validated by parsing it, and then stored as
 * the trimmed line exactly as it was sent: it is never re-serialized, so numbers, key order and escapes survive. Server metadata
 * goes around it in an envelope. The vectors are in backend/fixtures/canonical/.
 */
export const MAX_RECORD_BYTES = 1024 * 1024
export const MAX_DEPTH = 128
export const MAX_REJECTED = 100

/** A line that was rejected, with its 1-based line number. */
export interface Bad { line: number; reason: string }
/** One line of a body: its 1-based number and its trimmed text, or why it could not be read. */
export type Line = { n: number; text: string; error?: undefined } | { n: number; text?: undefined; error: string }

const encoder = new TextEncoder()
const utf8Length = (s: string) => encoder.encode(s).length
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const wellFormed = (s: string) => {
  const native = (s as string & { isWellFormed?: () => boolean }).isWellFormed
  return native ? native.call(s) : !LONE_SURROGATE.test(s)
}

/** Every string and key must be well-formed UTF-16, and nesting at most 128 deep (the root object is depth 1). */
function walk(value: unknown, depth: number): string | null {
  if (typeof value === 'string') return wellFormed(value) ? null : 'strings must be well-formed Unicode (lone surrogate)'
  if (value === null || typeof value !== 'object') return null
  if (depth > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH}`
  if (Array.isArray(value)) {
    for (const item of value) { const bad = walk(item, depth + 1); if (bad) return bad }
    return null
  }
  for (const key of Object.keys(value)) {
    if (!wellFormed(key)) return 'keys must be well-formed Unicode (lone surrogate)'
    const bad = walk((value as Record<string, unknown>)[key], depth + 1)
    if (bad) return bad
  }
  return null
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
function validTimestamp(value: string): boolean {
  const m = TIMESTAMP.exec(value)
  if (!m) return false
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map(k => Number(m[k]))
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** The field rules. Absent fields are fine; `null` is never a value for any of them. */
function fieldError(r: Record<string, unknown>): string | null {
  const has = (k: string) => Object.hasOwn(r, k)
  const text = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null)
  if (has('type') && r.type !== 'track' && r.type !== 'identify') return 'type must be "track" or "identify"'
  if (has('id')) { const id = text('id'); if (id === null || id === '' || id.length > 256 || utf8Length(id) > 256) return 'id must be a string of 1-256 bytes' }
  if (has('timestamp')) { const t = text('timestamp'); if (t === null || !validTimestamp(t)) return 'timestamp must be RFC 3339' }
  for (const k of ['data', 'context']) if (has(k) && !isObject(r[k])) return `${k} must be an object`
  for (const k of ['user_id', 'anonymous_id', 'session_id']) if (has(k) && !(text(k))) return `${k} must be a non-empty string`
  if (has('event')) { const e = text('event'); if (e === null || e === '' || e.length > 400 || [...e].length > 200) return 'event must be a string of 1-200 characters' }
  if ((r.type ?? 'track') === 'track' && !has('event')) return 'a track record needs event'
  if (r.type === 'identify' && !has('user_id')) return 'an identify record needs user_id'
  return null
}

/** Why a (trimmed) line is not a valid record, or null when it is. */
export function recordError(text: string): string | null {
  if (text.length * 3 > MAX_RECORD_BYTES && utf8Length(text) > MAX_RECORD_BYTES) return 'record exceeds 1 MiB'
  let value: unknown
  try { value = JSON.parse(text) } catch { return 'not valid JSON' }
  if (!isObject(value)) return 'a record must be a JSON object'
  return walk(value, 1) ?? fieldError(value)
}

const isBlank = (b: number) => b === 0x20 || b === 0x09 || b === 0x0d
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Split a body on `\n`, trim each line (spaces, tabs, a trailing `\r`), skip empty lines, and number every line from 1. */
export function splitLines(body: Uint8Array): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let n = 1; start <= body.length; n++) {
    let stop = body.indexOf(0x0a, start)
    if (stop === -1) stop = body.length
    let a = start, b = stop
    while (a < b && isBlank(body[a])) a++
    while (b > a && isBlank(body[b - 1])) b--
    if (b > a) {
      try { lines.push({ n, text: decoder.decode(body.subarray(a, b)) }) } catch { lines.push({ n, error: 'not valid UTF-8' }) }
    }
    start = stop + 1
  }
  return lines
}

export type Checked = { lines: string[] } | { rejected: Bad[] }

/** Validate a whole body. All or nothing: any bad line rejects it, and every bad line (up to 100) is listed. */
export function checkBody(body: Uint8Array): Checked {
  const lines: string[] = []
  const rejected: Bad[] = []
  for (const l of splitLines(body)) {
    const reason = l.error !== undefined ? l.error : recordError(l.text)
    if (reason) { rejected.push({ line: l.n, reason }); if (rejected.length >= MAX_REJECTED) break } else lines.push(l.text!)
  }
  return rejected.length ? { rejected } : { lines }
}

export type Geo = Record<string, string>

/** Trusted enrichment from Cloudflare's `request.cf`: city, country and region, sorted by key. The country is ISO alpha-2 and never XX or T1. */
export function normalizeGeo(cf: { country?: unknown; region?: unknown; city?: unknown } | null | undefined): Geo | null {
  if (!cf) return null
  const geo: Geo = {}
  for (const f of ['city', 'country', 'region'] as const) {
    const v = typeof cf[f] === 'string' ? (cf[f] as string).trim() : ''
    if (v !== '' && v.length <= 256) geo[f] = v
  }
  if (geo.country !== undefined) {
    const c = geo.country.toUpperCase()
    if (/^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1') geo.country = c
    else delete geo.country
  }
  return Object.keys(geo).length === 0 ? null : geo
}

/** One stored line: the server's facts, then the client's record untouched (`record` is always last). `geo` is already JSON. */
export const envelope = (receivedAtMs: number, sender: string, geoJson: string | null, record: string): string =>
  `{"received_at":"${new Date(receivedAtMs).toISOString()}","sender":${JSON.stringify(sender)}${geoJson ? `,"geo":${geoJson}` : ''},"record":${record}}\n`
