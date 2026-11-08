/** What to do about one answer from the Worker. See "SDK delivery" in docs/contracts.md. Pure. */
export type Outcome =
  | { kind: 'ok' }
  | { kind: 'stop' }
  | { kind: 'retry'; delayMs?: number }
  | { kind: 'split' }
  | { kind: 'rejected'; lines: number[]; reasons: string }
  | { kind: 'drop' }

/** `Retry-After` as milliseconds from now: a number of seconds, or an HTTP date. Undefined when it is neither. */
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
  const value = header?.trim()
  if (!value) return undefined
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined
}

/** The 1-based line numbers (within a request of k lines) a 400 body lists as rejected, with a short reason text. Empty lines list when the body is not usable. */
function rejectedLines(body: string, k: number): { lines: number[]; reasons: string } {
  try {
    const list: unknown = JSON.parse(body)?.rejected
    if (!Array.isArray(list)) return { lines: [], reasons: '' }
    const lines = new Set<number>()
    const reasons: string[] = []
    for (const item of list) {
      if (!Number.isInteger(item?.line) || item.line < 1 || item.line > k || lines.has(item.line)) continue
      lines.add(item.line)
      if (typeof item.reason === 'string' && reasons.length < 3) reasons.push(`line ${item.line}: ${item.reason}`)
    }
    return { lines: [...lines].sort((a, b) => a - b), reasons: reasons.join('; ') }
  } catch { return { lines: [], reasons: '' } }
}

export function classify(status: number, retryAfter: string | null | undefined, body: string, k: number, now: number): Outcome {
  if (status >= 200 && status < 300) return { kind: 'ok' }
  if (status === 401 || status === 403) return { kind: 'stop' }
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: 'retry', delayMs: status === 429 || status === 503 ? retryAfterMs(retryAfter, now) : undefined }
  }
  if (status === 413) return { kind: 'split' }
  if (status === 400) {
    const { lines, reasons } = rejectedLines(body, k)
    if (lines.length) return { kind: 'rejected', lines, reasons }
  }
  return { kind: 'drop' }
}
