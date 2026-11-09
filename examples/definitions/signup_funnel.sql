-- How far each person who signed up got within `within` of signing up
-- (7 days unless given), in order: 1 signed up, 2 created a project,
-- 3 started an export, 4 completed an export.
-- Unit: person. Eligible: everyone in signups. Times in UTC.
-- extensions: behavioral
CREATE OR REPLACE TEMP MACRO signup_funnel(within := INTERVAL 7 DAY) AS TABLE
SELECT s.person_id, s.plan,
       window_funnel(within, timezone('UTC', e.timestamp)::TIMESTAMP,
         e.event = 'signed_up', e.event = 'project_created',
         e.event = 'export_started', e.event = 'export_completed') AS level
FROM signups s
JOIN events_with_person e ON e.person_id = s.person_id
WHERE e.sender <> 'mcp'
GROUP BY s.person_id, s.plan;
