---
purpose: Text and chart edge cases
---

# Text, charts and edge cases

```sql names
SELECT * FROM (VALUES
  ('日本語のイベント名', 12), ('Ünïcödé café', 9), ('emoji 🚀 launch', 7), ('مرحبا بالعالم', 5),
  ('<script>alert(1)</script>', 4), ('a & b "quoted" <b>bold</b>', 3),
  ('an_extremely_long_event_name_with_no_spaces_that_will_collide_with_neighbouring_labels_on_an_axis', 2)
) t(name, n)
```

```table
query: names
title: Scripts and symbols
```

```chart
query: names
title: Bar chart with long and non-latin labels
spec:
  height: 260
  mark: bar
  encoding:
    x: {field: name, type: nominal, title: null}
    y: {field: n, type: quantitative}
```

```chart
query: names
title: Horizontal bars
width: half
spec:
  height: 260
  mark: bar
  encoding:
    y: {field: name, type: nominal, title: null, sort: "-x"}
    x: {field: n, type: quantitative}
```

```sql empty
SELECT 'x' AS name, 1 AS n WHERE false
```

```chart
query: empty
title: Chart with no rows
width: half
spec:
  height: 260
  mark: bar
  encoding:
    x: {field: name, type: nominal}
    y: {field: n, type: quantitative}
```

```table
query: empty
title: Table with no rows
```

```sql dense
SELECT i AS x, sin(i / 20.0) * 50 + 50 + (random() * 5) AS y, 'c' || (i % 40) AS cat, (TIMESTAMP '2026-01-01' + to_days(i))::VARCHAR AS day FROM range(0, 1000) t(i)
```

```chart
query: dense
title: A thousand points
spec:
  height: 240
  mark: line
  encoding:
    x: {field: day, type: temporal}
    y: {field: y, type: quantitative}
```

```chart
query: dense
title: A thousand categories
spec:
  height: 240
  mark: bar
  encoding:
    x: {field: cat, type: nominal}
    y: {field: y, aggregate: sum, type: quantitative}
```
