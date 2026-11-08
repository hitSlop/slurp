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
 * A project's storage, as migration steps (see `migrate.ts`). Step 0 is version 1: every table. Steps are append-only; a shipped step is
 * never edited, a change to the layout is a new step after it.
 * `chunks` keeps its large `data` column last, so reading the small columns never walks the data's overflow pages.
 */
const V1 = `
CREATE TABLE keys(key_id TEXT PRIMARY KEY, scope TEXT NOT NULL, source TEXT, name TEXT, plain TEXT UNIQUE, hash TEXT UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE webhooks(provider TEXT PRIMARY KEY, source TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE chunks(id INTEGER PRIMARY KEY, events INTEGER NOT NULL, bytes INTEGER NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE intent(seq INTEGER PRIMARY KEY, through_chunk INTEGER NOT NULL);
CREATE TABLE manifest(seq INTEGER PRIMARY KEY, size INTEGER NOT NULL, sha256 TEXT NOT NULL, events INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, format INTEGER NOT NULL DEFAULT 1);
CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`
export const PROJECT_STEPS: readonly string[] = [V1]
