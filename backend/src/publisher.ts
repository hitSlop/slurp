import type { ArchiveInfo, Coverage, Gap } from './api.gen.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import { type Env, retry, sha256Hex } from './util.ts'

/**
 * Publication: turn the project's buffered chunks into numbered archives in R2, and delete archives past retention.
 *
 * Everything here is derived from stored facts (chunks, the publish intent, the manifest, the failure settings), so a restarted
 * Durable Object works out what to do again from its tables alone.
 */

const DAY_MS = 86_400_000
const encoder = new TextEncoder()
const pad20 = (n: number) => String(n).padStart(20, '0')
export const archiveKey = (project: string, seq: number) => `projects/${project}/archives/${pad20(seq)}.jsonl.gz`

/** What the schedule depends on. */
export interface Facts {
  /** Set while publication is failing: when to try again. */
  retryAt: number | null
  /** A publish was started (its intent is stored) and has not finished. */
  hasIntent: boolean
  bufferedBytes: number
  /** When the oldest buffered chunk was committed. */
  oldestChunkAt: number | null
  /** When the oldest archive that retention has not deleted was published. */
  oldestLiveAt: number | null
}

/** When publication is next due, or null when nothing is waiting to be published. */
export function publicationWake(f: Facts, cfg: Config, now: number): number | null {
  if (f.retryAt !== null) return f.retryAt
  if (f.hasIntent || f.bufferedBytes >= cfg.archiveMaxBytes) return now
  return f.oldestChunkAt === null ? null : f.oldestChunkAt + cfg.sealIntervalMs
}

/**
 * When retention next has an archive to delete (never sooner than a second from now), or null when it is off or nothing is stored. A
 * deletion that is already overdue while R2 is failing waits for the retry time, so an outage cannot wake the object every second (each
 * wake writes rows, and the Free plan allows 100,000 a day).
 */
export function retentionWake(f: Facts, cfg: Config, now: number): number | null {
  if (cfg.retentionDays <= 0 || f.oldestLiveAt === null) return null
  const due = f.oldestLiveAt + cfg.retentionDays * DAY_MS
  if (due <= now && f.retryAt !== null) return Math.max(f.retryAt, now + 1000)
  return Math.max(due, now + 1000)
}

/** The one time the Durable Object's alarm should be set to, or null for none. */
export function nextWake(f: Facts, cfg: Config, now: number): number | null {
  const times = [publicationWake(f, cfg, now), retentionWake(f, cfg, now)].filter((t): t is number => t !== null)
  return times.length ? Math.min(...times) : null
}

interface Intent { seq: number; through: number }

export class Publisher {
  /** Unpublished bytes in `chunks`, kept in step with the table (the table is the truth; this saves summing it on every request). */
  bufferedBytes = 0
  /** The time the alarm is set to, as far as this object knows. */
  armed: number | null = null
  private inflight: Promise<void> | null = null
  /** Test hooks (DEBUG only). */
  faults = { archive: false, afterPut: false }

  private ctx: DurableObjectState
  private env: Env
  private db: Db
  private cfg: Config
  private project: string

  constructor(ctx: DurableObjectState, env: Env, db: Db, cfg: Config, project: string) {
    this.ctx = ctx; this.env = env; this.db = db; this.cfg = cfg; this.project = project
  }

  private setting(k: string): string | null { return this.db.one<{ v: string }>('SELECT v FROM settings WHERE k=?', k)?.v ?? null }
  private intent(): Intent | null {
    const row = this.db.one<{ seq: number; through_chunk: number }>('SELECT seq, through_chunk FROM intent')
    return row ? { seq: row.seq, through: row.through_chunk } : null
  }
  private maxChunk(): number { return this.db.one<{ m: number | null }>('SELECT MAX(id) m FROM chunks')?.m ?? 0 }

  /** Load the buffered size from the table (when the object starts). */
  load() { this.bufferedBytes = this.db.one<{ b: number }>('SELECT COALESCE(SUM(bytes), 0) b FROM chunks')?.b ?? 0 }

  facts(): Facts {
    const retry = this.setting('retry_at')
    return {
      retryAt: retry === null ? null : Number(retry),
      hasIntent: this.intent() !== null,
      bufferedBytes: this.bufferedBytes,
      oldestChunkAt: this.db.one<{ t: number }>('SELECT at_ms t FROM chunks ORDER BY id LIMIT 1')?.t ?? null,
      oldestLiveAt: this.db.one<{ t: number }>('SELECT created_at t FROM manifest WHERE deleted_at IS NULL ORDER BY seq LIMIT 1')?.t ?? null,
    }
  }

  /** Set (or clear) the alarm for `nextWake`. The only place that touches the alarm, and only when the time changes: each write bills a row. */
  async rearm(): Promise<void> {
    const now = Date.now()
    const want = nextWake(this.facts(), this.cfg, now)
    const cur = this.armed
    if (want === null) {
      if (cur === null) return
      this.armed = null
      this.db.alarmWrites++
      await this.ctx.storage.deleteAlarm()
    } else {
      // An alarm that is already due fires at once, so a later "now" needs no second write.
      if (cur === want || (cur !== null && cur <= now && want <= now)) return
      this.armed = want
      this.db.alarmWrites++
      await this.ctx.storage.setAlarm(want)
    }
  }

  /** Learn what the platform has armed (when the object starts, and as an alarm begins). */
  async syncAlarm(): Promise<void> { this.armed = await this.ctx.storage.getAlarm() }

  /** One publication at a time: callers during a run share it. */
  publish(): Promise<void> {
    if (!this.inflight) this.inflight = this.run().finally(() => { this.inflight = null })
    return this.inflight
  }

  /** Publish everything buffered now (up to the newest chunk at this moment), even if a run that started earlier was already going. */
  async publishAll(): Promise<void> {
    const mark = this.maxChunk()
    while (this.db.one('SELECT 1 FROM chunks WHERE id<=?', mark) || this.intent()) await this.publish()
    this.clearFailures()
  }

  private async run(): Promise<void> {
    // The watermark keeps continuous traffic from extending a run for ever.
    const watermark = this.maxChunk()
    for (;;) {
      const intent = this.intent() ?? this.plan(watermark)
      if (!intent) return
      await this.publishIntent(intent)
    }
  }

  /** Choose the next archive: the oldest chunks up to ARCHIVE_MAX_BYTES (at least one), and store that choice before any work is done. */
  private plan(watermark: number): Intent | null {
    let total = 0, through = 0
    for (const c of this.db.rows<{ id: number; bytes: number }>('SELECT id, bytes FROM chunks WHERE id<=? ORDER BY id', watermark)) {
      if (through && total + c.bytes > this.cfg.archiveMaxBytes) break
      total += c.bytes
      through = c.id
    }
    if (!through) return null
    const seq = (this.db.one<{ m: number | null }>('SELECT MAX(seq) m FROM manifest')?.m ?? 0) + 1
    this.db.rows('INSERT INTO intent VALUES(?,?)', seq, through)
    return { seq, through }
  }

  /** Compress the intent's chunks into one gzip stream and put it in R2, then commit manifest, chunk deletion and intent together. */
  private async publishIntent({ seq, through }: Intent): Promise<void> {
    const chunks = this.db.rows<{ id: number; events: number; bytes: number }>('SELECT id, events, bytes FROM chunks WHERE id<=? ORDER BY id', through)
    const gz = await this.compress(chunks.map(c => c.id))
    const sha256 = await sha256Hex(gz)
    await retry(async () => {
      if (this.faults.archive) throw new Error('injected archive failure')
      return this.env.ARCHIVE.put(archiveKey(this.project, seq), gz, { httpMetadata: { contentType: 'application/gzip' } })
    })
    if (this.faults.afterPut) { this.faults.afterPut = false; throw new Error('injected failure after the R2 put') }
    const events = chunks.reduce((n, c) => n + c.events, 0), bytes = chunks.reduce((n, c) => n + c.bytes, 0)
    this.ctx.storage.transactionSync(() => {
      this.db.rows('INSERT INTO manifest(seq, size, sha256, events, created_at) VALUES(?,?,?,?,?)', seq, gz.length, sha256, events, Date.now())
      this.db.rows('DELETE FROM chunks WHERE id<=?', through)
      this.db.rows('DELETE FROM intent')
    })
    this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes)
  }

  /** Stream the chunks, in order, through one gzip compressor while its output is read at the same time (so neither side stalls). */
  private async compress(ids: number[]): Promise<Uint8Array> {
    const gzip = new CompressionStream('gzip')
    const output = new Response(gzip.readable).arrayBuffer()
    const writer = gzip.writable.getWriter()
    try {
      for (const id of ids) await writer.write(encoder.encode(this.db.one<{ data: string }>('SELECT data FROM chunks WHERE id=?', id)!.data))
      await writer.close()
    } catch (e) {
      output.catch(() => {})
      await writer.abort(e).catch(() => {})
      throw e
    }
    return new Uint8Array(await output)
  }

  /** Delete archives older than RETENTION_DAYS from R2 (a page at a time) and mark them deleted. Their manifest rows stay, so seq never repeats. */
  async sweep(): Promise<void> {
    if (this.cfg.retentionDays <= 0) return
    const cutoff = Date.now() - this.cfg.retentionDays * DAY_MS
    for (;;) {
      const old = this.db.rows<{ seq: number }>('SELECT seq FROM manifest WHERE deleted_at IS NULL AND created_at<? ORDER BY seq LIMIT 1000', cutoff)
      if (!old.length) return
      await retry(() => this.env.ARCHIVE.delete(old.map(o => archiveKey(this.project, o.seq))))
      this.db.rows('UPDATE manifest SET deleted_at=? WHERE seq<=? AND deleted_at IS NULL', Date.now(), old[old.length - 1].seq)
    }
  }

  /**
   * An alarm that throws is retried by Cloudflare a few times and then not again until something sets one, and a quiet project has nothing
   * that would. So a failure is caught and the retry is scheduled here (`retry_at`): it backs off from ARCHIVE_RETRY_MS up to the seal
   * interval, for ever. Retention does not wait for publication.
   */
  async alarm(force: boolean): Promise<void> {
    await this.syncAlarm()
    const now = Date.now()
    let failure: unknown = null
    let published = false
    const due = publicationWake(this.facts(), this.cfg, now)
    if (force || (due !== null && due <= now)) {
      try { await this.publish(); published = true } catch (e) { failure = e }
    }
    try { await this.sweep() } catch (e) { failure ??= e }
    if (failure) this.fail(failure, now)
    else if (published) this.clearFailures()
    await this.rearm()
  }

  private fail(error: unknown, now: number) {
    const failures = Number(this.setting('failures') ?? 0) + 1
    const { archiveRetryMs, sealIntervalMs } = this.cfg
    const delay = Math.min(archiveRetryMs * 2 ** Math.min(failures - 1, 30), Math.max(sealIntervalMs, archiveRetryMs))
    this.db.rows('INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'failures', String(failures))
    this.db.rows('INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'retry_at', String(now + delay))
    console.error(`archive publication failed (attempt ${failures}); trying again in ${Math.round(delay / 1000)} s`, error)
  }
  private clearFailures() {
    if (this.setting('retry_at') !== null || this.setting('failures') !== null) this.db.rows("DELETE FROM settings WHERE k IN ('failures','retry_at')")
  }

  /** The archives' state for a listing: the oldest kept, the newest, and whether accepted events are still waiting for an archive. */
  coverage(queued: boolean): Coverage {
    const first = this.db.one<{ seq: number }>('SELECT seq FROM manifest WHERE deleted_at IS NULL ORDER BY seq LIMIT 1')?.seq
    const last = this.db.one<{ seq: number; created_at: number }>('SELECT seq, created_at FROM manifest ORDER BY seq DESC LIMIT 1')
    const pending = queued || this.bufferedBytes > 0 || this.intent() !== null
    return {
      ...(first !== undefined ? { first } : {}),
      ...(last ? { last: last.seq, lastAt: new Date(last.created_at).toISOString() } : {}),
      pending,
    }
  }

  /** A page of archives after `after` (default: from the oldest kept), with the gap retention left if `after` is older than that. */
  list(after: number | undefined, limit: number, queued: boolean): { coverage: Coverage; archives: ArchiveInfo[]; next?: number; gap?: Gap } {
    const coverage = this.coverage(queued)
    // With every archive deleted there is no oldest kept one: the first that could ever be listed is after the last.
    const from = coverage.first ?? (coverage.last ?? 0) + 1
    const gap = after !== undefined && after + 1 < from ? { from: after + 1, to: from - 1 } : undefined
    const rows = this.db.rows<{ seq: number; size: number; sha256: string; events: number; created_at: number }>(
      'SELECT seq, size, sha256, events, created_at FROM manifest WHERE seq>? AND deleted_at IS NULL ORDER BY seq LIMIT ?', Math.max(after ?? 0, from - 1), limit + 1)
    const page = rows.slice(0, limit)
    return {
      coverage,
      archives: page.map(r => ({ seq: r.seq, size: r.size, sha256: r.sha256, events: r.events, createdAt: new Date(r.created_at).toISOString() })),
      ...(rows.length > limit ? { next: page[page.length - 1].seq } : {}),
      ...(gap ? { gap } : {}),
    }
  }

  /** Whether archive `seq` is published and not deleted. */
  has(seq: number): boolean { return this.db.one('SELECT 1 FROM manifest WHERE seq=? AND deleted_at IS NULL', seq) !== undefined }

  /** Delete every archive object of this project (for purge). */
  async deleteArchives(): Promise<number> {
    const live = this.db.rows<{ seq: number }>('SELECT seq FROM manifest WHERE deleted_at IS NULL ORDER BY seq')
    for (let i = 0; i < live.length; i += 1000) await retry(() => this.env.ARCHIVE.delete(live.slice(i, i + 1000).map(r => archiveKey(this.project, r.seq))))
    return live.length
  }
}
