export interface Env {
  REGISTRY: DurableObjectNamespace<import('./registry.ts').RegistryDO>
  SOURCE: DurableObjectNamespace<import('./source.ts').SourceDO>
  ARCHIVE: R2Bucket
  ADMIN_TOKEN: string
  SIGNING_SECRET: string
  SEAL_INTERVAL_MS: string
  SEAL_MAX_BYTES: string
}

const enc = new TextEncoder()
export const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b.buffer as ArrayBuffer : b)].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha256Hex = async (d: string | ArrayBuffer | Uint8Array) =>
  hex(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : d as ArrayBuffer))
export const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)))
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
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
