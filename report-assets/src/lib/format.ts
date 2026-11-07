export const number = (v: number) => new Intl.NumberFormat('en-US').format(v);
export function format(v: unknown, kind = 'number', currency = 'USD') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  return new Intl.NumberFormat(
    'en-US',
    kind === 'currency'
      ? { style: 'currency', currency, maximumFractionDigits: 2 }
      : kind === 'percent'
        ? { style: 'percent', maximumFractionDigits: 1 }
        : kind === 'compact'
          ? { notation: 'compact', maximumFractionDigits: 1 }
          : { maximumFractionDigits: 2 },
  ).format(n);
}
/** DATE and naive TIMESTAMP are UTC wall-clock values throughout Slurp. */
export function utcDate(value: string): Date {
  const iso = value.trim().replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso) && iso.includes('T');
  return new Date(zoned ? iso : iso + (iso.includes('T') ? 'Z' : 'T00:00:00Z'));
}
export function absoluteUtc(value: string): string {
  const date = utcDate(value);
  return Number.isFinite(date.getTime())
    ? date
        .toISOString()
        .replace('T', ' ')
        .replace(/\.000Z$/, ' UTC')
        .replace(/Z$/, ' UTC')
    : 'Time unavailable';
}
export function relativeTime(value: string) {
  const seconds = Math.max(0, (Date.now() - utcDate(value).getTime()) / 1000);
  return seconds < 60
    ? 'just now'
    : seconds < 3600
      ? Math.floor(seconds / 60) + 'm ago'
      : seconds < 86400
        ? Math.floor(seconds / 3600) + 'h ago'
        : Math.floor(seconds / 86400) + 'd ago';
}
export const numeric = (type: string) =>
  /^(U?HUGEINT|U?BIGINT|TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|FLOAT|DOUBLE|DECIMAL|REAL)/i.test(
    type,
  );
