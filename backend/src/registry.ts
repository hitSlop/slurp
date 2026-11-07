import { DurableObject } from 'cloudflare:workers'
import { type Env, randomHex, sha256Hex, b64url } from './util.ts'

export type SourceRow = { id: string; name: string; title: string | null; owner_id: string; created_at: string; geo_enabled: number }
export type KeyRow = { key_id: string; source: string; scope: string; name: string; hash: string; created_at: string; revoked_at: string | null }
export type Result<T> = { ok: true; value: T } | { ok: false; code: 'invalid' | 'exists' | 'notfound'; message: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const RESERVED_PREFIXES = ['session_', 'src_', 'mdl_']
// Reserved words from the local SQL engine (slurp-core sql.rs/columns.rs), which source names double as table aliases for.
const RESERVED_WORDS = new Set(('_slurp add all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create default deferrable desc describe distinct do else end except false fetch for foreign from group having in information_schema initially intersect into lake lambda lateral leading limit main memory not null offset on only or order pg_catalog pivot pivot_longer pivot_wider placing primary qualify raw references returning select show some summarize symmetric system table temp then to trailing true union unique unpivot using variadic when where window with').split(' '))

/** Same alias rules as the Go gateway (validSourceName): 1-63 chars of a-z 0-9 _, starting with a letter, no "__", no reserved prefix or word. */
export function validSourceName(name: string): boolean {
  return name.length >= 1 && name.length <= 63 && /^[a-z][a-z0-9_]*$/.test(name) && !name.includes('__')
    && !RESERVED_PREFIXES.some(p => name.startsWith(p)) && !RESERVED_WORDS.has(name)
}
export function validTitle(title: string | undefined): boolean {
  return title === undefined || new TextEncoder().encode(title).length <= 200
}
const NAME = { test: validSourceName }

export class RegistryDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ensureSchema()
  }

  private ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, geo_enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS keys(key_id TEXT PRIMARY KEY, source TEXT NOT NULL, scope TEXT NOT NULL, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY, source TEXT NOT NULL, key_id TEXT NOT NULL);`)
  }

  private async mintKey(source: string, scope: 'publishable' | 'secret', name: string): Promise<{ key: string; keyId: string }> {
    const key = (scope === 'publishable' ? 'slurp_pk_' : 'slurp_sk_') + b64url(crypto.getRandomValues(new Uint8Array(24)))
    const hash = await sha256Hex(key)
    const keyId = hash.slice(0, 16)
    this.sql.exec('INSERT INTO keys VALUES(?,?,?,?,?,?,NULL)', keyId, source, scope, name, hash, new Date().toISOString())
    return { key, keyId }
  }

  async createSource(a: { name: string; title?: string; geoEnabled?: boolean; requestId: string }): Promise<Result<{ source: SourceRow; key: string }>> {
    const prior = this.sql.exec('SELECT source, key_id FROM requests WHERE request_id=?', a.requestId).toArray()[0] as any
    if (prior) {
      this.sql.exec('UPDATE keys SET revoked_at=COALESCE(revoked_at,?) WHERE key_id=?', new Date().toISOString(), prior.key_id)
      const { key, keyId } = await this.mintKey(prior.source, 'publishable', 'Default')
      this.sql.exec('UPDATE requests SET key_id=? WHERE request_id=?', keyId, a.requestId)
      return { ok: true, value: { source: this.sql.exec('SELECT * FROM sources WHERE id=?', prior.source).one() as SourceRow, key } }
    }
    if (!UUID.test(a.requestId) || !NAME.test(a.name) || !validTitle(a.title)) return { ok: false, code: 'invalid', message: 'invalid source details' }
    if (this.sql.exec('SELECT 1 FROM sources WHERE name=?', a.name).toArray().length) return { ok: false, code: 'exists', message: 'name exists' }
    const id = 'src_' + randomHex(8)
    this.sql.exec('INSERT INTO sources VALUES(?,?,?,?,?,?)', id, a.name, a.title ?? null, 'admin', new Date().toISOString(), a.geoEnabled ? 1 : 0)
    const { key, keyId } = await this.mintKey(id, 'publishable', 'Default')
    this.sql.exec('INSERT INTO requests VALUES(?,?,?)', a.requestId, id, keyId)
    return { ok: true, value: { source: this.sql.exec('SELECT * FROM sources WHERE id=?', id).one() as SourceRow, key } }
  }
  getSource(ref: string): SourceRow | null {
    return (this.sql.exec('SELECT * FROM sources WHERE id=? OR name=? LIMIT 1', ref, ref).toArray()[0] as SourceRow) ?? null
  }
  listSources(): SourceRow[] { return this.sql.exec('SELECT * FROM sources ORDER BY id').toArray() as SourceRow[] }
  updateSource(ref: string, p: { name?: string; title?: string; geoEnabled?: boolean }): Result<SourceRow> {
    const s = this.getSource(ref); if (!s) return { ok: false, code: 'notfound', message: 'source' }
    if (!validTitle(p.title)) return { ok: false, code: 'invalid', message: 'bad title' }
    if (p.name !== undefined) {
      if (!NAME.test(p.name)) return { ok: false, code: 'invalid', message: 'bad name' }
      if (p.name !== s.name && this.sql.exec('SELECT 1 FROM sources WHERE name=?', p.name).toArray().length) return { ok: false, code: 'exists', message: 'name exists' }
      this.sql.exec('UPDATE sources SET name=? WHERE id=?', p.name, s.id)
    }
    if (p.title !== undefined) this.sql.exec('UPDATE sources SET title=? WHERE id=?', p.title === '' ? null : p.title, s.id)
    if (p.geoEnabled !== undefined) this.sql.exec('UPDATE sources SET geo_enabled=? WHERE id=?', p.geoEnabled ? 1 : 0, s.id)
    return { ok: true, value: this.getSource(s.id)! }
  }
  async createKey(ref: string, scope: string, name?: string): Promise<Result<{ key: string; keyId: string }>> {
    const s = this.getSource(ref); if (!s) return { ok: false, code: 'notfound', message: 'source' }
    if (scope !== 'publishable' && scope !== 'secret') return { ok: false, code: 'invalid', message: 'scope must be publishable or secret' }
    if (new TextEncoder().encode(name ?? '').length > 200) return { ok: false, code: 'invalid', message: 'name too long' }
    return { ok: true, value: await this.mintKey(s.id, scope, name ?? '') }
  }
  listKeys(ref: string, scope?: string): KeyRow[] | null {
    const s = this.getSource(ref); if (!s) return null
    return this.sql.exec('SELECT * FROM keys WHERE source=? ORDER BY created_at, key_id', s.id).toArray()
      .filter((k: any) => !scope || k.scope === scope) as KeyRow[]
  }
  revokeKey(ref: string, keyId: string): Result<KeyRow> {
    const s = this.getSource(ref); if (!s) return { ok: false, code: 'notfound', message: 'source' }
    const k = this.sql.exec('SELECT * FROM keys WHERE key_id=? AND source=?', keyId, s.id).toArray()[0] as KeyRow | undefined
    if (!k) return { ok: false, code: 'notfound', message: 'key' }
    if (!k.revoked_at) this.sql.exec('UPDATE keys SET revoked_at=? WHERE key_id=?', new Date().toISOString(), keyId)
    return { ok: true, value: this.sql.exec('SELECT * FROM keys WHERE key_id=?', keyId).one() as KeyRow }
  }
  /** Forget every source and key (used by `slurp cloud destroy`). */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.ensureSchema()
  }
  /** Resolve a presented key by SHA-256; revoked keys never resolve. */
  resolveKey(hash: string): { source: string; scope: string; geo: boolean } | null {
    const r = this.sql.exec('SELECT k.source, k.scope, s.geo_enabled g FROM keys k JOIN sources s ON s.id=k.source WHERE k.hash=? AND k.revoked_at IS NULL', hash).toArray()[0] as any
    return r ? { source: r.source, scope: r.scope, geo: !!r.g } : null
  }
}
