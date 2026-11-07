// Port of backend/canonical.go validateRecord + stamp.go stampLines (textual stamping: wide numbers survive).
const MAX_RECORD = 32 * 1024
const enc = new TextEncoder()
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

const nonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v !== ''

export function validateRecord(line: string): string | null {
  if (enc.encode(line).length > MAX_RECORD) return 'record exceeds 32 KiB'
  let obj: any
  try { obj = JSON.parse(line) } catch { return 'invalid JSON' }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'expected a JSON object'
  for (const k of ['received_at', 'received_seq', 'rt', 'rseq', 'ts', 'props'])
    if (k in obj) return `reserved or obsolete ${k} field`
  if (!nonEmptyStr(obj.id) || enc.encode(obj.id).length > 256) return 'id must be a string of 1-256 bytes'
  if (obj.type !== 'track' && obj.type !== 'identify') return 'type must be track or identify'
  if (!nonEmptyStr(obj.timestamp)) return 'timestamp is required'
  if (!RFC3339.test(obj.timestamp) || Number.isNaN(Date.parse(obj.timestamp))) return 'timestamp must be RFC 3339'
  if (obj.data === null || typeof obj.data !== 'object' || Array.isArray(obj.data)) return 'data must be a JSON object'
  if (obj.type === 'track' && (!nonEmptyStr(obj.event) || [...obj.event].length > 200)) return 'track event must be 1-200 characters'
  if (obj.type === 'identify' && !nonEmptyStr(obj.user_id)) return 'identify requires user_id'
  for (const k of ['user_id', 'anonymous_id', 'session_id'])
    if (k in obj && !nonEmptyStr(obj[k])) return `${k} must be a nonempty string`
  if ('context' in obj) {
    const c = obj.context
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'context must be a JSON object'
    if ('geo' in c) return 'context.geo is reserved for server enrichment'
  }
  return null
}

/** Returns validated lines or {line, reason}. A single trailing newline is allowed. */
export function checkBody(body: string): { lines: string[] } | { line: number; reason: string } {
  const lines = (body.endsWith('\n') ? body.slice(0, -1) : body).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const reason = validateRecord(lines[i])
    if (reason) return { line: i + 1, reason }
  }
  return { lines }
}

/** Prefix received_at/received_seq without re-serializing the client's bytes. seq = batchId<<20 | n. */
export function stampLines(lines: string[], batchId: number, atMs: number): string {
  const rt = new Date(atMs).toISOString()
  let out = ''
  lines.forEach((raw, n) => {
    const line = raw.replace(/^[ \t\r]+/, '')
    const rest = line.slice(1)
    const seq = ((BigInt(batchId) << 20n) | BigInt(n)).toString()
    const comma = /^[ \t\r]*\}/.test(rest) ? '' : ','
    out += `{"received_at":"${rt}","received_seq":"${seq}"${comma}${rest}\n`
  })
  return out
}
