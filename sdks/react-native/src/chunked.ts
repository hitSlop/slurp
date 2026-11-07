import type { StorageAdapter } from '@hitslop/slurp-sdk'

/**
 * AsyncStorage on Android cannot read a single value larger than about 2 MB ("Couldn't read row 0, col 0 from CursorWindow"), and the
 * SDK saves its whole queue as one value. This wrapper splits a value into pieces of at most `chunkChars` characters and switches to
 * the new pieces atomically: it writes them to the slot the current value is not using, then replaces a small manifest, then removes
 * the old slot. A crash at any point leaves either the old value or the new one readable, never a torn mix.
 *
 * Layout: `key` holds the manifest `{"slurpChunks": {"slot": "a"|"b", "count": n}}`; the pieces are `key#a#0`, `key#a#1`, ... .
 */
export function chunkedStorage(inner: StorageAdapter, chunkChars = 256 * 1024): StorageAdapter {
  interface Manifest { slot: 'a' | 'b'; count: number }
  const piece = (key: string, slot: string, index: number) => `${key}#${slot}#${index}`
  const parse = (raw: string | null): Manifest | undefined => {
    if (raw === null || !raw.startsWith('{"slurpChunks"')) return undefined
    try {
      const { slot, count } = JSON.parse(raw).slurpChunks
      return (slot === 'a' || slot === 'b') && Number.isSafeInteger(count) && count >= 0 ? { slot, count } : undefined
    } catch { return undefined }
  }
  const removePieces = async (key: string, manifest: Manifest) => {
    for (let i = 0; i < manifest.count; i++) await inner.removeItem(piece(key, manifest.slot, i))
  }
  // One operation at a time per wrapper, so two saves never interleave their pieces.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work)
    queue = result.catch(() => {})
    return result
  }

  return {
    getItem: (key) => serial(async () => {
      const raw = await inner.getItem(key)
      const manifest = parse(raw)
      if (!manifest) return raw
      let value = ''
      for (let i = 0; i < manifest.count; i++) {
        const part = await inner.getItem(piece(key, manifest.slot, i))
        if (part === null) return null // a piece is missing: treat the value as absent rather than return half of it
        value += part
      }
      return value
    }),
    setItem: (key, value) => serial(async () => {
      const current = parse(await inner.getItem(key))
      const slot = current?.slot === 'a' ? 'b' : 'a'
      const count = Math.max(1, Math.ceil(value.length / chunkChars))
      for (let i = 0; i < count; i++) await inner.setItem(piece(key, slot, i), value.slice(i * chunkChars, (i + 1) * chunkChars))
      await inner.setItem(key, JSON.stringify({ slurpChunks: { slot, count } }))
      if (current) await removePieces(key, current)
    }),
    removeItem: (key) => serial(async () => {
      const current = parse(await inner.getItem(key))
      await inner.removeItem(key)
      if (current) await removePieces(key, current)
    }),
  }
}
