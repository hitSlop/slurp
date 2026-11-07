---
purpose: Layout stress test with a deliberately long purpose line that keeps going and going to see what the top bar does with it
---

# Layout stress

```sql one
SELECT 1234567.891 AS big, -42 AS neg, NULL::INT AS nothing, 0.000123 AS tiny, 12345678901234567890::HUGEINT AS huge, 'text value' AS s
```

```metric
query: one
field: big
label: A very long metric label that goes on and on to see whether it wraps or overflows its card in the grid
width: third
```

```metric
query: one
field: neg
label: Negative as currency
prefix: "$"
decimals: 2
width: third
```

```metric
query: one
field: nothing
label: Null value
width: third
```

```metric
query: one
field: huge
label: Compact
compact: true
width: third
```

```metric
query: one
field: tiny
label: Tiny
width: third
```

```sql wide
SELECT 'alpha' AS a, 'a long cell value that should wrap or truncate somewhere sensible' AS b, 123456789 AS c, 0.5 AS d, 'x' AS e, 'y' AS f, 'https://example.com/a/very/long/unbroken/url/that/has/no/spaces/at/all/and/keeps/going/and/going/forever' AS g, 1 AS h, 2 AS i, 3 AS j, 4 AS k, 5 AS l, 6 AS m, 7 AS n, 8 AS o
```

```table
query: wide
title: Fifteen columns with long unbroken text
```

```sql many
SELECT i, CASE WHEN i = 1 THEN NULL ELSE i * 1.5 END AS v, 'row ' || i AS label FROM range(1, 251) t(i)
```

```table
query: many
title: Two hundred and fifty rows (limit defaults to 100)
limit: 5
formats:
  v: {decimals: 1, suffix: " x"}
```

```metric
query: one
field: s
label: Text as metric
width: half
```

```table
query: one
title: Half table next to half metric
width: half
```

```table
query: one
title: Lone half table
width: half
```

```metric
query: one
field: big
label: A third after a half
width: third
```
