WITH params AS (
 SELECT TIMESTAMPTZ '2026-01-20 00:00:00+00' AS cutoff,
 'signed_up' AS entry_event, 'value_delivered' AS value_event
), cohorts AS (
 SELECT user_id, min(timestamp) AS entered_at FROM events, params
 WHERE type='track' AND event=entry_event AND timestamp<cutoff
 AND nullif(user_id, '') IS NOT NULL GROUP BY user_id
), eligible AS (
 SELECT c.* FROM cohorts c, params WHERE entered_at + INTERVAL '14 days' <= cutoff
), per_user AS (
 SELECT c.user_id, count(e.id)>0 AS returned
 FROM eligible c CROSS JOIN params p LEFT JOIN events e
 ON e.user_id=c.user_id AND e.type='track' AND e.event=p.value_event
 AND e.timestamp>=c.entered_at+INTERVAL '7 days'
 AND e.timestamp<c.entered_at+INTERVAL '14 days'
 GROUP BY c.user_id
)
SELECT count(*) AS eligible_users, count(*) FILTER (WHERE returned) AS returned_users,
100.0*count(*) FILTER (WHERE returned)/nullif(count(*),0) AS retention_pct FROM per_user;
