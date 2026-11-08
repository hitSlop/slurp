# Overview

Summary totals cover all time. People means distinct known or anonymous people with tracked activity. Identify records link identities; they do not count as activity. All times are UTC.

```sql summary
SELECT * FROM slurp_summary
```

```metric
query: summary
field: people
label: Active people
width: half
```

```metric
query: summary
field: tracked_events
label: Tracked events
width: half
```

```sql record_range
SELECT events AS total_records, first_event, last_event FROM slurp_summary
```

```table
query: record_range
title: Record totals and date range
```

## Daily activity (last 30 days)

```sql daily
WITH activity AS (
  SELECT timestamp::DATE AS day, count(*) AS events, count(DISTINCT person_id) AS people
  FROM events_with_person
  WHERE type = 'track' AND timestamp >= current_date - INTERVAL 29 DAY AND timestamp < current_date + INTERVAL 1 DAY
  GROUP BY 1
)
SELECT c.biz_date AS day, coalesce(a.events, 0) AS events, coalesce(a.people, 0) AS people
FROM calendar(current_date - 29, current_date) c LEFT JOIN activity a ON a.day = c.biz_date
ORDER BY day
```

```chart
query: daily
title: Tracked events per day
width: half
spec:
  mark: line
  encoding:
    x: {field: day, type: temporal, title: Date (UTC)}
    y: {field: events, type: quantitative, title: Events}
```

```chart
query: daily
title: Active people per day
width: half
spec:
  mark: line
  encoding:
    x: {field: day, type: temporal, title: Date (UTC)}
    y: {field: people, type: quantitative, title: People}
```

```sql top_events
SELECT event, count(*) AS events FROM events_with_person WHERE type = 'track'
GROUP BY event ORDER BY events DESC, event LIMIT 20
```

```table
query: top_events
title: Top tracked events (all time)
```

## Coverage (all time)

Missing identity or request country can be intentional. Location describes the upload request and may locate a sending server. These counts describe coverage, not invalid data. Run `slurp health` for data-quality checks.

```sql coverage
SELECT 'Tracked events without a person' AS coverage, events_without_person AS events FROM slurp_summary
UNION ALL
SELECT 'Tracked events without a request country', events_without_geo FROM slurp_summary
```

```table
query: coverage
```
