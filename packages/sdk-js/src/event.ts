export const version = '0.1.0'
export const encoder = new TextEncoder()

export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 5; i >= 0; i--) {
    bytes[i] = now % 256
    now = Math.floor(now / 256)
  }
  bytes[6] = (bytes[6] & 15) | 0x70
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function jsonData(data: unknown): Record<string, unknown> {
  if (!plainObject(data)) throw new Error('data must be a plain JSON object')
  const seen = new Set<object>()
  const check = (value: unknown): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (!Array.isArray(value) && !plainObject(value)) throw new Error('data must contain only JSON values')
    if (seen.has(value)) throw new Error('data must not contain cycles')
    seen.add(value)
    if (Object.getOwnPropertySymbols(value).length) throw new Error('data must contain only JSON keys')
    for (const item of Array.isArray(value) ? value : Object.values(value)) check(item)
    seen.delete(value)
  }
  check(data)
  return JSON.parse(JSON.stringify(data))
}

export function context(): Record<string, unknown> {
  const value: Record<string, unknown> = { library: { name: '@slurp/sdk', version } }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    value.page = { url: window.location.href, path: window.location.pathname, referrer: document.referrer, title: document.title }
    value.user_agent = navigator.userAgent
    value.locale = navigator.language
    value.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } else {
    const process = (globalThis as { process?: { versions?: { node?: string }; version: string } }).process
    if (process?.versions?.node) value.runtime = { name: 'node', version: process.version }
  }
  return value
}
