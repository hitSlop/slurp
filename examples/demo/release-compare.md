---
purpose: How releases v1.2.3 to v1.2.5 compare on exports
---

# How did each release do?

A side-by-side of the three releases in the last 90 days: how often exports finish, how long they take, and what goes wrong. Sample data from a fictional app, written by a coding agent.

```sql releases
SELECT
  context->>'$.app.version' AS "Release",
  count(*) FILTER (WHERE event = 'export_started') AS "Exports started",
  round(100.0 * count(*) FILTER (WHERE event = 'export_completed')
        / count(*) FILTER (WHERE event = 'export_started'), 1) AS "Completed %",
  round(quantile_cont((data->>'$.duration_s')::DOUBLE, 0.5) FILTER (WHERE event = 'export_completed')) AS "Median seconds",
  round(quantile_cont((data->>'$.duration_s')::DOUBLE, 0.9) FILTER (WHERE event = 'export_completed')) AS "p90 seconds"
FROM events
GROUP BY 1
ORDER BY 1
```

```table
query: releases
title: Releases at a glance
```

```sql mix
SELECT
  context->>'$.app.version' AS release,
  coalesce(data->>'$.error', 'validation') AS reason,
  round(100.0 * count(*) / (SELECT count(*) FROM events e2 WHERE e2.event = 'export_started' AND e2.context->>'$.app.version' = context->>'$.app.version'), 1) AS pct
FROM events
WHERE event = 'export_failed'
GROUP BY 1, 2
ORDER BY 1, 2
```

```chart
query: mix
title: Failures by reason (% of exports started)
width: half
spec:
  height: 220
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: release, type: nominal, title: null, axis: {labelAngle: 0}}
    y: {field: pct, type: quantitative, title: "% of exports started"}
    color: {field: reason, type: nominal, title: Reason}
```

```sql weekly_signups
SELECT date_trunc('week', timezone('UTC', timestamp))::DATE AS week, count(*) AS signups
FROM events WHERE event = 'signed_up'
GROUP BY 1
HAVING week > (SELECT date_trunc('week', timezone('UTC', min(timestamp)))::DATE FROM events)
   AND week < (SELECT date_trunc('week', timezone('UTC', max(timestamp)))::DATE FROM events)
ORDER BY 1
```

```chart
query: weekly_signups
title: New users per week
width: half
spec:
  height: 170
  layer:
    - mark: {type: area, opacity: 0.25, color: "#0877bc", line: {color: "#0877bc"}}
      encoding:
        x: {field: week, type: temporal, title: null, axis: {format: "%b %d"}}
        y: {field: signups, type: quantitative, title: "Sign-ups"}
```
