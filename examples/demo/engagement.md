---
purpose: How often people use the app, and for how long
extensions: [behavioral]
---

# How engaged are people?

Three views of engagement: how many of last month's users show up on a given day, how long a visit lasts, and how many exports people make. Visits are found with `sessionize()` from the raw timestamps (a new visit starts after 30 minutes of silence), not from a session ID the app has to send. Sample data from a fictional app, written by a coding agent.

```sql headline
WITH visits AS (
  SELECT user_id, visit, count(*) AS events, epoch(max(t) - min(t)) / 60.0 AS minutes FROM (
    SELECT user_id, timezone('UTC', timestamp)::TIMESTAMP AS t,
           sessionize(timezone('UTC', timestamp)::TIMESTAMP, INTERVAL 30 MINUTE)
             OVER (PARTITION BY user_id ORDER BY timezone('UTC', timestamp)::TIMESTAMP) AS visit
    FROM events WHERE user_id IS NOT NULL) GROUP BY user_id, visit),
days AS (SELECT DISTINCT user_id, timezone('UTC', timestamp)::DATE AS day FROM events WHERE user_id IS NOT NULL),
last_day AS (SELECT max(day) AS day FROM days)
SELECT
  round(median(minutes), 1) AS median_minutes,
  round(avg(events), 1) AS events_per_visit,
  (SELECT round(100.0 * count(DISTINCT user_id) FILTER (WHERE day = (SELECT day FROM last_day))
          / count(DISTINCT user_id), 1) FROM days WHERE day BETWEEN (SELECT day FROM last_day) - 29 AND (SELECT day FROM last_day)) AS stickiness
FROM visits
```

```metric
query: headline
field: median_minutes
label: Median visit length
suffix: " min"
width: third
```

```metric
query: headline
field: events_per_visit
label: Actions per visit
width: third
```

```metric
query: headline
field: stickiness
label: Daily actives, as a share of the last 30 days
suffix: "%"
width: third
```

```sql length
SELECT bucket, n, count(*) AS visits FROM (
  SELECT CASE WHEN minutes < 1 THEN '<1 min' WHEN minutes < 5 THEN '1-5 min' WHEN minutes < 15 THEN '5-15 min' WHEN minutes < 30 THEN '15-30 min' ELSE '30+ min' END AS bucket,
         CASE WHEN minutes < 1 THEN 1 WHEN minutes < 5 THEN 2 WHEN minutes < 15 THEN 3 WHEN minutes < 30 THEN 4 ELSE 5 END AS n
  FROM (
    SELECT epoch(max(t) - min(t)) / 60.0 AS minutes FROM (
      SELECT user_id, timezone('UTC', timestamp)::TIMESTAMP AS t,
             sessionize(timezone('UTC', timestamp)::TIMESTAMP, INTERVAL 30 MINUTE)
               OVER (PARTITION BY user_id ORDER BY timezone('UTC', timestamp)::TIMESTAMP) AS visit
      FROM events WHERE user_id IS NOT NULL) GROUP BY user_id, visit))
GROUP BY bucket, n ORDER BY n
```

```chart
query: length
title: How long visits last
width: half
spec:
  height: 240
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: bucket, type: nominal, title: null, sort: {field: n, op: min}, axis: {labelAngle: 0}}
    y: {field: visits, type: quantitative, title: "Visits"}
```

```sql heavy
SELECT bucket, n, count(*) AS people FROM (
  SELECT CASE WHEN c = 1 THEN '1' WHEN c <= 3 THEN '2-3' WHEN c <= 9 THEN '4-9' ELSE '10+' END AS bucket,
         CASE WHEN c = 1 THEN 1 WHEN c <= 3 THEN 2 WHEN c <= 9 THEN 3 ELSE 4 END AS n
  FROM (SELECT user_id, count(*) AS c FROM events WHERE event = 'export_completed' GROUP BY 1))
GROUP BY bucket, n ORDER BY n
```

```chart
query: heavy
title: Exports completed per person
width: half
spec:
  height: 240
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: bucket, type: nominal, title: "Exports", sort: {field: n, op: min}, axis: {labelAngle: 0}}
    y: {field: people, type: quantitative, title: "People"}
```

```sql daily
WITH days AS (SELECT DISTINCT user_id, timezone('UTC', timestamp)::DATE AS day FROM events WHERE user_id IS NOT NULL),
calendar AS (SELECT unnest(generate_series((SELECT max(day) FROM days) - 59, (SELECT max(day) FROM days), INTERVAL 1 DAY))::DATE AS day)
SELECT c.day AS day,
       (SELECT count(*) FROM days d WHERE d.day = c.day) AS "Active that day",
       (SELECT count(DISTINCT user_id) FROM days d WHERE d.day BETWEEN c.day - 29 AND c.day) AS "Last 30 days"
FROM calendar c ORDER BY c.day
```

```chart
query: daily
title: People active each day, and over the previous 30 days
spec:
  height: 240
  transform:
    - fold: ["Active that day", "Last 30 days"]
      as: [measure, people]
  mark: {type: line, strokeWidth: 2}
  encoding:
    x: {field: day, type: temporal, title: null, axis: {format: "%b %d"}}
    y: {field: people, type: quantitative, title: null}
    color: {field: measure, type: nominal, title: null}
```

> Finding: the audience is growing fast but visits stay short. The number of people active in a 30-day window has more than quadrupled in two months, while a typical visit is 2.3 minutes and about five actions, and around one in ten of those people shows up on any given day. Exports are spread across people rather than concentrated in a few: 5% have completed ten or more, while 20% have done just one. Next: compare visit length across releases, since the new export flow in v1.2.5 should shorten it.
