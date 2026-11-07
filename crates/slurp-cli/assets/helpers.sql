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

-- Errors from Sentry SDKs pointed at your Worker (event = 'error'): the exception, where it was thrown, and a grouping key,
-- read out of the stored event at query time. The full Sentry event stays in `data` (breadcrumbs, tags, contexts, request).
-- group_key is a hash of the exception type and the in-app frames' module/file and function (no line numbers), a best-effort
-- grouping: similar to, not identical to, what Sentry's server does. Stacks are as the SDK sent them: browser code
-- is still minified and native frames are still addresses; the debug ids to symbolicate them later are kept in data.
--   SELECT group_key, any_value(exception_type), count(*) AS n, count(DISTINCT user_id) AS users FROM errors GROUP BY 1 ORDER BY n DESC
CREATE OR REPLACE VIEW errors AS
WITH last_exception AS (
  SELECT e.*,
         json_extract_string(e.data, '$.exception.values[#-1].type') AS exception_type,
         json_extract_string(e.data, '$.exception.values[#-1].value') AS exception_value,
         try_cast(json_extract_string(e.data, '$.exception.values[#-1].mechanism.handled') AS BOOLEAN) AS handled,
         coalesce(from_json(json_extract(e.data, '$.exception.values[#-1].stacktrace.frames'), '["JSON"]'), []::JSON[]) AS frames
  FROM events e
  WHERE e.event = 'error'
), framed AS (
  SELECT *, list_filter(frames, lambda f: try_cast(json_extract_string(f, '$.in_app') AS BOOLEAN) IS TRUE) AS app_frames
  FROM last_exception
), keyed AS (
  SELECT *, CASE WHEN len(app_frames) > 0 THEN app_frames ELSE frames END AS key_frames
  FROM framed
)
SELECT id, timestamp, user_id, anonymous_id, session_id,
       json_extract_string(data, '$.level') AS level,
       json_extract_string(data, '$.platform') AS platform,
       json_extract_string(data, '$.release') AS release,
       json_extract_string(data, '$.environment') AS environment,
       exception_type,
       coalesce(exception_value, json_extract_string(data, '$.message'), json_extract_string(data, '$.logentry.formatted')) AS message,
       handled,
       coalesce(key_frames[-1], frames[-1]) AS top_frame,
       json_extract_string(coalesce(key_frames[-1], frames[-1]), '$.function') AS top_function,
       coalesce(json_extract_string(coalesce(key_frames[-1], frames[-1]), '$.module'), json_extract_string(coalesce(key_frames[-1], frames[-1]), '$.filename')) AS top_file,
       try_cast(json_extract_string(coalesce(key_frames[-1], frames[-1]), '$.lineno') AS INTEGER) AS top_line,
       json_extract(data, '$.tags') AS tags,
       md5(concat_ws('|', coalesce(exception_type, ''),
           coalesce(array_to_string(list_transform(key_frames, lambda f: concat_ws(':', coalesce(json_extract_string(f, '$.module'), json_extract_string(f, '$.filename'), ''), coalesce(json_extract_string(f, '$.function'), ''))), '>'),
                    coalesce(exception_value, json_extract_string(data, '$.message'), '')))) AS group_key,
       data, context, received_at
FROM keyed;

-- Releases and deployments from GitHub webhooks (`slurp project webhook PROJECT github`): one row per published release or
-- deployment status. They line up with your product events, so a release can be drawn on a chart or joined to see what changed
-- after it. It reads the event names, so it works whatever the webhook key is called.
--   SELECT r.happened_at, r.tag, count(e.id) AS events_in_the_next_day FROM releases r LEFT JOIN events e ON e.timestamp BETWEEN r.happened_at AND r.happened_at + INTERVAL 1 DAY GROUP BY 1, 2
CREATE OR REPLACE VIEW releases AS
SELECT id, timestamp AS happened_at,
       CASE event WHEN 'github.release.published' THEN 'release' ELSE 'deployment' END AS kind,
       coalesce(json_extract_string(data, '$.release.tag_name'), json_extract_string(data, '$.deployment.ref')) AS tag,
       json_extract_string(data, '$.release.name') AS name,
       coalesce(json_extract_string(data, '$.release.html_url'), json_extract_string(data, '$.deployment_status.target_url'), json_extract_string(data, '$.deployment_status.environment_url')) AS url,
       json_extract_string(data, '$.repository.full_name') AS repo,
       coalesce(json_extract_string(data, '$.deployment_status.environment'), json_extract_string(data, '$.deployment.environment')) AS environment,
       json_extract_string(data, '$.deployment_status.state') AS state,
       sender, data, received_at
FROM events
WHERE event IN ('github.release.published', 'github.deployment_status.created');
