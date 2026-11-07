export interface Env {
  REGISTRY: DurableObjectNamespace<import('./registry.ts').RegistryDO>
  SOURCE: DurableObjectNamespace<import('./source.ts').SourceDO>
  ARCHIVE: R2Bucket
  /** Admin bearer token for the control plane. Also derives the signing key for download URLs. */
  ADMIN_TOKEN: string
  /** Set to "1" in local dev/tests to enable /__debug routes. Never set in production. */
  DEBUG?: string
  SEAL_INTERVAL_MS: string
  SEAL_MAX_BYTES: string
  GROUP_COMMIT_MS: string
  BUFFER_CAP_BYTES: string
  RETENTION_DAYS: string
  /** Largest accepted ingest body in bytes (default 10 MiB). */
  MAX_BODY_BYTES?: string
  /** Identifies the deployed bundle (set by `slurp cloud init`); lets the CLI tell when an upgrade is available. */
  SLURP_BUILD?: string
}

const enc = new TextEncoder()
const bytesToHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha256Hex = async (d: string | Uint8Array): Promise<string> =>
  bytesToHex(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : (d as BufferSource)))
export const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer)
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return bytesToHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= attempts) throw e
      await new Promise(r => setTimeout(r, 50 * i))
    }
  }
}
