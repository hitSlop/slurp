---
purpose: Do new users reach their first export, and how fast
extensions: [behavioral]
---

# Do new users reach their first export?

A funnel with a clock on it. `window_funnel()` follows each user through signup, first project, first export started and first export completed, and only counts a step if it happens within seven days of signing up. Sample data from a fictional app, written by a coding agent.

```sql steps
WITH signup AS (
  SELECT user_id, any_value(data->>'$.plan') AS plan FROM events WHERE event = 'signed_up' GROUP BY 1
),
per_user AS (
  SELECT e.user_id, s.plan,
         window_funnel(INTERVAL 7 DAY, timezone('UTC', e.timestamp)::TIMESTAMP,
           e.event = 'signed_up', e.event = 'project_created', e.event = 'export_started', e.event = 'export_completed') AS level
  FROM events e JOIN signup s USING (user_id)
  GROUP BY e.user_id, s.plan
)
SELECT step, n, plan, round(100.0 * count(*) FILTER (WHERE level >= n) / count(*))::INT AS pct
FROM per_user, (VALUES (1, 'Signed up'), (2, 'Project'), (3, 'Started'), (4, 'Exported')) steps(n, step)
GROUP BY step, n, plan
ORDER BY n, plan
```

```sql headline
WITH signup AS (SELECT user_id, min(timestamp) AS at FROM events WHERE event = 'signed_up' GROUP BY 1),
first_export AS (SELECT user_id, min(timestamp) AS at FROM events WHERE event = 'export_completed' GROUP BY 1),
funnel AS (
  SELECT window_funnel(INTERVAL 7 DAY, timezone('UTC', timestamp)::TIMESTAMP,
           event = 'signed_up', event = 'project_created', event = 'export_started', event = 'export_completed') AS level
  FROM events WHERE user_id IN (SELECT user_id FROM signup) GROUP BY user_id)
SELECT
  (SELECT round(100.0 * count(*) FILTER (WHERE level >= 4) / count(*))::INT FROM funnel) AS activated,
  round(median(epoch(f.at - s.at) / 60.0))::INT AS median_minutes,
  round(100.0 * count(*) FILTER (WHERE f.at - s.at <= INTERVAL 1 HOUR) / count(*))::INT AS within_hour
FROM signup s JOIN first_export f USING (user_id)
WHERE f.at >= s.at
```

```metric
query: headline
field: activated
label: Signed up, then exported within a week
suffix: "%"
width: third
```

```metric
query: headline
field: median_minutes
label: Median time to first export
suffix: " min"
width: third
```

```metric
query: headline
field: within_hour
label: First exports within an hour of signup
suffix: "%"
width: third
```

```chart
query: steps
title: Share of new users reaching each step, by plan
width: half
spec:
  height: 260
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: step, type: nominal, title: null, sort: {field: n, op: min}, axis: {labelAngle: 0}}
    xOffset: {field: plan}
    y: {field: pct, type: quantitative, title: "% of signups", scale: {domain: [0, 100]}}
    color: {field: plan, type: nominal, title: "Plan"}
```

```sql speed
WITH signup AS (SELECT user_id, min(timestamp) AS at FROM events WHERE event = 'signed_up' GROUP BY 1),
first_export AS (SELECT user_id, min(timestamp) AS at FROM events WHERE event = 'export_completed' GROUP BY 1)
SELECT bucket, n, count(*) AS users FROM (
  SELECT CASE
           WHEN f.at - s.at < INTERVAL 5 MINUTE THEN '<5 min'
           WHEN f.at - s.at < INTERVAL 1 HOUR THEN '<1 h'
           WHEN f.at - s.at < INTERVAL 1 DAY THEN '<1 day'
           WHEN f.at - s.at < INTERVAL 7 DAY THEN '<1 week'
           ELSE '1 week+' END AS bucket,
         CASE
           WHEN f.at - s.at < INTERVAL 5 MINUTE THEN 1
           WHEN f.at - s.at < INTERVAL 1 HOUR THEN 2
           WHEN f.at - s.at < INTERVAL 1 DAY THEN 3
           WHEN f.at - s.at < INTERVAL 7 DAY THEN 4
           ELSE 5 END AS n
  FROM signup s JOIN first_export f USING (user_id) WHERE f.at >= s.at)
GROUP BY bucket, n ORDER BY n
```

```chart
query: speed
title: Time from signup to first export
width: half
spec:
  height: 260
  mark: {type: bar, cornerRadiusEnd: 2}
  encoding:
    x: {field: bucket, type: nominal, title: null, sort: {field: n, op: min}, axis: {labelAngle: 0}}
    y: {field: users, type: quantitative, title: "Users"}
```

```sql counts
WITH signup AS (SELECT user_id, any_value(data->>'$.plan') AS plan FROM events WHERE event = 'signed_up' GROUP BY 1),
per_user AS (
  SELECT e.user_id, s.plan,
         window_funnel(INTERVAL 7 DAY, timezone('UTC', e.timestamp)::TIMESTAMP,
           e.event = 'signed_up', e.event = 'project_created', e.event = 'export_started', e.event = 'export_completed') AS level
  FROM events e JOIN signup s USING (user_id) GROUP BY e.user_id, s.plan)
SELECT plan AS "Plan", count(*) AS "Signups",
       count(*) FILTER (WHERE level >= 2) AS "Created a project",
       count(*) FILTER (WHERE level >= 3) AS "Started an export",
       count(*) FILTER (WHERE level >= 4) AS "Completed an export"
FROM per_user GROUP BY plan ORDER BY plan
```

```table
query: counts
title: Users at each step
```

> Finding: about 69% of new users complete an export in their first week, and the first one comes quickly: the typical new user exports four minutes after signing up. The biggest drop is between signing up and creating a project (82% continue); after that, pro users are more likely than free users to start (77% against 73%) and to finish (74% against 68%). Next: look at what the 18% who never create a project saw on their first screen.
