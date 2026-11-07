---
purpose: Where people drop out of the export flow
extensions: [behavioral]
---

# Where does the export flow leak?

Of the sessions that open the export dialog, 84% start an export and 76% finish one. The leaks are at the very start and, for MP4, at the very end. Each step counts a session only if it follows the one before it within an hour. Sample data from a fictional app, written by a coding agent.

```sql funnel
WITH per_session AS (
  SELECT session_id,
         window_funnel(INTERVAL 1 HOUR, timezone('UTC', timestamp)::TIMESTAMP,
           event = 'export_opened', event = 'export_started', event = 'export_validated', event = 'export_completed') AS level
  FROM events WHERE session_id IS NOT NULL AND event LIKE 'export_%'
  GROUP BY session_id
)
SELECT step, n FROM (
  SELECT '1 Opened' AS step, count(*) FILTER (WHERE level >= 1) AS n FROM per_session
  UNION ALL SELECT '2 Started', count(*) FILTER (WHERE level >= 2) FROM per_session
  UNION ALL SELECT '3 Validated', count(*) FILTER (WHERE level >= 3) FROM per_session
  UNION ALL SELECT '4 Completed', count(*) FILTER (WHERE level >= 4) FROM per_session
) ORDER BY step
```

```chart
query: funnel
title: Export funnel, sessions reaching each step
width: half
spec:
  height: 220
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    y: {field: step, type: nominal, title: null}
    x: {field: n, type: quantitative, title: null}
    color: {field: step, type: nominal, legend: null}
```

```sql by_format
SELECT upper(data->>'$.format') AS format,
  round(100.0 * count(*) FILTER (WHERE event = 'export_completed')
        / count(*) FILTER (WHERE event = 'export_started'), 1) AS completion
FROM events WHERE event IN ('export_started', 'export_completed')
GROUP BY 1 ORDER BY 1
```

```chart
query: by_format
title: Completion by format, % of started
width: half
spec:
  height: 220
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: format, type: nominal, title: null, axis: {labelAngle: 0}}
    y: {field: completion, type: quantitative, title: null, scale: {domain: [0, 100]}}
    color: {field: format, type: nominal, legend: null}
```

```sql daily
SELECT date_trunc('week', timezone('UTC', timestamp))::DATE AS week, event, count(*) AS events
FROM events
WHERE event IN ('export_completed', 'export_failed', 'export_opened')
GROUP BY 1, 2
HAVING week > (SELECT date_trunc('week', timezone('UTC', min(timestamp)))::DATE FROM events)
   AND week < (SELECT date_trunc('week', timezone('UTC', max(timestamp)))::DATE FROM events)
ORDER BY 1, 2
```

```chart
query: daily
title: Weekly export activity
spec:
  height: 210
  mark: {type: area, opacity: 0.45, line: true}
  encoding:
    x: {field: week, type: temporal, title: null, axis: {format: "%b %d"}}
    y: {field: events, type: quantitative, title: null, stack: null}
    color: {field: event, type: nominal, title: Event}
```
