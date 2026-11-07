---
purpose: Why export completion dropped after v1.2.4
---

# Why do large exports fail?

Export completion fell from 94% to 79% when v1.2.4 shipped on Sep 7, and recovered to 92% with v1.2.5 on Oct 7. The drop is almost entirely exports over 500 MB. Sample data from a fictional app, written by a coding agent from the SQL below.

```sql headline
SELECT
  count(*) FILTER (WHERE event = 'export_started') AS started,
  round(100.0 * count(*) FILTER (WHERE event = 'export_completed')
        / count(*) FILTER (WHERE event = 'export_started'), 1) AS completion,
  count(*) FILTER (WHERE event = 'export_failed') AS failed
FROM events
WHERE timestamp >= (SELECT max(timestamp) FROM events) - INTERVAL 30 DAY
```

```metric
query: headline
field: started
label: Exports started, last 30 days
width: third
```

```metric
query: headline
field: completion
label: Completion, last 30 days (%)
width: third
```

```metric
query: headline
field: failed
label: Failures, last 30 days
width: third
```

```sql weekly
SELECT
  date_trunc('week', timezone('UTC', timestamp))::DATE AS week,
  mode(context->>'$.app.version') AS release,
  round(100.0 * count(*) FILTER (WHERE event = 'export_completed')
        / count(*) FILTER (WHERE event = 'export_started'), 1) AS completion
FROM events
GROUP BY 1
HAVING min(timezone('UTC', timestamp))::DATE <= week + 1
   AND week < (SELECT date_trunc('week', timezone('UTC', max(timestamp)))::DATE FROM events)
   AND count(*) FILTER (WHERE event = 'export_started') > 100
ORDER BY 1
```

```chart
query: weekly
title: Export completion by week
spec:
  height: 190
  layer:
    - mark: {type: line, color: "#9aa3ad", strokeWidth: 2}
      encoding:
        x: {field: week, type: temporal, title: null, axis: {format: "%b %d"}}
        y: {field: completion, type: quantitative, title: "Completed, % of started", scale: {domain: [60, 100]}}
    - mark: {type: point, filled: true, size: 90}
      encoding:
        x: {field: week, type: temporal}
        y: {field: completion, type: quantitative}
        color: {field: release, type: nominal, title: Release}
```

```sql by_size
SELECT
  CASE WHEN (data->>'$.file_size_mb')::DOUBLE < 10 THEN 'Under 10'
       WHEN (data->>'$.file_size_mb')::DOUBLE < 100 THEN '10 to 100'
       WHEN (data->>'$.file_size_mb')::DOUBLE < 500 THEN '100 to 500'
       ELSE 'Over 500' END AS size,
  context->>'$.app.version' AS release,
  round(100.0 * count(*) FILTER (WHERE event = 'export_completed')
        / count(*) FILTER (WHERE event = 'export_started'), 1) AS completion
FROM events
WHERE event IN ('export_started', 'export_completed')
GROUP BY 1, 2
ORDER BY 2, 1
```

```chart
query: by_size
title: Completion by file size and release
width: half
spec:
  height: 210
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: size, type: nominal, title: "File size, MB", axis: {labelAngle: 0}, sort: ["Under 10", "10 to 100", "100 to 500", "Over 500"]}
    xOffset: {field: release}
    y: {field: completion, type: quantitative, title: "Completed, % of started", scale: {domain: [0, 100]}}
    color: {field: release, type: nominal, title: Release}
```

```sql errors
SELECT
  coalesce(data->>'$.error', 'validation') AS "Failure reason",
  count(*) FILTER (WHERE context->>'$.app.version' = 'v1.2.3') AS "v1.2.3",
  count(*) FILTER (WHERE context->>'$.app.version' = 'v1.2.4') AS "v1.2.4",
  count(*) FILTER (WHERE context->>'$.app.version' = 'v1.2.5') AS "v1.2.5"
FROM events
WHERE event = 'export_failed'
GROUP BY 1
ORDER BY "v1.2.4" DESC
```

```table
query: errors
title: Failed exports by reason
width: half
```

> Finding: on v1.2.4, nearly 9 in 10 exports over 500 MB failed, mostly out of memory. Smaller exports also lost about 9 points. v1.2.5 restores small exports to 95%, but files over 500 MB still fail a third of the time. Next: stream large renders instead of buffering them, then re-run this report on the next release.
