SELECT type, event, count(*) AS events,
 count(*) FILTER (WHERE nullif(user_id, '') IS NOT NULL) AS identified_events,
 min(timestamp) AS first_event_at, max(timestamp) AS last_event_at,
 max(received_at) AS latest_received_at,
 count(*) FILTER (WHERE received_at < timestamp) AS client_clock_ahead
FROM events GROUP BY type, event ORDER BY events DESC, type, event;
