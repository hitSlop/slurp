-- Slurp helpers: small macros and views for product analytics, installed into every project database.
-- Slurp re-applies this file whenever it changes, so do not edit it here; copy what you need into your own SQL.

-- Numbers
CREATE OR REPLACE MACRO safe_num(x) AS try_cast(x AS DOUBLE);
CREATE OR REPLACE MACRO pct(part, total) AS 100.0 * safe_num(part) / nullif(safe_num(total), 0);
-- share(x): each row's part of the total, for example share(count(*)) over a GROUP BY. The window lives inside the macro.
CREATE OR REPLACE MACRO share(x) AS safe_num(x) / nullif(sum(safe_num(x)) OVER (), 0);

-- Days in your own timezone (UTC unless you define your own biz_tz() in a query).
CREATE OR REPLACE MACRO biz_tz() AS 'UTC';
CREATE OR REPLACE MACRO biz_date(ts) AS CAST(timezone(biz_tz(), ts::TIMESTAMPTZ) AS DATE);
CREATE OR REPLACE MACRO biz_trunc(part, ts) AS date_trunc(part, timezone(biz_tz(), ts::TIMESTAMPTZ));

-- A gap-free list of days (or any step of a day or longer) between two dates, so charts show zero days instead of skipping them.
--   SELECT c.biz_date, count(e.id) FROM calendar('2026-10-01', '2026-10-31') c LEFT JOIN events e ON biz_date(e.timestamp) = c.biz_date GROUP BY 1
CREATE OR REPLACE MACRO calendar(start_date, end_date, step := '1 day', tz := biz_tz()) AS TABLE
WITH ticks AS (
  SELECT timezone(tz, wall_time) AS ts, wall_time AS local_time
  FROM range(start_date::TIMESTAMP, end_date::TIMESTAMP + step::INTERVAL, step::INTERVAL) r(wall_time)
  WHERE step::INTERVAL >= INTERVAL 1 DAY AND wall_time <= end_date::TIMESTAMP
  UNION ALL
  SELECT instant AS ts, timezone(tz, instant) AS local_time
  FROM range(timezone(tz, start_date::TIMESTAMP), timezone(tz, end_date::TIMESTAMP) + step::INTERVAL, step::INTERVAL) r(instant)
  WHERE step::INTERVAL < INTERVAL 1 DAY AND instant <= timezone(tz, end_date::TIMESTAMP)
)
SELECT ts, local_time, CAST(local_time AS DATE) AS biz_date,
       isodow(local_time) AS weekday,
       isodow(local_time) BETWEEN 1 AND 5 AS is_weekday,
       isodow(local_time) IN (6, 7) AS is_weekend
FROM ticks;

-- Sessions without an extension: 1 when an event starts a new session (the first one, or after a gap), else 0.
-- A window cannot contain another window, so take the previous timestamp in a CTE first, then add the markers up:
--   WITH x AS (SELECT *, lag(timestamp) OVER w AS prev FROM events WINDOW w AS (PARTITION BY person_id ORDER BY timestamp))
--   SELECT *, sum(session_start(timestamp, prev, 30)) OVER (PARTITION BY person_id ORDER BY timestamp) AS session FROM x
CREATE OR REPLACE MACRO session_start(ts, previous_ts, gap_minutes) AS
  CASE WHEN ts IS NULL OR gap_minutes IS NULL OR gap_minutes < 0 THEN NULL
       WHEN previous_ts IS NULL OR ts - previous_ts > gap_minutes * INTERVAL '1 minute'
       THEN 1 ELSE 0 END;

-- People: an anonymous visitor is linked to a user only when their identify events name exactly one user.
-- A visitor tied to two different users stays separate rather than being merged by guesswork.
CREATE OR REPLACE VIEW identity_links AS
SELECT anonymous_id, min(user_id) AS user_id
FROM events
WHERE type = 'identify' AND nullif(user_id, '') IS NOT NULL AND nullif(anonymous_id, '') IS NOT NULL
GROUP BY anonymous_id
HAVING count(DISTINCT user_id) = 1;

-- Every event with a person_id: 'u:<user id>' when the person is known (directly, or through an identify link),
-- otherwise 'a:<anonymous id>'. Count people with count(DISTINCT person_id).
CREATE OR REPLACE VIEW events_with_person AS
SELECT e.*,
       CASE WHEN nullif(e.user_id, '') IS NOT NULL THEN 'u:' || e.user_id
            WHEN l.user_id IS NOT NULL THEN 'u:' || l.user_id
            WHEN nullif(e.anonymous_id, '') IS NOT NULL THEN 'a:' || e.anonymous_id
       END AS person_id
FROM events e
LEFT JOIN identity_links l ON l.anonymous_id = e.anonymous_id;
