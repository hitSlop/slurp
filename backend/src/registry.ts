import { DurableObject } from 'cloudflare:workers'
import { type Env, randomHex } from './util.ts'

export type ProjectRow = { id: string; name: string; title: string | null; created_at: string }
export type Result<T> = { ok: true; value: T } | { ok: false; code: 'invalid' | 'exists' | 'notfound'; message: string }

const RESERVED_PREFIXES = ['session_', 'prj_', 'mdl_']
// Reserved words from the local SQL engine (slurp-core sql.rs/columns.rs), which project names double as table aliases for.
const RESERVED_WORDS = new Set(('_slurp add all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create default deferrable desc describe distinct do else end except false fetch for foreign from group having in information_schema initially intersect into lake lambda lateral leading limit main memory not null offset on only or order pg_catalog pivot pivot_longer pivot_wider placing primary qualify raw references returning select show some summarize symmetric system table temp then to trailing true union unique unpivot using variadic when where window with').split(' '))

/** Project alias rules (the local DuckDB uses the same names as table aliases): 1-63 chars of a-z 0-9 _, starting with a letter, no "__", no reserved prefix or word. */
export function validProjectName(name: string): boolean {
  return name.length >= 1 && name.length <= 63 && /^[a-z][a-z0-9_]*$/.test(name) && !name.includes('__')
    && !RESERVED_PREFIXES.some(p => name.startsWith(p)) && !RESERVED_WORDS.has(name)
}
export function validTitle(title: string | undefined): boolean {
  return title === undefined || new TextEncoder().encode(title).length <= 200
}
const NAME = { test: validProjectName }

export class RegistryDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, created_at TEXT NOT NULL)')
  }

  /** The project with this name, creating it first if there is none. Repeating a call returns the same project. */
  claim(a: { name: string; title?: string }): Result<{ project: ProjectRow; created: boolean }> {
    if (!NAME.test(a.name) || !validTitle(a.title)) return { ok: false, code: 'invalid', message: 'invalid project details' }
    const existing = this.sql.exec('SELECT * FROM projects WHERE name=?', a.name).toArray()[0] as ProjectRow | undefined
    if (existing) return { ok: true, value: { project: existing, created: false } }
    const id = 'prj_' + randomHex(8)
    this.sql.exec('INSERT INTO projects VALUES(?,?,?,?)', id, a.name, a.title ?? null, new Date().toISOString())
    return { ok: true, value: { project: this.get(id)!, created: true } }
  }
  get(ref: string): ProjectRow | null {
    return (this.sql.exec('SELECT * FROM projects WHERE id=? OR name=? LIMIT 1', ref, ref).toArray()[0] as ProjectRow) ?? null
  }
  list(): ProjectRow[] { return this.sql.exec('SELECT * FROM projects ORDER BY id').toArray() as ProjectRow[] }
  update(ref: string, p: { name?: string; title?: string }): Result<ProjectRow> {
    const s = this.get(ref); if (!s) return { ok: false, code: 'notfound', message: 'project' }
    if (!validTitle(p.title)) return { ok: false, code: 'invalid', message: 'bad title' }
    if (p.name !== undefined && !NAME.test(p.name)) return { ok: false, code: 'invalid', message: 'bad name' }
    if (p.name !== undefined && p.name !== s.name && this.sql.exec('SELECT 1 FROM projects WHERE name=?', p.name).toArray().length) return { ok: false, code: 'exists', message: 'name exists' }
    this.ctx.storage.transactionSync(() => {
      if (p.name !== undefined) this.sql.exec('UPDATE projects SET name=? WHERE id=?', p.name, s.id)
      if (p.title !== undefined) this.sql.exec('UPDATE projects SET title=? WHERE id=?', p.title === '' ? null : p.title, s.id)
    })
    return { ok: true, value: this.get(s.id)! }
  }
  /** Forget every project (used by `slurp cloud destroy`). */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.sql.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, created_at TEXT NOT NULL)')
  }
}
