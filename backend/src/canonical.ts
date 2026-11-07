/**
 * The canonical capture contract: record validation, stamping and request geo. The vectors are in backend/fixtures/canonical/.
 *
 * Records are validated and rewritten *textually*: client bytes are never parsed and re-serialized, so
 * arbitrary JSON numbers (9007199254740993123456789, 1e1000, -0, 1.2300) survive exactly.
 */
/** One record is stored whole, never truncated. 1 MiB leaves room under the 1.5 MB row target and the 2 MB Durable Object SQLite value limit. */
export const MAX_RECORD_BYTES = 1024 * 1024
export const MAX_DEPTH = 128
export const RECORD_TOO_LARGE = 'record exceeds 1 MiB'
// `sender` is stamped by the Worker from the key that sent the record, so a client cannot claim to be another sender.
const RESERVED = ['received_at', 'received_seq', 'sender']
const MAX_LINES = 1 << 20

class Reject extends Error {}

interface ObjInfo { keys: Set<string>; open: number; close: number }
export interface Scanned {
  members: Map<string, [number, number]>
  top: ObjInfo
  context?: ObjInfo
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

/** Strict RFC 8259 scan: one object, depth <= 128, no duplicate names at any depth, valid escapes and surrogate pairs. */
export function scan(s: string): Scanned {
  let i = 0
  const n = s.length
  const members = new Map<string, [number, number]>()
  let context: ObjInfo | undefined
  const fail = (m: string): never => { throw new Reject(m) }
  const ws = () => { while (i < n) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break } }
  const hex4 = (at: number): number => {
    if (at + 4 > n) return fail('invalid escape')
    const h = s.slice(at, at + 4)
    return /^[0-9a-fA-F]{4}$/.test(h) ? parseInt(h, 16) : fail('invalid escape')
  }
  function str(): void {
    i++ // opening quote
    for (;;) {
      if (i >= n) fail('unterminated string')
      const c = s.charCodeAt(i)
      if (c === 34) { i++; return }
      if (c < 0x20) fail('control character in string')
      if (c !== 92) { i++; continue }
      const e = s[i + 1]
      if (e === 'u') {
        const u = hex4(i + 2)
        i += 6
        if (u >= 0xd800 && u <= 0xdbff) {
          if (s[i] !== '\\' || s[i + 1] !== 'u') fail('invalid surrogate')
          const lo = hex4(i + 2)
          if (lo < 0xdc00 || lo > 0xdfff) fail('invalid surrogate')
          i += 6
        } else if (u >= 0xdc00 && u <= 0xdfff) fail('invalid surrogate')
      } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2
      else fail('invalid escape')
    }
  }
  function value(depth: number): ObjInfo | undefined {
    ws()
    if (i >= n) return fail('unexpected end')
    const c = s[i]
    if (c === '{') return obj(depth + 1)
    if (c === '[') { arr(depth + 1); return undefined }
    if (c === '"') { str(); return undefined }
    for (const lit of ['true', 'false', 'null']) if (s.startsWith(lit, i)) { i += lit.length; return undefined }
    NUMBER.lastIndex = i
    const m = NUMBER.exec(s)
    if (!m) return fail('invalid value')
    i += m[0].length
    return undefined
  }
  function arr(depth: number): void {
    if (depth > MAX_DEPTH) fail('nesting too deep')
    i++
    ws()
    if (s[i] === ']') { i++; return }
    for (;;) {
      value(depth)
      ws()
      if (s[i] === ',') { i++; continue }
      if (s[i] === ']') { i++; return }
      fail('expected , or ]')
    }
  }
  function obj(depth: number): ObjInfo {
    if (depth > MAX_DEPTH) fail('nesting too deep')
    const open = i
    i++
    const keys = new Set<string>()
    ws()
    if (s[i] === '}') { i++; return { keys, open, close: i - 1 } }
    for (;;) {
      ws()
      if (s[i] !== '"') fail('expected string key')
      const ks = i
      str()
      const raw = s.slice(ks, i)
      const key = raw.includes('\\') ? (JSON.parse(raw) as string) : raw.slice(1, -1)
      if (keys.has(key)) fail('duplicate name')
      keys.add(key)
      ws()
      if (s[i] !== ':') fail('expected :')
      i++
      ws()
      const vs = i
      const child = value(depth)
      if (depth === 1) {
        members.set(key, [vs, i])
        if (key === 'context') context = child
      }
      ws()
      if (s[i] === ',') { i++; continue }
      if (s[i] === '}') { i++; return { keys, open, close: i - 1 } }
      fail('expected , or }')
    }
  }
  ws()
  if (s[i] !== '{') fail('expected a JSON object')
  const top = obj(1)
  ws()
  if (i !== n) fail('expected one JSON object')
  return { members, top, context }
}

const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
function validTimestamp(v: string): boolean {
  const m = TS.exec(v)
  if (!m) return false
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map(k => Number(m[k]))
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** Validate one record (already UTF-8 decoded). Returns a reason, or null when accepted. */
export function validateRecord(line: string): { reason: string } | { scanned: Scanned } {
  let sc: Scanned
  try { sc = scan(line) } catch (e) {
    if (e instanceof Reject) return { reason: e.message }
    throw e
  }
  const text = (k: string): string | null => {
    const span = sc.members.get(k)
    if (!span || line[span[0]] !== '"') return null
    const v = JSON.parse(line.slice(span[0], span[1])) as string
    return v === '' ? null : v
  }
  for (const k of RESERVED) if (sc.members.has(k)) return { reason: `reserved ${k} field` }
  const id = text('id')
  if (id === null || new TextEncoder().encode(id).length > 256) return { reason: 'id must be a string of 1-256 bytes' }
  const type = text('type')
  if (type !== 'track' && type !== 'identify') return { reason: 'type must be track or identify' }
  const ts = text('timestamp')
  if (ts === null) return { reason: 'timestamp is required' }
  if (!validTimestamp(ts)) return { reason: 'timestamp must be RFC 3339' }
  const data = sc.members.get('data')
  if (!data || line[data[0]] !== '{') return { reason: 'data must be a JSON object' }
  if (type === 'track') {
    const ev = text('event')
    if (ev === null || [...ev].length > 200) return { reason: 'track event must be 1-200 characters' }
  }
  if (type === 'identify' && text('user_id') === null) return { reason: 'identify requires user_id' }
  for (const k of ['user_id', 'anonymous_id', 'session_id'])
    if (sc.members.has(k) && text(k) === null) return { reason: `${k} must be a nonempty string` }
  const ctx = sc.members.get('context')
  if (ctx) {
    if (line[ctx[0]] !== '{' || !sc.context) return { reason: 'context must be a JSON object' }
    if (sc.context.keys.has('geo')) return { reason: 'context.geo is reserved for server enrichment' }
  }
  return { scanned: sc }
}

export type Geo = Record<string, string>

/** Trusted enrichment from Cloudflare's `request.cf`; keeps only country, region and city. */
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
  if (Object.keys(geo).length === 0) return null
  geo.provider = 'cloudflare'
  geo.basis = 'request_ip'
  return Object.fromEntries(Object.entries(geo).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** Insert `geo` into the record's context without touching any other byte. */
export function spliceGeo(line: string, sc: Scanned, geo: Geo): string {
  const g = JSON.stringify(geo)
  if (sc.context) {
    const at = sc.context.close
    return line.slice(0, at) + (sc.context.keys.size ? ',' : '') + `"geo":${g}` + line.slice(at)
  }
  const at = sc.top.close
  return line.slice(0, at) + `,"context":{"geo":${g}}` + line.slice(at)
}

export type CheckResult = { lines: string[] } | { line: number; reason: string }

/** Validate a whole NDJSON batch (all or nothing) and apply geo. Bytes in, validated lines out. */
export function checkBody(body: Uint8Array, geo: Geo | null): CheckResult {
  let end = body.length
  while (end > 0 && (body[end - 1] === 0x0a || body[end - 1] === 0x0d)) end--
  if (end === 0) return { lines: [] }
  const lines: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let start = 0
  for (let n = 1; ; n++) {
    if (n > MAX_LINES) return { line: n, reason: 'too many lines' }
    let stop = body.indexOf(0x0a, start)
    if (stop === -1 || stop > end) stop = end
    const bytes = body.subarray(start, stop)
    if (bytes.length > MAX_RECORD_BYTES) return { line: n, reason: RECORD_TOO_LARGE }
    let text: string
    try { text = decoder.decode(bytes) } catch { return { line: n, reason: 'invalid UTF-8' } }
    const r = validateRecord(text)
    if ('reason' in r) return { line: n, reason: r.reason }
    lines.push(geo ? spliceGeo(text, r.scanned, geo) : text)
    if (stop >= end) break
    start = stop + 1
  }
  return { lines }
}

/** Stamp one record: prefix received_at, received_seq (`batchId<<20 | n`) and the sending key's name as `sender`. */
export function stampOne(raw: string, batchId: number, atMs: number, n: number, sender: string): string {
  const line = raw.replace(/^[ \t\r]+/, '')
  const rest = line.slice(1)
  const seq = ((BigInt(batchId) << 20n) | BigInt(n)).toString()
  const comma = /^[ \t\r]*\}/.test(rest) ? '' : ','
  return `{"received_at":"${new Date(atMs).toISOString()}","received_seq":"${seq}","sender":${JSON.stringify(sender)}${comma}${rest}\n`
}
