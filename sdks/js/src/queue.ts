import { bytes } from './event.ts'

/**
 * The lines waiting to be sent (one JSON record each, oldest first) and what is on the wire right now. Pure state, no I/O.
 *
 * The first `inFlight` lines belong to the request being answered. They are only ever removed by `ack`, `dropLines`, `halve` and `clear`,
 * which all assume the request is over, so a capture that overflows the queue meanwhile can never discard them.
 * `inFlight` is not persisted: after a restart every line is simply sent again, and the import dedupes by (source, event id).
 */
export class Queue {
  lines: string[] = []
  /** Bytes held, counting one newline per line. Kept incrementally so a capture never re-measures the queue. */
  bytes = 0
  inFlight = 0
  /** Most lines the next request may take. Halved by a 413, restored by a success. */
  split = Infinity
  private sizes: number[] = []

  get length(): number { return this.lines.length }

  /** Replace everything (when saved state is loaded). */
  load(lines: string[]): void {
    this.lines = lines
    this.sizes = lines.map(line => bytes(line) + 1)
    this.bytes = this.sizes.reduce((total, size) => total + size, 0)
    this.inFlight = 0
  }

  push(line: string): void {
    const size = bytes(line) + 1
    this.lines.push(line)
    this.sizes.push(size)
    this.bytes += size
  }

  /** Drop the oldest lines that are not in flight until at most `maxLines` lines and `maxBytes` bytes are held. Returns how many were dropped. */
  trim(maxLines: number, maxBytes: number): number {
    let count = 0
    let freed = 0
    while (this.inFlight + count < this.lines.length && (this.lines.length - count > maxLines || this.bytes - freed > maxBytes)) {
      freed += this.sizes[this.inFlight + count]
      count++
    }
    this.lines.splice(this.inFlight, count)
    this.sizes.splice(this.inFlight, count)
    this.bytes -= freed
    return count
  }

  /** Start a request: the first k lines, where k is at most `maxEvents`, at most the split limit, and fits `maxBytes` (a first line that does not fit goes alone). Empty when nothing is queued. */
  take(maxEvents: number, maxBytes: number): string[] {
    const limit = Math.min(maxEvents, this.split)
    let k = 0
    let size = 0
    while (k < this.lines.length && k < limit && (k === 0 || size + this.sizes[k] <= maxBytes)) size += this.sizes[k++]
    this.inFlight = k
    return this.lines.slice(0, k)
  }

  /** The request ended without a verdict (network error, 5xx, closed): the same lines stay at the front. */
  release(): void { this.inFlight = 0 }

  /** The request's k lines are done with (delivered or given up on). */
  ack(k: number): void {
    this.lines.splice(0, k)
    this.bytes -= this.sizes.splice(0, k).reduce((total, size) => total + size, 0)
    this.inFlight = 0
  }

  /** Remove some lines of the request (0-based indices) and keep the rest queued. Returns how many were removed. */
  dropLines(indices: number[]): number {
    const drop = new Set(indices.filter(index => Number.isInteger(index) && index >= 0 && index < this.inFlight))
    const keep = (_: unknown, index: number) => !drop.has(index)
    this.bytes -= this.sizes.filter((_, index) => drop.has(index)).reduce((total, size) => total + size, 0)
    this.lines = this.lines.filter(keep)
    this.sizes = this.sizes.filter(keep)
    this.inFlight = 0
    return drop.size
  }

  /** A 413 for a request of k lines: halve the split limit so the next request is smaller (the first half, rounded up). A single line cannot be split: it is dropped. Returns true when it was dropped. */
  halve(k: number): boolean {
    if (k <= 1) { this.ack(1); return true }
    this.split = Math.ceil(k / 2)
    this.inFlight = 0
    return false
  }

  /** Remove everything, in flight or not. Returns how many lines there were. */
  clear(): number {
    const count = this.lines.length
    this.load([])
    return count
  }
}
