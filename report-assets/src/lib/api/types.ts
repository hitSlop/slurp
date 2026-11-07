/** A query result as the chart code reads it: column names and types, and rows in column order. */
export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
}
