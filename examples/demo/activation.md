---
purpose: Do new users reach their first export, and how fast
---

# Do new users reach their first export?

A funnel with a clock on it, built from the project's shared definitions in [`examples/definitions`](https://github.com/hitSlop/slurp/tree/master/examples/definitions): `signups` is each person's signup and plan, `activated_people()` is everyone who completed an export within a week of signing up, and `signup_funnel()` follows each person through signup, first project, export started and export completed, counting a step only if it comes in order within seven days. Sample data from a fictional app, written by a coding agent.

```sql steps
SELECT step, n, plan, round(100.0 * count(*) FILTER (WHERE level >= n) / count(*))::INT AS pct
FROM signup_funnel(), (VALUES (1, 'Signed up'), (2, 'Project'), (3, 'Started'), (4, 'Exported')) steps(n, step)
GROUP BY step, n, plan
ORDER BY n, plan
```

```sql headline
SELECT round(100.0 * count(*) / (SELECT count(*) FROM signups))::INT AS activated,
       round(median(epoch(activated_at - signed_up_at) / 60.0))::INT AS median_minutes,
       round(100.0 * count(*) FILTER (WHERE activated_at - signed_up_at <= INTERVAL 1 HOUR) / count(*))::INT AS within_hour
FROM activated_people()
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
title: Share of new users reaching each step in order, by plan
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
SELECT bucket, n, count(*) AS people FROM (
  SELECT CASE
           WHEN activated_at - signed_up_at < INTERVAL 5 MINUTE THEN '<5 min'
           WHEN activated_at - signed_up_at < INTERVAL 1 HOUR THEN '<1 h'
           WHEN activated_at - signed_up_at < INTERVAL 1 DAY THEN '<1 day'
           WHEN activated_at - signed_up_at < INTERVAL 7 DAY THEN '<1 week'
           ELSE '1 week+' END AS bucket,
         CASE
           WHEN activated_at - signed_up_at < INTERVAL 5 MINUTE THEN 1
           WHEN activated_at - signed_up_at < INTERVAL 1 HOUR THEN 2
           WHEN activated_at - signed_up_at < INTERVAL 1 DAY THEN 3
           WHEN activated_at - signed_up_at < INTERVAL 7 DAY THEN 4
           ELSE 5 END AS n
  -- Every first export in the 90 days of data, not only those in the first week.
  FROM activated_people(within := INTERVAL 90 DAY))
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
    y: {field: people, type: quantitative, title: "People"}
```

```sql counts
SELECT f.plan AS "Plan", count(*) AS "Signups",
       count(*) FILTER (WHERE f.level >= 2) AS "Created a project",
       count(*) FILTER (WHERE f.level >= 3) AS "Then started an export",
       count(*) FILTER (WHERE f.level >= 4) AS "Then completed one",
       count(a.person_id) AS "Exported in week one, any path"
FROM signup_funnel() f LEFT JOIN activated_people() a ON a.person_id = f.person_id
GROUP BY f.plan ORDER BY f.plan
```

```table
query: counts
title: People at each step
```

> Finding: 85% of new users complete an export in their first week (84% on free, 91% on pro), and quickly: the typical new user exports four minutes after signing up, and 90% of first exports come within the hour. Only 69% get there through every step in order, because creating a project is optional: 1,048 people exported in their first week without creating a project first, and a funnel that requires that step counts them as not activated. Next: decide whether a project belongs in the activation path, and look at what the 18% who skip it do instead.
