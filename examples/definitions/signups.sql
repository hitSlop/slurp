-- One row per person who signed up: when they first did, and on which plan.
-- Unit: person (events_with_person.person_id).
-- Excludes events sent by the MCP tools (sender = 'mcp').
CREATE OR REPLACE TEMP VIEW signups AS
SELECT person_id, min(timestamp) AS signed_up_at,
       arg_min(data->>'plan', timestamp) AS plan
FROM events_with_person
WHERE event = 'signed_up' AND sender <> 'mcp'
GROUP BY person_id;
