/** DATE and naive TIMESTAMP are UTC wall-clock values throughout Slurp. */
export function utcDate(value: string): Date {
  const iso = value.trim().replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso) && iso.includes('T');
  return new Date(zoned ? iso : iso + (iso.includes('T') ? 'Z' : 'T00:00:00Z'));
}
export const numeric = (type: string) =>
  /^(U?HUGEINT|U?BIGINT|TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|FLOAT|DOUBLE|DECIMAL|REAL)/i.test(
    type,
  );
