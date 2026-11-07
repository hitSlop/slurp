WITH params AS (
 SELECT TIMESTAMPTZ '2026-01-20 00:00:00+00' AS cutoff,
 'signed_up' AS entry_event, 'value_delivered' AS value_event
), cohorts AS (
 SELECT user_id, min(timestamp) AS entered_at FROM events, params
 WHERE type='track' AND event=entry_event AND timestamp<cutoff
 AND nullif(user_id, '') IS NOT NULL GROUP BY user_id
), per_user AS (
 SELECT c.user_id, c.entered_at, min(e.timestamp) AS activated_at
 FROM cohorts c CROSS JOIN params p LEFT JOIN events e
 ON e.user_id=c.user_id AND e.type='track' AND e.event=p.value_event
 AND e.timestamp>=c.entered_at AND e.timestamp<c.entered_at+INTERVAL '7 days'
 WHERE c.entered_at+INTERVAL '7 days'<=p.cutoff GROUP BY c.user_id,c.entered_at
)
SELECT count(*) AS eligible_users, count(activated_at) AS activated_users,
100.0*count(activated_at)/nullif(count(*),0) AS activation_pct,
median(epoch(activated_at-entered_at)) AS completers_median_seconds FROM per_user;
