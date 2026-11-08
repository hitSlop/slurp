import { DurableObject } from 'cloudflare:workers'
import type { ArchiveInfo, Coverage, Gap } from './api.gen.ts'
import { type Config, configOf } from './config.ts'
import { Db, SCHEMA } from './db.ts'
import { Publisher } from './publisher.ts'
import { type Geo, envelope } from './record.ts'
import type { Result } from './registry.ts'
import { type Env, randomHex, sha256Hex } from './util.ts'

/** What a presented key may do: its scope, and the source it sends as (publishable) or the label it carries (secret). */
export type Principal = { scope: 'publishable' | 'secret'; keyId: string; source?: string; name?: string }
export type KeyRow = { key_id: string; scope: 'publishable' | 'secret'; source: string | null; name: string | null; plain: string | null; created_at: string; revoked_at: string | null }
export type IngestResult = { ok: true; accepted: number } | { ok: false; status: 429 | 503; reason: string; retryAfter: number }

export const SOURCE = /^[a-z][a-z0-9_]{0,31}$/
/** One stored chunk is at most this many bytes. */
export const CHUNK_MAX_BYTES = 6 * 1024 * 1024
const encoder = new TextEncoder()

interface Queued { lines: string[]; sizes: number[]; bytes: number; atMs: number; done: (r: IngestResult) => void }

/**
 * One Durable Object per project: its keys and webhook connections, the buffer of accepted events, and (in `Publisher`) the archives.
 * A key names its project, so a request goes straight to this object with no global lookup first.
 *
 * Nothing is written until `init` runs, so a made-up project id in a forged key costs nothing: the object stays empty.
 *
 * Billing-aware (rows written is what Durable Object SQLite bills): concurrent requests inside GROUP_COMMIT_MS are committed as one
 * chunk row and acknowledged after the commit, and the alarm is only written when the time it should fire at changes.
 */
export class ProjectDO extends DurableObject<Env> {
  private db = new Db(this.ctx.storage.sql)
  private cfg: Config = configOf(this.env)
  private publisher = new Publisher(this.ctx, this.env, this.db, this.cfg, this.ctx.id.name ?? '')
  private ready = false
  private queue: Queued[] = []
  private queuedBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Test hook (DEBUG only): make the next group commit fail once. */
  private failFlush = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ready = this.db.rows("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keys'").length > 0
    if (!this.ready) return
    this.db.rows(SCHEMA)
    this.publisher.load()
    // After a restart, work out from the tables whether anything is due (an unfinished publish, retention) and arm the alarm for it.
    ctx.blockConcurrencyWhile(async () => { await this.publisher.syncAlarm(); await this.publisher.rearm() })
  }

  private get project(): string { return this.ctx.id.name ?? '' }
  private now = () => new Date().toISOString()

  /** Create this project's storage and its `default` source key, or return the existing one. Safe to repeat. */
  init(): KeyRow {
    if (!this.ready) { this.db.rows(SCHEMA); this.ready = true }
    return (this.sourceKey('default') as { ok: true; value: KeyRow }).value
  }

  // ---- keys ----

  private mint(scope: 'publishable' | 'secret', source: string | null, name: string | null, hash: string | null, key: string): KeyRow {
    const row: KeyRow = { key_id: randomHex(8), scope, source, name, plain: hash ? null : key, created_at: this.now(), revoked_at: null }
    this.db.rows('INSERT INTO keys(key_id, scope, source, name, plain, hash, created_at) VALUES(?,?,?,?,?,?,?)', row.key_id, scope, source, name, row.plain, hash, row.created_at)
    return row
  }
  private publishableKey(source: string) { return `slurp_pk_${this.project.slice(4)}_${source}_${randomHex(24)}` }

  /** The key's scope and the source or label it carries; null when it is unknown or revoked (at once: nothing is cached). */
  async authorize(token: string): Promise<Principal | null> {
    if (!this.ready) return null
    const secret = token.startsWith('slurp_sk_')
    const row = this.db.one<KeyRow>(`SELECT * FROM keys WHERE ${secret ? 'hash' : 'plain'}=? AND revoked_at IS NULL`, secret ? await sha256Hex(token) : token)
    if (!row) return null
    return row.scope === 'secret' ? { scope: 'secret', keyId: row.key_id, name: row.name ?? 'default' } : { scope: 'publishable', keyId: row.key_id, source: row.source! }
  }

  /** The oldest live publishable key for `source`, made if there is none (so asking again never makes a second one). */
  sourceKey(source: string): Result<KeyRow> {
    if (!this.ready) return { ok: false, code: 'notfound', message: 'project' }
    if (!SOURCE.test(source)) return { ok: false, code: 'invalid', message: 'source must be a lowercase name of up to 32 letters, digits and underscores, starting with a letter' }
    const live = this.db.one<KeyRow>("SELECT * FROM keys WHERE scope='publishable' AND source=? AND revoked_at IS NULL ORDER BY rowid LIMIT 1", source)
    if (live) return { ok: true, value: live }
    const key = this.publishableKey(source)
    return { ok: true, value: this.mint('publishable', source, null, null, key) }
  }

  async createKey(scope: 'publishable' | 'secret', source: string | undefined, name: string | undefined): Promise<Result<KeyRow>> {
    if (!this.ready) return { ok: false, code: 'notfound', message: 'project' }
    if (scope === 'publishable') {
      if (source === undefined || !SOURCE.test(source)) return { ok: false, code: 'invalid', message: 'a publishable key needs a source: lowercase letters, digits and underscores, starting with a letter, up to 32' }
      return { ok: true, value: this.mint('publishable', source, null, null, this.publishableKey(source)) }
    }
    const label = name === undefined || name.trim() === '' ? 'default' : name
    if (encoder.encode(label).length > 200) return { ok: false, code: 'invalid', message: 'name is too long' }
    const key = `slurp_sk_${this.project.slice(4)}_${randomHex(24)}`
    const row = this.mint('secret', null, label, await sha256Hex(key), key)
    return { ok: true, value: { ...row, plain: key } } // the only time a secret key is ever readable
  }

  listKeys(scope?: string): KeyRow[] {
    if (!this.ready) return []
    return this.db.rows<KeyRow>('SELECT * FROM keys ORDER BY rowid').filter(k => !scope || k.scope === scope)
  }

  revokeKey(keyId: string): Result<KeyRow> {
    if (!this.ready) return { ok: false, code: 'notfound', message: 'project' }
    if (!this.db.one('SELECT 1 FROM keys WHERE key_id=?', keyId)) return { ok: false, code: 'notfound', message: 'key' }
    this.db.rows('UPDATE keys SET revoked_at=? WHERE key_id=? AND revoked_at IS NULL', this.now(), keyId)
    return { ok: true, value: this.db.one<KeyRow>('SELECT * FROM keys WHERE key_id=?', keyId)! }
  }

  // ---- webhook connections ----

  /**
   * Connect a provider. Idempotent: with a live key for the provider's source the connection is returned as it is. With none (never
   * connected, or the key was revoked) a new key is made and the secret is replaced too, so rotating is revoke, then connect again.
   * `fresh` is the secret to use then ('' for a provider that issues its own); `given` is one the user supplied (always stored).
   */
  connectWebhook(provider: string, fresh: string, given: string | null): Result<{ secret: string; key: string }> {
    if (!this.ready) return { ok: false, code: 'notfound', message: 'project' }
    const existed = this.db.one("SELECT 1 FROM keys WHERE scope='publishable' AND source=? AND revoked_at IS NULL", provider) !== undefined
    const key = this.sourceKey(provider)
    if (!key.ok) return key
    const replace = !existed || given !== null
    this.db.rows('INSERT INTO webhooks VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET secret=excluded.secret WHERE ?', provider, provider, given ?? fresh, this.now(), replace ? 1 : 0)
    return { ok: true, value: { secret: this.webhookSecret(provider)!, key: key.value.plain! } }
  }
  /** The provider's signing secret ('' until Stripe's has been given), or null when it has not been connected. */
  webhookSecret(provider: string): string | null {
    return this.ready ? this.db.one<{ secret: string }>('SELECT secret FROM webhooks WHERE provider=?', provider)?.secret ?? null : null
  }

  // ---- ingest ----

  /** Accept validated record lines from `source`: wrap each in an envelope, commit them, and answer once they are durable. */
  async ingest(source: string, lines: string[], geo: Geo | null): Promise<IngestResult> {
    if (!this.ready) return { ok: false, status: 503, reason: 'unavailable', retryAfter: 5 }
    if (lines.length === 0) return { ok: true, accepted: 0 }
    const atMs = Date.now()
    const geoJson = this.cfg.geo && geo ? JSON.stringify(geo) : null
    const wrapped = lines.map(l => envelope(atMs, source, geoJson, l))
    const sizes = wrapped.map(l => encoder.encode(l).length)
    const bytes = sizes.reduce((a, b) => a + b, 0)
    // Admission counts what is committed, what is queued, and this request as it will be stored (the envelope makes it larger).
    if (this.publisher.bufferedBytes + this.queuedBytes + bytes > this.cfg.bufferCapBytes) return { ok: false, status: 429, reason: 'buffer full', retryAfter: 10 }
    const done = new Promise<IngestResult>(resolve => {
      this.queue.push({ lines: wrapped, sizes, bytes, atMs, done: resolve })
      this.queuedBytes += bytes
    })
    if (this.cfg.groupCommitMs <= 0 || this.queuedBytes >= CHUNK_MAX_BYTES) await this.flush()
    else if (!this.timer) this.timer = setTimeout(() => { void this.flush() }, this.cfg.groupCommitMs)
    return done
  }

  /** Commit everything queued as chunks (at most CHUNK_MAX_BYTES each) in one transaction, then acknowledge it. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const q = this.queue
    if (q.length === 0) return
    this.queue = []
    this.queuedBytes = 0
    try {
      if (this.failFlush) { this.failFlush = false; throw new Error('injected flush failure') }
      const chunks: { data: string[]; events: number; bytes: number; atMs: number }[] = []
      let cur: (typeof chunks)[number] | undefined
      for (const item of q) {
        item.lines.forEach((line, i) => {
          if (!cur || cur.bytes + item.sizes[i] > CHUNK_MAX_BYTES) chunks.push(cur = { data: [], events: 0, bytes: 0, atMs: item.atMs })
          cur.data.push(line); cur.events++; cur.bytes += item.sizes[i]
        })
      }
      this.ctx.storage.transactionSync(() => {
        for (const c of chunks) this.db.rows('INSERT INTO chunks(events, bytes, at_ms, data) VALUES(?,?,?,?)', c.events, c.bytes, c.atMs, c.data.join(''))
      })
      this.publisher.bufferedBytes += q.reduce((n, item) => n + item.bytes, 0)
    } catch (e) {
      console.error('flush failed', e)
      for (const item of q) item.done({ ok: false, status: 503, reason: 'unavailable', retryAfter: 5 })
      return
    }
    // An acknowledged event must have an alarm that will publish it. The chunks are committed, so if the alarm cannot be set the senders
    // are told to retry; the retry is a duplicate, which the importer drops by (sender, id).
    try { await this.publisher.rearm() } catch (e) {
      console.error('the alarm could not be set; the requests were answered 503 so their senders retry', e)
      for (const item of q) item.done({ ok: false, status: 503, reason: 'unavailable', retryAfter: 5 })
      return
    }
    for (const item of q) item.done({ ok: true, accepted: item.lines.length })
  }

  // ---- archives ----

  async alarm(): Promise<void> { await this.runAlarm(false) }
  /** The alarm's work; `force` publishes even if nothing is due yet (tests). */
  async runAlarm(force: boolean): Promise<void> {
    await this.flush()
    await this.publisher.alarm(force)
  }

  /** Publish everything buffered now, then report where archives stand. Throws if R2 fails. */
  async publish(): Promise<Coverage> {
    await this.flush()
    try { await this.publisher.publishAll() } catch (e) {
      // Same as a failed alarm run: back off (`retry_at`) and keep an alarm armed, so the buffered events are retried without a caller.
      this.publisher.fail(e, Date.now())
      try { await this.publisher.rearm() } catch (a) { console.error('could not set the alarm after a failed publish', a) }
      throw e
    }
    await this.publisher.rearm()
    return this.coverage()
  }

  coverage(): Coverage { return this.ready ? this.publisher.coverage(this.queue.length > 0) : { pending: false } }
  archives(after: number | undefined, limit: number): { coverage: Coverage; archives: ArchiveInfo[]; next?: number; gap?: Gap } {
    return this.ready ? this.publisher.list(after, limit, this.queue.length > 0) : { coverage: { pending: false }, archives: [] }
  }
  /** Whether archive `seq` exists (published, not deleted by retention). */
  hasArchive(seq: number): boolean { return this.ready && this.publisher.has(seq) }

  /** Delete this project's archives from R2 and all of its storage (used by `slurp cloud destroy`). */
  async purge(): Promise<{ archives: number }> {
    const archives = this.ready ? await this.publisher.deleteArchives() : 0
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.queue = []
    this.queuedBytes = 0
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.ready = false
    this.publisher.armed = null
    this.publisher.bufferedBytes = 0
    return { archives }
  }

  // ---- test hooks (the DEBUG routes only) ----

  async fault(which: 'flush' | 'archive' | 'after-put' | 'alarm', on: boolean): Promise<void> {
    if (which === 'flush') this.failFlush = on
    else if (which === 'archive') this.publisher.faults.archive = on
    else if (which === 'alarm') this.publisher.faults.alarm = on
    else this.publisher.faults.afterPut = on
  }
  async sweep(): Promise<void> { await this.publisher.sweep(); await this.publisher.rearm() }
  async stats() {
    if (!this.ready) return { ready: false, pending: false, rowsWritten: this.db.rowsWritten, alarmWrites: this.db.alarmWrites }
    const n = (table: string, where = '1') => this.db.one<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)!.n
    return {
      ready: true,
      pending: this.coverage().pending,
      queued: this.queue.length,
      bufferedBytes: this.publisher.bufferedBytes,
      chunks: n('chunks'),
      intent: this.db.one('SELECT seq, through_chunk FROM intent') ?? null,
      manifest: n('manifest'),
      live: n('manifest', 'deleted_at IS NULL'),
      alarm: await this.ctx.storage.getAlarm(),
      armed: this.publisher.armed,
      rowsWritten: this.db.rowsWritten,
      alarmWrites: this.db.alarmWrites,
      failures: Number(this.db.one<{ v: string }>("SELECT v FROM settings WHERE k='failures'")?.v ?? 0),
      retryAt: this.db.one<{ v: string }>("SELECT v FROM settings WHERE k='retry_at'")?.v ?? null,
    }
  }
}
