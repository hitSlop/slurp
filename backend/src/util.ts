export interface Env {
  REGISTRY: DurableObjectNamespace<import('./registry.ts').RegistryDO>
  PROJECT: DurableObjectNamespace<import('./project.ts').ProjectDO>
  ARCHIVE: R2Bucket
  /** Admin bearer token for the control plane (a secret). */
  ADMIN_TOKEN: string
  /** Set to "1" in local dev and tests to enable the /__debug routes. Never set in production. */
  DEBUG?: string
  /** Identifies the deployed bundle (set by `slurp cloud init`); lets the CLI tell when an upgrade is available. */
  SLURP_BUILD?: string
  // The settings in docs/contracts.md arrive as strings and are parsed by config.ts.
  SEAL_INTERVAL_MS?: string
  ARCHIVE_MAX_BYTES?: string
  GROUP_COMMIT_MS?: string
  BUFFER_CAP_BYTES?: string
  MAX_BODY_BYTES?: string
  RETENTION_DAYS?: string
  ARCHIVE_RETRY_MS?: string
  GEO?: string
}

const enc = new TextEncoder()
const bytesToHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha256Hex = async (d: string | Uint8Array): Promise<string> =>
  bytesToHex(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : (d as BufferSource)))
export const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer)

/** HMAC-SHA256 of raw bytes, as hex (a webhook body must be signed exactly as it arrived, not as decoded text). */
export async function hmacBytesHex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return bytesToHex(await crypto.subtle.sign('HMAC', key, data as BufferSource))
}

const MIN_TIME_MS = 0 // 1970-01-01
const MAX_TIME_MS = 253_402_300_799_999 // 9999-12-31T23:59:59.999Z
/**
 * A time as an ISO string, or undefined when it is not a real one: a number of milliseconds, or text a Date can read. NaN, infinity,
 * and anything before 1970 or after year 9999 are refused rather than thrown on (`new Date(1e300).toISOString()` is a RangeError).
 */
export function isoOrUndefined(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? new Date(value).getTime() : NaN
  return Number.isFinite(ms) && ms >= MIN_TIME_MS && ms <= MAX_TIME_MS ? new Date(ms).toISOString() : undefined
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= attempts) throw e
      await new Promise(r => setTimeout(r, 50 * i))
    }
  }
}
