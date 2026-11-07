import { DurableObject } from 'cloudflare:workers'
import { type Env, sha256Hex, randomHex, gzip } from './util.ts'
import { checkBody, stampLines } from './canonical.ts'

export type IngestResult =
  | { ok: true; accepted: number; duplicate: boolean; rowsWritten: number }
  | { ok: false; status: 400 | 413; reason: string }
export type ManifestRow = { seq: number; name: string; r2key: string; size: number; sha256: string; events: number; created_at: number }

const pad20 = (n: number) => String(n).padStart(20, '0')

/** One DO per source: durable batch buffer, alarm-driven sealing to R2, manifest. */
export class SourceDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql
  pendingBytes = 0
  nextBatch = 1
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL, events INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS batches_hash ON batches(hash);
      CREATE TABLE IF NOT EXISTS manifest(seq INTEGER PRIMARY KEY, name TEXT NOT NULL, r2key TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, events INTEGER NOT NULL, created_at INTEGER NOT NULL);`)
    const hwm = Number(this.meta('batch_hwm') ?? 0)
    const row = this.sql.exec('SELECT COALESCE(MAX(id),0) m, COALESCE(SUM(bytes),0) b FROM batches').one() as any
    this.nextBatch = Math.max(hwm, row.m) + 1
    this.pendingBytes = row.b
  }
  private meta(k: string): string | null {
    const r = this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray()[0] as any
    return r ? r.v : null
  }
  private setMeta(k: string, v: string) { this.sql.exec('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v) }
  private archiveId(): string {
    let id = this.meta('archive_id')
    if (!id) { id = randomHex(8); this.setMeta('archive_id', id) }
    return id
  }

  async ingest(source: string, body: string): Promise<IngestResult> {
    const checked = checkBody(body)
    if ('reason' in checked) return { ok: false, status: 400, reason: `line ${checked.line}: ${checked.reason}` }
    const hash = await sha256Hex(body)
    let rows = 0
    const dup = this.sql.exec('SELECT 1 FROM batches WHERE hash=? LIMIT 1', hash)
    if (dup.toArray().length) return { ok: true, accepted: checked.lines.length, duplicate: true, rowsWritten: 0 }
    const id = this.nextBatch++
    const data = stampLines(checked.lines, id, Date.now())
    const bytes = new TextEncoder().encode(data).length
    const cur = this.sql.exec('INSERT INTO batches VALUES(?,?,?,?,?)', id, hash, data, checked.lines.length, bytes)
    cur.toArray(); rows += cur.rowsWritten
    this.pendingBytes += bytes
    const max = Number(this.env.SEAL_MAX_BYTES)
    if (this.pendingBytes >= max) await this.ctx.storage.setAlarm(Date.now())
    else if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + Number(this.env.SEAL_INTERVAL_MS))
    return { ok: true, accepted: checked.lines.length, duplicate: false, rowsWritten: rows }
  }

  /** Seal every buffered batch into one gzip NDJSON archive. R2 put first (content-addressed key), then one SQLite txn. */
  async alarm(): Promise<void> {
    await this.seal()
  }
  async seal(): Promise<ManifestRow | null> {
    const cap = Number(this.env.SEAL_MAX_BYTES)
    const rows = this.sql.exec('SELECT id, data, events, bytes FROM batches ORDER BY id').toArray() as any[]
    if (!rows.length) return null
    let take = 0, bytes = 0
    for (const r of rows) { if (take > 0 && bytes + r.bytes > cap) break; bytes += r.bytes; take++ }
    const chosen = rows.slice(0, take)
    const text = chosen.map(r => r.data).join('')
    const events = chosen.reduce((n, r) => n + r.events, 0)
    const gz = await gzip(text)
    const sha = await sha256Hex(gz)
    const seq = Number(this.meta('next_seq') ?? 1)
    const name = `${pad20(seq)}-${sha}.jsonl.gz`
    const source = this.ctx.id.name!
    const r2key = `v1/sources/${source}/archives/${this.archiveId()}/events/${name}`
    await this.env.ARCHIVE.put(r2key, gz, { httpMetadata: { contentType: 'application/gzip' } })
    const lastId = chosen[chosen.length - 1].id
    const row: ManifestRow = { seq, name, r2key, size: gz.length, sha256: sha, events, created_at: Date.now() }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO manifest VALUES(?,?,?,?,?,?,?)', row.seq, row.name, row.r2key, row.size, row.sha256, row.events, row.created_at)
      this.setMeta('next_seq', String(seq + 1))
      this.setMeta('batch_hwm', String(lastId))
      this.sql.exec('DELETE FROM batches WHERE id<=?', lastId)
    })
    this.pendingBytes -= bytes
    if (take < rows.length) await this.ctx.storage.setAlarm(Date.now())
    return row
  }

  coverage(): { archiveId: string; firstRetained: string; latestPublished: string | null; latestPublishedAt: number | null } | null {
    const r = this.sql.exec('SELECT MIN(seq) lo, MAX(seq) hi FROM manifest').one() as any
    if (r.hi === null) return null
    const at = (this.sql.exec('SELECT created_at c FROM manifest WHERE seq=?', r.hi).one() as any).c
    return { archiveId: this.archiveId(), firstRetained: String(r.lo), latestPublished: String(r.hi), latestPublishedAt: at }
  }
  listObjects(after: number | null, limit: number): ManifestRow[] {
    return this.sql.exec('SELECT * FROM manifest WHERE seq>? ORDER BY seq LIMIT ?', after ?? 0, limit).toArray() as ManifestRow[]
  }
  stats() {
    return {
      batches: (this.sql.exec('SELECT COUNT(*) n FROM batches').one() as any).n,
      manifest: (this.sql.exec('SELECT COUNT(*) n FROM manifest').one() as any).n,
      pendingBytes: this.pendingBytes,
    }
  }
}
