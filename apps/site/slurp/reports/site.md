---
purpose: Who visits slurp.run, where they come from, and whether they try Slurp
---

# slurp.run, measured by Slurp

This site sends its own events to a Slurp Worker in the maintainers' Cloudflare account: one `page_view` per page load, the `deploy_clicked` and `install_copied` clicks, and the feedback widget. This report is the same kind of file your agent writes for your product. Everything here is one SQL query over the synced DuckDB file; `slurp report build slurp/reports/site.md` regenerates it.

```sql headline
SELECT
  count(DISTINCT anonymous_id) FILTER (WHERE event = 'page_view') AS visitors,
  count(*) FILTER (WHERE event = 'page_view') AS page_views,
  count(*) FILTER (WHERE event = 'deploy_clicked') AS deploy_clicks,
  count(*) FILTER (WHERE event = 'install_copied') AS install_copies,
  count(*) FILTER (WHERE event = 'feedback') AS feedback
FROM events WHERE sender = 'site'
```

```metric
query: headline
field: visitors
label: Visitors
width: third
```

```metric
query: headline
field: deploy_clicks
label: Deploy button clicks
width: third
```

```metric
query: headline
field: install_copies
label: Install commands copied
width: third
```

## Traffic by day

```sql by_day
SELECT timezone('UTC', timestamp)::DATE AS day,
       count(*) AS page_views,
       count(DISTINCT anonymous_id) AS visitors
FROM events WHERE sender = 'site' AND event = 'page_view'
GROUP BY 1 ORDER BY 1
```

```chart
query: by_day
title: Page views and visitors per day
spec: {mark: {type: line, point: true}, encoding: {x: {field: day, type: temporal}, y: {field: page_views, type: quantitative}}}
```

## Where people come from

The referrer is stored as origin and path only, never the query string.

```sql sources
SELECT coalesce(data ->> '$.utm_source', regexp_extract(data ->> '$.referrer', 'https?://([^/]+)', 1), 'direct') AS source,
       count(DISTINCT anonymous_id) AS visitors
FROM events WHERE sender = 'site' AND event = 'page_view'
GROUP BY 1 ORDER BY visitors DESC LIMIT 15
```

```table
query: sources
title: Top sources
```

## What they read

```sql pages
SELECT data ->> '$.path' AS page, count(*) AS views, count(DISTINCT anonymous_id) AS visitors
FROM events WHERE sender = 'site' AND event = 'page_view'
GROUP BY 1 ORDER BY views DESC LIMIT 10
```

```table
query: pages
title: Top pages
```

## Do they try it?

Of the people who viewed a page, how many clicked the Deploy to Cloudflare button or copied an install command.

```sql trying
WITH v AS (SELECT DISTINCT anonymous_id FROM events WHERE sender = 'site' AND event = 'page_view'),
     t AS (SELECT DISTINCT anonymous_id FROM events WHERE sender = 'site' AND event IN ('deploy_clicked', 'install_copied'))
SELECT (SELECT count(*) FROM v) AS visitors,
       (SELECT count(*) FROM t) AS tried,
       round(100.0 * (SELECT count(*) FROM t) / nullif((SELECT count(*) FROM v), 0), 1) AS percent
```

```metric
query: trying
field: percent
label: Visitors who tried to install or deploy
suffix: "%"
decimals: 1
```

## Feedback

Messages are read by the maintainers and not published here; this shows only how many came in and the average rating.

```sql feedback
SELECT count(*) AS messages,
       round(avg(try_cast(data ->> '$.rating' AS DOUBLE)), 1) AS average_rating
FROM events WHERE sender = 'site' AND event = 'feedback'
```

```metric
query: feedback
field: messages
label: Feedback messages
width: half
```

```metric
query: feedback
field: average_rating
label: Average rating (1 to 5)
width: half
```
