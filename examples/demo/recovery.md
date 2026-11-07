---
purpose: What people do after an export fails
extensions: [behavioral]
---

# What happens after an export fails?

When an export fails, do people try again, or do they leave? `sequence_match()` looks for a failed export followed by a completed one, with a time limit, and `sequence_next_node()` reads the very next thing each person did. Sample data from a fictional app, written by a coding agent.

```sql headline
SELECT
  count(*) AS failed_users,
  round(100.0 * count(*) FILTER (WHERE later) / count(*))::INT AS recovered,
  round(100.0 * count(*) FILTER (WHERE within_hour) / count(*))::INT AS within_hour
FROM (
  SELECT user_id,
         sequence_match('(?1).*(?2)', timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS later,
         sequence_match('(?1).*(?t<=3600)(?2)', timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS within_hour
  FROM events GROUP BY user_id
  HAVING count(*) FILTER (WHERE event = 'export_failed') > 0)
```

```metric
query: headline
field: failed_users
label: People who hit a failed export
width: third
```

```metric
query: headline
field: recovered
label: Exported successfully later
suffix: "%"
width: third
```

```metric
query: headline
field: within_hour
label: Within an hour of failing
suffix: "%"
width: third
```

```sql speed
SELECT win AS "Within", n, count(*) FILTER (WHERE level >= 2) AS people,
       round(100.0 * count(*) FILTER (WHERE level >= 2) / count(*))::INT AS pct
FROM (
  SELECT user_id,
         window_funnel(INTERVAL 10 MINUTE, timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS a,
         window_funnel(INTERVAL 1 HOUR, timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS b,
         window_funnel(INTERVAL 6 HOUR, timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS c,
         window_funnel(INTERVAL 1 DAY, timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS d,
         window_funnel(INTERVAL 7 DAY, timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS e,
         window_funnel(INTERVAL 365 DAY, timestamp::TIMESTAMP, event = 'export_failed', event = 'export_completed') AS f
  FROM events GROUP BY user_id HAVING count(*) FILTER (WHERE event = 'export_failed') > 0),
  LATERAL (VALUES (1, '10 min', a), (2, '1 h', b), (3, '6 h', c), (4, '1 day', d), (5, '7 days', e), (6, 'ever', f)) w(n, win, level)
GROUP BY win, n ORDER BY n
```

```chart
query: speed
title: Recovery over time, % of people who failed
width: half
spec:
  height: 250
  layer:
    - mark: {type: area, opacity: 0.25, line: true}
      encoding:
        x: {field: Within, type: ordinal, title: "Time after the failure", sort: {field: n, op: min}, axis: {labelAngle: 0}}
        y: {field: pct, type: quantitative, title: "% who exported", scale: {domain: [0, 100]}}
    - mark: {type: point, filled: true, size: 60}
      encoding:
        x: {field: Within, type: ordinal, sort: {field: n, op: min}}
        y: {field: pct, type: quantitative}
    - mark: {type: text, dy: -12, fontSize: 11}
      encoding:
        x: {field: Within, type: ordinal, sort: {field: n, op: min}}
        y: {field: pct, type: quantitative}
        text: {field: pct, type: quantitative}
```

```sql next
SELECT CASE next_event
         WHEN 'export_opened' THEN 'Tries again'
         WHEN 'project_created' THEN 'New project'
         WHEN 'signed_up' THEN 'Signs up again'
         ELSE coalesce(next_event, 'Nothing, left') END AS next_step,
       count(*) AS people
FROM (
  SELECT user_id,
         sequence_next_node('forward', 'first_match', timestamp::TIMESTAMP, event, event = 'export_failed', event = 'export_failed') AS next_event
  FROM events GROUP BY user_id
  HAVING count(*) FILTER (WHERE event = 'export_failed') > 0)
GROUP BY 1 ORDER BY people DESC
```

```chart
query: next
title: What people do next after a failure
width: half
spec:
  height: 250
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    y: {field: next_step, type: nominal, title: null, sort: "-x"}
    x: {field: people, type: quantitative, title: "People"}
```

> Finding: failing does not lose people, it costs them time. Of the 2,386 people who hit a failed export, 78% exported successfully later, but only 25% within the hour. Most retry straight away (77% open the export dialog again as their next step) while 16% do nothing else. Next: fix the failures themselves (see the export health report), since each one adds a long detour for most of the people it affects.
