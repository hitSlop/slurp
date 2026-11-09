-- People who completed an export within `within` of signing up
-- (7 days unless given), and when they first did.
-- Unit: person. Eligible: everyone in signups. Times in UTC.
-- Excludes events sent by the MCP tools.
CREATE OR REPLACE TEMP MACRO activated_people(within := INTERVAL 7 DAY) AS TABLE
SELECT s.person_id, s.plan, s.signed_up_at, min(e.timestamp) AS activated_at
FROM signups s
JOIN events_with_person e ON e.person_id = s.person_id
WHERE e.event = 'export_completed' AND e.sender <> 'mcp'
  AND e.timestamp BETWEEN s.signed_up_at AND s.signed_up_at + within
GROUP BY s.person_id, s.plan, s.signed_up_at;
