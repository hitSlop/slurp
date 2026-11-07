# Product events

This report reads the locally synchronized events. Your Worker seals archives about every 10 minutes.

```sql totals
SELECT count(*) AS events FROM events
```

```metric
query: totals
field: events
label: Events
```

```sql volume
SELECT event, count(*) AS count FROM events WHERE type = 'track' GROUP BY event ORDER BY count DESC
```

```chart
query: volume
title: Events by name
spec:
  mark: bar
  encoding:
    x: {field: event, type: nominal}
    y: {field: count, type: quantitative}
```

```table
query: volume
title: Event totals
```
