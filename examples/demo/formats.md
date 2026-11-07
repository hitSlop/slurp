---
purpose: Which export formats people use, and how long each takes
---

# What are people exporting?

PDF is the volume, MP4 is the weight: a small share of exports take most of the time. Sample data from a fictional app, written by a coding agent.

```sql totals
SELECT
  count(*) AS completed,
  CAST(round(quantile_cont((data->>'$.duration_s')::DOUBLE, 0.5)) AS BIGINT) AS median_s,
  CAST(round(max((data->>'$.file_size_mb')::DOUBLE)) AS BIGINT) AS largest_mb
FROM events WHERE event = 'export_completed'
```

```metric
query: totals
field: completed
label: Exports completed, 90 days
width: third
```

```metric
query: totals
field: median_s
label: Median export time, seconds
width: third
```

```metric
query: totals
field: largest_mb
label: Largest export, MB
width: third
```

```sql by_format
SELECT upper(data->>'$.format') AS format, count(*) AS exports
FROM events WHERE event = 'export_completed'
GROUP BY 1 ORDER BY 2 DESC
```

```chart
query: by_format
title: Share of exports by format
width: half
spec:
  height: 220
  mark: {type: arc, innerRadius: 52, stroke: "#ffffff", strokeWidth: 2}
  encoding:
    theta: {field: exports, type: quantitative}
    color: {field: format, type: nominal, title: Format}
```

```sql speed
SELECT upper(data->>'$.format') AS format, stat,
  round(CASE stat WHEN 'median' THEN quantile_cont((data->>'$.duration_s')::DOUBLE, 0.5)
                  ELSE quantile_cont((data->>'$.duration_s')::DOUBLE, 0.9) END) AS seconds
FROM events, (VALUES ('median'), ('p90')) AS s(stat)
WHERE event = 'export_completed'
GROUP BY 1, 2
ORDER BY 1, 2
```

```chart
query: speed
title: Export time by format, seconds
width: half
spec:
  height: 220
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    y: {field: format, type: nominal, title: null}
    yOffset: {field: stat}
    x: {field: seconds, type: quantitative, title: null}
    color: {field: stat, type: nominal, title: null}
```

```sql scatter
SELECT
  (data->>'$.file_size_mb')::DOUBLE AS size_mb,
  (data->>'$.duration_s')::DOUBLE AS seconds,
  upper(data->>'$.format') AS format
FROM events WHERE event = 'export_completed'
USING SAMPLE reservoir(300 ROWS) REPEATABLE (7)
```

```chart
query: scatter
title: File size against export time (a sample of 300 exports)
spec:
  height: 230
  mark: {type: point, filled: true, size: 60, opacity: 0.85}
  encoding:
    x: {field: size_mb, type: quantitative, title: "File size, MB (log)", scale: {type: log}, axis: {tickCount: 4}}
    y: {field: seconds, type: quantitative, title: "Seconds (log)", scale: {type: log}, axis: {tickCount: 4}}
    color: {field: format, type: nominal, title: Format}
```
