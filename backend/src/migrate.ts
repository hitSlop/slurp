/** The stored version is newer than the code knows: this code must not read or write the data. */
export class SchemaTooNew extends Error {
  readonly stored: number
  readonly supported: number
  constructor(stored: number, supported: number) {
    super(`stored schema version ${stored} is newer than the ${supported} this code understands`)
    this.name = 'SchemaTooNew'
    this.stored = stored
    this.supported = supported
  }
}

/**
 * Bring a Durable Object's SQLite up to the latest of `steps`. Step `i` takes version `i` to `i + 1`; the version lives in the
 * single-row `_schema` table (no row means 0). Each missing step runs in one transaction together with its version bump, so a step that
 * throws leaves the storage exactly as it was and the next start tries it again. Steps are append-only: a shipped step is never edited.
 * Throws `SchemaTooNew` when the stored version is past the last step (nothing is written then).
 */
export function migrate(storage: DurableObjectStorage, steps: readonly string[]): void {
  const sql = storage.sql
  sql.exec('CREATE TABLE IF NOT EXISTS _schema(version INTEGER NOT NULL)')
  const stored = (sql.exec('SELECT version FROM _schema').toArray()[0]?.version as number | undefined) ?? 0
  if (stored > steps.length) throw new SchemaTooNew(stored, steps.length)
  for (let i = stored; i < steps.length; i++) {
    storage.transactionSync(() => {
      sql.exec(steps[i])
      sql.exec('DELETE FROM _schema')
      sql.exec('INSERT INTO _schema(version) VALUES(?)', i + 1)
    })
  }
}
