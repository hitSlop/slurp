---
purpose: Which release broke exports
---

# Which release broke exports?

```sql by_release
SELECT
  context->>'$.app.version' AS release,
  round(100.0 * count(*) FILTER (
    WHERE event = 'export_completed'
  ) / count(*) FILTER (
    WHERE event = 'export_started'
  ), 1) AS completed
FROM events
GROUP BY 1
ORDER BY 1
```

```chart
query: by_release
title: Exports completed, % of started
spec:
  height: 170
  mark: bar
  encoding:
    x:
      field: release
      axis: {labelAngle: 0}
      title: null
    y:
      field: completed
      type: quantitative
      title: null
    color:
      field: release
      legend: null
```
