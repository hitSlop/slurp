---
purpose: Do new users come back in the weeks after signup
extensions: [behavioral]
---

# Do people come back?

Weekly cohorts of new users, and the share of each cohort that did anything in the app in the weeks after signing up. About 46% come back in week one and 24% are still active in week five. Sample data from a fictional app, written by a coding agent.

```sql headline
WITH act AS (
  SELECT DISTINCT user_id, date_trunc('week', timezone('UTC', timestamp))::DATE AS wk FROM events WHERE user_id IS NOT NULL
),
first AS (SELECT user_id, min(wk) AS cohort FROM act GROUP BY 1),
last_week AS (SELECT max(wk) AS wk FROM act),
per_user AS (
  SELECT f.cohort,
         retention(a.wk = f.cohort, a.wk = f.cohort + 7, a.wk = f.cohort + 14, a.wk = f.cohort + 21, a.wk = f.cohort + 28) AS r
  FROM act a JOIN first f USING (user_id)
  GROUP BY a.user_id, f.cohort
),
cells AS (SELECT cohort, generate_subscripts(r, 1) - 1 AS week, unnest(r)::INT AS hit FROM per_user),
usable AS (
  SELECT * FROM cells
  WHERE cohort >= (SELECT wk FROM last_week) - INTERVAL 63 DAY AND cohort < (SELECT wk FROM last_week)
    AND cohort + to_weeks(week::INT) <= (SELECT wk FROM last_week)
)
SELECT
  round(100.0 * avg(hit) FILTER (WHERE week = 1))::INT AS week1,
  round(100.0 * avg(hit) FILTER (WHERE week = 4))::INT AS week4,
  count(*) FILTER (WHERE week = 0) AS users
FROM usable
```

```metric
query: headline
field: week1
label: Back within a week
suffix: "%"
width: third
```

```metric
query: headline
field: week4
label: Still active in week four
suffix: "%"
width: third
```

```metric
query: headline
field: users
label: New users in these cohorts
width: third
```

`retention()` comes from DuckDB's `behavioral` extension. For each user it takes one condition per week, "active in the signup week", "active one week later", and so on, and returns a true/false list. Averaging those lists per cohort gives the share of people who came back. The plain-SQL version of this query needs a self-join and a separate count of cohort sizes.

```sql cohorts
WITH act AS (
  SELECT DISTINCT user_id, date_trunc('week', timezone('UTC', timestamp))::DATE AS wk FROM events WHERE user_id IS NOT NULL
),
first AS (SELECT user_id, min(wk) AS cohort FROM act GROUP BY 1),
last_week AS (SELECT max(wk) AS wk FROM act),
per_user AS (
  SELECT f.cohort,
         retention(a.wk = f.cohort, a.wk = f.cohort + 7, a.wk = f.cohort + 14, a.wk = f.cohort + 21, a.wk = f.cohort + 28,
                   a.wk = f.cohort + 35, a.wk = f.cohort + 42, a.wk = f.cohort + 49, a.wk = f.cohort + 56) AS r
  FROM act a JOIN first f USING (user_id)
  GROUP BY a.user_id, f.cohort
),
cells AS (SELECT cohort, generate_subscripts(r, 1) - 1 AS week, unnest(r)::INT AS hit FROM per_user)
SELECT strftime(cohort, '%b %d') AS cohort, cohort AS cohort_date, week, round(100.0 * avg(hit))::INT AS retained
FROM cells
WHERE cohort >= (SELECT wk FROM last_week) - INTERVAL 63 DAY AND cohort < (SELECT wk FROM last_week)
  AND week BETWEEN 1 AND 8 AND cohort + to_weeks(week::INT) <= (SELECT wk FROM last_week)
GROUP BY cohort, week
ORDER BY cohort, week
```

```chart
query: cohorts
title: Weekly retention by signup cohort (% of cohort active)
spec:
  height: 300
  encoding:
    x: {field: week, type: ordinal, title: "Weeks since signup", axis: {labelAngle: 0}}
    y: {field: cohort, type: ordinal, title: null, sort: {field: cohort_date, order: descending}}
  layer:
    - mark: rect
      encoding:
        color: {field: retained, type: quantitative, title: "% active", scale: {scheme: blues, domain: [0, 50]}}
    - mark: {type: text, fontSize: 11}
      encoding:
        text: {field: retained, type: quantitative}
        color: {condition: {test: "datum.retained > 28", value: white}, value: "#17191c"}
```

```sql curve
WITH act AS (
  SELECT DISTINCT user_id, date_trunc('week', timezone('UTC', timestamp))::DATE AS wk FROM events WHERE user_id IS NOT NULL
),
first AS (SELECT user_id, min(wk) AS cohort FROM act GROUP BY 1),
plan AS (SELECT user_id, any_value(data->>'$.plan') AS plan FROM events WHERE event = 'signed_up' GROUP BY 1),
last_week AS (SELECT max(wk) AS wk FROM act),
per_user AS (
  SELECT f.cohort, p.plan,
         retention(a.wk = f.cohort, a.wk = f.cohort + 7, a.wk = f.cohort + 14, a.wk = f.cohort + 21, a.wk = f.cohort + 28,
                   a.wk = f.cohort + 35, a.wk = f.cohort + 42, a.wk = f.cohort + 49, a.wk = f.cohort + 56) AS r
  FROM act a JOIN first f USING (user_id) JOIN plan p USING (user_id)
  GROUP BY a.user_id, f.cohort, p.plan
),
cells AS (SELECT cohort, plan, generate_subscripts(r, 1) - 1 AS week, unnest(r)::INT AS hit FROM per_user)
SELECT week AS "Week",
       round(100.0 * avg(hit))::INT AS "All users",
       round(100.0 * avg(hit) FILTER (WHERE plan = 'free'))::INT AS "Free",
       round(100.0 * avg(hit) FILTER (WHERE plan = 'pro'))::INT AS "Pro",
       count(*) AS "Users counted"
FROM cells
WHERE cohort >= (SELECT wk FROM last_week) - INTERVAL 63 DAY AND cohort < (SELECT wk FROM last_week)
  AND cohort + to_weeks(week::INT) <= (SELECT wk FROM last_week)
GROUP BY week
ORDER BY week
```

```chart
query: curve
title: Pro users come back more
width: half
spec:
  height: 240
  transform:
    - fold: ["All users", "Free", "Pro"]
      as: [plan, pct]
  layer:
    - mark: {type: line, strokeWidth: 2}
      encoding:
        x: {field: Week, type: quantitative, title: "Weeks since signup", axis: {tickMinStep: 1}}
        y: {field: pct, type: quantitative, title: "% active", scale: {domain: [0, 100]}}
        color: {field: plan, type: nominal, title: null}
    - mark: {type: point, filled: true, size: 50}
      encoding:
        x: {field: Week, type: quantitative}
        y: {field: pct, type: quantitative}
        color: {field: plan, type: nominal, title: null}
```

```table
query: curve
title: "% active by week since signup"
width: half
```

> Finding: Pro users come back more. 53% of them are active the week after signing up against 45% of free users, and the gap widens to 35% against 27% by week four. Later weeks include fewer cohorts, so the last rows rest on fewer users (see the last column). Next: look at what pro users do in their first week that free users do not.
