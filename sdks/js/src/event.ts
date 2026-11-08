export const version = '0.1.2'

/** UTF-8 for runtimes without TextEncoder (React Native before Hermes shipped it). */
function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00); i++ }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd // a lone surrogate, as TextEncoder does
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}
export const encoder: { encode(text: string): Uint8Array } = typeof TextEncoder === 'function' ? new TextEncoder() : { encode: utf8Encode }

/** Cryptographic randomness where the runtime has it; ids only need to be unique, so Math.random is the fallback. */
function randomBytes(length: number): Uint8Array {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array } }).crypto
  if (typeof crypto?.getRandomValues === 'function') return crypto.getRandomValues(new Uint8Array(length))
  return Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))
}

/** The page address when there is one. React Native defines `window` but not `window.location`. */
export function pageHref(): string | undefined {
  try { return typeof window !== 'undefined' ? window.location?.href : undefined } catch { return undefined }
}

/** An endpoint resolved against the page when it can be, otherwise as written (URL support is partial in some runtimes). */
export function resolveEndpoint(endpoint: string): string {
  try { return new URL(endpoint, pageHref()).toString() } catch { return endpoint }
}

export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16)
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
  const value: Record<string, unknown> = { library: { name: '@hitslop/slurp-sdk', version } }
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
