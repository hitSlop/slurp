/** A project's SQLite, plus a count of the rows it has written (what Durable Object SQLite bills). */
export class Db {
  /** Rows written since this object was constructed, and `setAlarm`/`deleteAlarm` calls (each bills a row too). */
  rowsWritten = 0
  alarmWrites = 0
  readonly sql: SqlStorage
  constructor(sql: SqlStorage) { this.sql = sql }

  /** Run a statement to the end and return its rows. */
  rows<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.sql.exec(query, ...bindings)
    const out = cursor.toArray() as T[]
    this.rowsWritten += cursor.rowsWritten
    return out
  }
  one<T>(query: string, ...bindings: SqlStorageValue[]): T | undefined { return this.rows<T>(query, ...bindings)[0] }
}

/**
 * Every table, all `IF NOT EXISTS`, so one statement both creates a project's storage and brings an older one up to date.
 * `chunks` keeps its large `data` column last, so reading the small columns never walks the data's overflow pages.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys(key_id TEXT PRIMARY KEY, scope TEXT NOT NULL, source TEXT, name TEXT, plain TEXT UNIQUE, hash TEXT UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS webhooks(provider TEXT PRIMARY KEY, source TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, events INTEGER NOT NULL, bytes INTEGER NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intent(seq INTEGER PRIMARY KEY, through_chunk INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS manifest(seq INTEGER PRIMARY KEY, size INTEGER NOT NULL, sha256 TEXT NOT NULL, events INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`
