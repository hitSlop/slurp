WITH params AS (
 SELECT TIMESTAMPTZ '2026-01-01 00:00:00+00' AS period_start,
 TIMESTAMPTZ '2026-02-01 00:00:00+00' AS period_end,
 'signed_up' AS entry_event, 'value_delivered' AS value_event
), eligible AS (
 SELECT DISTINCT user_id FROM events,params
 WHERE type='track' AND event=entry_event AND timestamp<period_start
 AND nullif(user_id, '') IS NOT NULL
), per_user AS (
 SELECT c.user_id, count(DISTINCT CAST(e.timestamp AT TIME ZONE 'UTC' AS DATE)) AS active_days
 FROM eligible c CROSS JOIN params p LEFT JOIN events e
 ON e.user_id=c.user_id AND e.type='track' AND e.event=p.value_event
 AND e.timestamp>=p.period_start AND e.timestamp<p.period_end GROUP BY c.user_id
)
SELECT active_days,count(*) AS users FROM per_user GROUP BY active_days ORDER BY active_days;
