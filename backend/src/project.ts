import { DurableObject } from 'cloudflare:workers'
import { type Env, sha256Hex, randomHex, gzip, retry } from './util.ts'
import { checkBody, RECORD_TOO_LARGE, stampOne, type Geo } from './canonical.ts'
import type { Result } from './registry.ts'

export type Publication = { state: 'pending' | 'idle'; observedAt: string; intervalSeconds: number; estimatedAt?: string }
export type IngestResult =
  | { ok: true; accepted: number; duplicate: boolean; publication: Publication }
  | { ok: false; status: 400 | 401 | 403 | 413 | 429 | 503; reason: string; retryAfter?: number }
export type KeyRow = { key_id: string; scope: string; name: string; hash: string | null; plain: string | null; created_at: string; revoked_at: string | null }
/** What a presented key is allowed to do. `geo` is whether this project opted in to request-location enrichment. */
export type Authorized = { scope: 'publishable' | 'secret'; keyId: string; name: string; geo: boolean }
export type ManifestRow = { seq: number; name: string; r2key: string; size: number; sha256: string; events: number; created_at: number }
export type Coverage = { archiveId: string; firstRetained: string; latestPublished: string; latestPublishedAt: number }

const pad20 = (n: number) => String(n).padStart(20, '0')
const MAX_SEQ_PER_ROW = (1 << 20) - 1
// Durable Object SQLite rejects any string, blob or row over 2 MB, so a stored row stays comfortably below it.
const ROW_MAX_BYTES = 1_500_000
const encoder = new TextEncoder()
const RECENT_HASHES = 10_000

interface Queued { lines: string[]; atMs: number; hash: string; sender: string; done: (r: IngestResult) => void }

/**
 * One Durable Object per project: its keys, its durable batch buffer, alarm-driven sealing to R2, and the manifest. A key
 * says which project it belongs to, so a request goes straight to this object with no global lookup first.
 *
 * Nothing is written until `init` runs, so a made-up project id in a forged key costs nothing: the object stays empty.
 *
 * Billing-aware design (rows written is what Durable Object SQLite bills):
 *  - group commit: concurrent requests inside GROUP_COMMIT_MS are written as one row; acked after the commit;
 *  - batches live in generation tables (b_<gen>). Sealing rotates to a fresh generation, archives the frozen one,
 *    then DROPs it, because DELETE bills per row and DROP TABLE does not;
 *  - the seal intent is persisted before the R2 put, so a crash replays the same frozen rows under the same seq.
 */
export class ProjectDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql
  pendingBytes = 0
  nextBatch = 1
  queue: Queued[] = []
  queuedBytes = 0
  timer: ReturnType<typeof setTimeout> | null = null
  /** Identical request bodies seen lately, keyed by hash. The promise settles when that request's batch is committed (or fails). */
  recent = new Map<string, Promise<IngestResult>>()
  /** Test hook (DEBUG only): make the next group commit fail once. */
  failNext = false
  /** Rows written by this object since it was last constructed (what Durable Object SQLite bills). */
  rows = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    if (this.initialized()) this.restore()
  }

  private initialized(): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").toArray().length > 0
  }
  private restore() {
    this.table(this.gen())
    let max = Number(this.meta('batch_hwm') ?? 0)
    let bytes = 0
    for (const g of this.liveGens()) {
      const r = this.sql.exec(`SELECT COALESCE(MAX(id),0) m, COALESCE(SUM(bytes),0) b FROM b_${g}`).one() as { m: number; b: number }
      max = Math.max(max, r.m); bytes += r.b
    }
    this.nextBatch = max + 1
    this.pendingBytes = bytes
  }
  private projectId(): string { return this.ctx.id.name ?? '' }

  /**
   * Create this project's storage and its first publishable key, or return the existing one. Safe to repeat: it never
   * changes a key that exists, and `geo` only applies the first time.
   */
  init(geo: boolean): { key: string } {
    if (!this.initialized()) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS manifest(seq INTEGER PRIMARY KEY, name TEXT NOT NULL, r2key TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, events INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS keys(key_id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, hash TEXT UNIQUE, plain TEXT UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);`)
      this.setMeta('geo', geo ? '1' : '0')
      this.restore()
    }
    const live = this.sql.exec("SELECT plain FROM keys WHERE scope='publishable' AND revoked_at IS NULL ORDER BY created_at, key_id LIMIT 1").toArray()[0] as { plain: string } | undefined
    return { key: live ? live.plain : this.mintPublishable('default').key }
  }

  private mintPublishable(name: string): { key: string; keyId: string } {
    const key = `slurp_pk_${this.projectId().slice(4)}_${randomHex(24)}`
    const keyId = randomHex(8)
    this.w('INSERT INTO keys VALUES(?,?,?,NULL,?,?,NULL)', keyId, 'publishable', name, key, new Date().toISOString())
    return { key, keyId }
  }

  /** The key's scope, id and name; null when it is unknown or revoked (immediately, with no cache). A publishable key is looked up as is. */
  async authorize(token: string): Promise<Authorized | null> {
    if (!this.initialized()) return null
    const secret = token.startsWith('slurp_sk_')
    const row = (secret
      ? this.sql.exec('SELECT key_id, scope, name FROM keys WHERE hash=? AND revoked_at IS NULL', await sha256Hex(token))
      : this.sql.exec('SELECT key_id, scope, name FROM keys WHERE plain=? AND revoked_at IS NULL', token)).toArray()[0] as { key_id: string; scope: 'publishable' | 'secret'; name: string } | undefined
    return row ? { scope: row.scope, keyId: row.key_id, name: row.name, geo: this.meta('geo') === '1' } : null
  }

  async createKey(scope: string, name: string): Promise<Result<{ key: string; keyId: string }>> {
    if (!this.initialized()) return { ok: false, code: 'notfound', message: 'project' }
    if (scope !== 'publishable' && scope !== 'secret') return { ok: false, code: 'invalid', message: 'scope must be publishable or secret' }
    const label = name.trim() === '' ? 'default' : name
    if (encoder.encode(label).length > 200) return { ok: false, code: 'invalid', message: 'name too long' }
    if (scope === 'publishable') return { ok: true, value: this.mintPublishable(label) }
    const key = `slurp_sk_${this.projectId().slice(4)}_${randomHex(24)}`
    const hash = await sha256Hex(key)
    const keyId = randomHex(8)
    this.w('INSERT INTO keys VALUES(?,?,?,?,NULL,?,NULL)', keyId, 'secret', label, hash, new Date().toISOString())
    return { ok: true, value: { key, keyId } }
  }
  listKeys(scope?: string): KeyRow[] {
    if (!this.initialized()) return []
    return (this.sql.exec('SELECT * FROM keys ORDER BY created_at, key_id').toArray() as KeyRow[]).filter(k => !scope || k.scope === scope)
  }
  revokeKey(keyId: string): Result<KeyRow> {
    if (!this.initialized()) return { ok: false, code: 'notfound', message: 'project' }
    const k = this.sql.exec('SELECT * FROM keys WHERE key_id=?', keyId).toArray()[0] as KeyRow | undefined
    if (!k) return { ok: false, code: 'notfound', message: 'key' }
    if (!k.revoked_at) this.w('UPDATE keys SET revoked_at=? WHERE key_id=?', new Date().toISOString(), keyId)
    return { ok: true, value: this.sql.exec('SELECT * FROM keys WHERE key_id=?', keyId).one() as KeyRow }
  }
  geoEnabled(): boolean { return this.initialized() && this.meta('geo') === '1' }
  setGeo(on: boolean) { if (this.initialized()) this.setMeta('geo', on ? '1' : '0') }

  private num(k: string, d: number): number { const v = Number((this.env as any)[k]); return Number.isFinite(v) ? v : d }
  private w(query: string, ...bindings: any[]) {
    const c = this.sql.exec(query, ...bindings)
    c.toArray()
    this.rows += c.rowsWritten
    return c
  }
  private meta(k: string): string | null {
    const r = this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray()[0] as { v: string } | undefined
    return r ? r.v : null
  }
  private setMeta(k: string, v: string) { this.w('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v) }
  private gen(): number { return Number(this.meta('gen') ?? 1) }
  private table(g: number) { this.sql.exec(`CREATE TABLE IF NOT EXISTS b_${g}(id INTEGER PRIMARY KEY, data TEXT NOT NULL, events INTEGER NOT NULL, bytes INTEGER NOT NULL)`) }
  private intent(): { gen: number; seq: number } | null { const v = this.meta('sealing'); return v ? JSON.parse(v) : null }
  private liveGens(): number[] { const i = this.intent(); return i ? [i.gen, this.gen()] : [this.gen()] }
  private archiveId(): string {
    let id = this.meta('archive_id')
    if (!id) { id = randomHex(8); this.setMeta('archive_id', id) }
    return id
  }
  /** True while accepted events are waiting for their archive (a retention alarm alone is not a pending publication). */
  private hasBuffered(): boolean { return this.pendingBytes > 0 || this.queue.length > 0 || this.intent() !== null }
  private publication(alarm: number | null): Publication {
    const pending = this.hasBuffered()
    return { state: pending ? 'pending' : 'idle', observedAt: new Date().toISOString(), intervalSeconds: Math.round(this.num('SEAL_INTERVAL_MS', 600000) / 1000), ...(pending && alarm !== null ? { estimatedAt: new Date(alarm).toISOString() } : {}) }
  }
  /** When the oldest archive reaches RETENTION_DAYS, or null when retention is off or nothing is archived. */
  private nextExpiry(): number | null {
    const days = this.num('RETENTION_DAYS', 0)
    if (days <= 0) return null
    const oldest = (this.sql.exec('SELECT MIN(created_at) m FROM manifest').one() as { m: number | null }).m
    return oldest === null ? null : oldest + days * 86_400_000
  }
  /** With nothing buffered, keep an alarm only for the next retention expiry; otherwise none. */
  private async settleIdleAlarm(): Promise<void> {
    const expiry = this.nextExpiry()
    if (expiry === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(expiry, Date.now() + 1000))
  }

  /** Ingest for a presented publishable key: one call that authorizes, applies geo only if this project opted in, and stamps the sender. */
  async ingestKey(token: string, body: Uint8Array, requestGeo: Geo | null): Promise<IngestResult> {
    const a = await this.authorize(token)
    if (!a) return { ok: false, status: 401, reason: 'invalid token' }
    if (a.scope !== 'publishable') return { ok: false, status: 403, reason: 'publishable key required' }
    return this.ingest(a.name, body, a.geo ? requestGeo : null)
  }

  /** Ingest records already authorized as `sender` (the sending key's name). */
  async ingest(sender: string, body: Uint8Array, geo: Geo | null): Promise<IngestResult> {
    if (!this.initialized()) return { ok: false, status: 503, reason: 'unavailable', retryAfter: 5 }
    const checked = checkBody(body, geo)
    if ('reason' in checked) return { ok: false, status: checked.reason === RECORD_TOO_LARGE ? 413 : 400, reason: `line ${checked.line}: ${checked.reason}` }
    if (checked.lines.length === 0) return { ok: true, accepted: 0, duplicate: false, publication: this.publication(await this.ctx.storage.getAlarm()) }
    const hash = `${sender}:${await sha256Hex(body)}`
    const earlier = this.recent.get(hash)
    if (earlier) {
      // An identical body is already stored or still being committed. Wait for that commit: never acknowledge a retry
      // before the original request is durable, and report the original's failure if it fails.
      const outcome = await earlier
      return outcome.ok ? { ...outcome, duplicate: true } : outcome
    }
    const cap = this.num('BUFFER_CAP_BYTES', 64 * 1024 * 1024)
    if (this.pendingBytes + this.queuedBytes + body.length > cap) return { ok: false, status: 429, reason: 'buffer full', retryAfter: 10 }
    const window = this.num('GROUP_COMMIT_MS', 500)
    const done = new Promise<IngestResult>(resolve => {
      this.queue.push({ lines: checked.lines, atMs: Date.now(), hash, sender, done: resolve })
      this.queuedBytes += body.length
    })
    this.recent.set(hash, done)
    if (this.recent.size > RECENT_HASHES) this.recent.delete(this.recent.keys().next().value!)
    if (window <= 0) await this.flush()
    else if (!this.timer) this.timer = setTimeout(() => { void this.flush() }, window)
    return done
  }

  /** Commit queued requests as one row per <=1M records. Acks only after the commit. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const q = this.queue
    if (q.length === 0) return
    this.queue = []
    this.queuedBytes = 0
    try {
      const rows: { id: number; data: string; events: number; bytes: number }[] = []
      let cur = { id: this.nextBatch++, data: '', events: 0, bytes: 0 }
      for (const item of q) {
        for (const line of item.lines) {
          let text = stampOne(line, cur.id, item.atMs, cur.events, item.sender)
          let size = encoder.encode(text).length
          if (cur.events > 0 && (cur.bytes + size > ROW_MAX_BYTES || cur.events > MAX_SEQ_PER_ROW)) {
            rows.push(cur)
            cur = { id: this.nextBatch++, data: '', events: 0, bytes: 0 }
            text = stampOne(line, cur.id, item.atMs, 0, item.sender)
            size = encoder.encode(text).length
          }
          cur.data += text
          cur.bytes += size
          cur.events++
        }
      }
      rows.push(cur)
      let bytes = 0
      const g = this.gen()
      if (this.failNext) { this.failNext = false; throw new Error('injected flush failure') }
      this.ctx.storage.transactionSync(() => {
        for (const r of rows) {
          bytes += r.bytes
          this.w(`INSERT INTO b_${g} VALUES(?,?,?,?)`, r.id, r.data, r.events, r.bytes)
        }
      })
      this.pendingBytes += bytes
      const alarm = await this.ctx.storage.getAlarm()
      let next = alarm
      if (this.pendingBytes >= this.num('SEAL_MAX_BYTES', 8 * 1024 * 1024)) next = Date.now()
      else if (alarm === null || alarm > Date.now() + this.num('SEAL_INTERVAL_MS', 600000)) next = Date.now() + this.num('SEAL_INTERVAL_MS', 600000) // also pulls in a far-off retention alarm
      if (next !== alarm) await this.ctx.storage.setAlarm(next!)
      const pub = this.publication(next)
      for (const item of q) item.done({ ok: true, accepted: item.lines.length, duplicate: false, publication: pub })
    } catch (e) {
      for (const item of q) { this.recent.delete(item.hash); item.done({ ok: false, status: 503, reason: 'unavailable', retryAfter: 5 }) }
      console.error('flush failed', e)
    }
  }

  async alarm(): Promise<void> {
    await this.flush()
    await this.seal()
    await this.sweep()
    const g = this.gen()
    const left = (this.sql.exec(`SELECT COUNT(*) c FROM b_${g}`).one() as { c: number }).c
    if (left > 0 && (await this.ctx.storage.getAlarm()) === null) {
      const due = this.pendingBytes >= this.num('SEAL_MAX_BYTES', 8 * 1024 * 1024)
      await this.ctx.storage.setAlarm(Date.now() + (due ? 0 : this.num('SEAL_INTERVAL_MS', 600000)))
    } else if (left === 0 && this.queue.length === 0 && this.intent() === null) await this.settleIdleAlarm()
  }

  /**
   * Seal the buffered batches into one gzip NDJSON archive. Safe to replay: rotation and the intent commit together,
   * the frozen table is immutable, the R2 key is content-addressed, and finalization is one transaction.
   */
  async seal(): Promise<ManifestRow | null> {
    const intent = this.intent() ?? this.rotate()
    if (!intent) return null
    const frozen = intent.gen
    const exists = this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='b_${frozen}'`).toArray().length > 0
    if (!exists) { this.w('DELETE FROM meta WHERE k=?', 'sealing'); return null }
    const rows = this.sql.exec(`SELECT data, events, bytes FROM b_${frozen} ORDER BY id`).toArray() as { data: string; events: number; bytes: number }[]
    const text = rows.map(r => r.data).join('')
    const events = rows.reduce((n, r) => n + r.events, 0)
    const rawBytes = rows.reduce((n, r) => n + r.bytes, 0)
    const gz = await gzip(text)
    const sha = await sha256Hex(gz)
    const name = `${pad20(intent.seq)}-${sha}.jsonl.gz`
    const r2key = `v1/projects/${this.ctx.id.name}/archives/${this.archiveId()}/events/${name}`
    await retry(() => this.env.ARCHIVE.put(r2key, gz, { httpMetadata: { contentType: 'application/gzip' } }))
    const row: ManifestRow = { seq: intent.seq, name, r2key, size: gz.length, sha256: sha, events, created_at: Date.now() }
    this.ctx.storage.transactionSync(() => {
      this.w('INSERT INTO manifest VALUES(?,?,?,?,?,?,?)', row.seq, row.name, row.r2key, row.size, row.sha256, row.events, row.created_at)
      this.setMeta('next_seq', String(intent!.seq + 1))
      this.w('DELETE FROM meta WHERE k=?', 'sealing')
      this.w(`DROP TABLE b_${frozen}`)
    })
    this.pendingBytes = Math.max(0, this.pendingBytes - rawBytes)
    const left = (this.sql.exec(`SELECT COUNT(*) c FROM b_${this.gen()}`).one() as { c: number }).c
    if (left === 0 && this.queue.length === 0) await this.settleIdleAlarm()
    return row
  }

  /** Optional retention: drop archives older than RETENTION_DAYS (0 keeps everything). */
  async sweep(): Promise<void> {
    const days = this.num('RETENTION_DAYS', 0)
    if (days <= 0) return
    const old = this.sql.exec('SELECT seq, r2key FROM manifest WHERE created_at<? ORDER BY seq LIMIT 100', Date.now() - days * 86_400_000).toArray() as { seq: number; r2key: string }[]
    if (!old.length) return
    await retry(() => this.env.ARCHIVE.delete(old.map(o => o.r2key)))
    this.w('DELETE FROM manifest WHERE seq<=?', old[old.length - 1].seq)
    if (old.length === 100 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000)
  }

  coverage(): Coverage | null {
    if (!this.initialized()) return null
    const next = Number(this.meta('next_seq') ?? 1)
    if (next === 1) return null
    const lo = (this.sql.exec('SELECT MIN(seq) m FROM manifest').one() as { m: number | null }).m
    const at = this.sql.exec('SELECT created_at c FROM manifest ORDER BY seq DESC LIMIT 1').toArray()[0] as { c: number } | undefined
    return { archiveId: this.archiveId(), firstRetained: String(lo ?? next), latestPublished: String(next - 1), latestPublishedAt: at?.c ?? Date.now() }
  }
  listObjects(after: number, limit: number): ManifestRow[] {
    if (!this.initialized()) return []
    return this.sql.exec('SELECT * FROM manifest WHERE seq>? ORDER BY seq LIMIT ?', after, limit).toArray() as ManifestRow[]
  }
  /** Where publication stands, for a coverage read: pending until the buffered events are archived. */
  async publicationStatus(): Promise<Publication> { return this.publication(await this.ctx.storage.getAlarm()) }
  /** Test hook (DEBUG only). */
  async failNextFlush(): Promise<void> { this.failNext = true }
  /** Debug statistics (the DEBUG routes only). */
  async stats() {
    if (!this.initialized()) return { pending: false, rows: 0, pendingBytes: 0, queued: 0, gen: 0, sealing: null, manifest: 0, alarm: null }
    return { pending: this.hasBuffered(), rows: this.rows, pendingBytes: this.pendingBytes, queued: this.queue.length, gen: this.gen(), sealing: this.intent(), manifest: (this.sql.exec('SELECT COUNT(*) n FROM manifest').one() as { n: number }).n, alarm: await this.ctx.storage.getAlarm() }
  }
  /** Delete every archive object this project wrote and all of its Durable Object storage (used by `slurp cloud destroy`). */
  async purge(): Promise<{ archives: number }> {
    const rows = (this.initialized() ? this.sql.exec('SELECT r2key FROM manifest').toArray() : []) as { r2key: string }[]
    for (let i = 0; i < rows.length; i += 1000) await retry(() => this.env.ARCHIVE.delete(rows.slice(i, i + 1000).map(r => r.r2key)))
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.queue = []
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    return { archives: rows.length }
  }

  /** Freeze the current generation and persist the seal intent in one transaction. Null when nothing is buffered. */
  rotate(): { gen: number; seq: number } | null {
    const g = this.gen()
    const top = this.sql.exec(`SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM b_${g}`).one() as { c: number; m: number }
    if (top.c === 0) return null
    const seq = Number(this.meta('next_seq') ?? 1)
    this.ctx.storage.transactionSync(() => {
      this.table(g + 1)
      this.setMeta('gen', String(g + 1))
      this.setMeta('batch_hwm', String(Math.max(top.m, this.nextBatch - 1)))
      this.setMeta('sealing', JSON.stringify({ gen: g, seq }))
    })
    return { gen: g, seq }
  }
}
