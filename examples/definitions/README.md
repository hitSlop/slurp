# Example definitions

Shared business definitions for the sample app in [`examples/demo`](../demo). Copy them into your app's `slurp/definitions/`
and change the event names to yours. See [Project definitions](../../docs/cli.md#project-definitions).

| File | What it defines |
|---|---|
| `signups.sql` | A view: one row per person who signed up, with when and on which plan |
| `activated_people.sql` | A table macro: people who completed an export within `within` (7 days unless given) of signing up |
| `signup_funnel.sql` | A table macro: how far each person got through signup, project, export started and export completed, in order; uses the `behavioral` extension (`-- extensions: behavioral`) |

The demo's [activation report](../demo/activation.md) is built on all three.

```sql
-- Share of signups who exported within a week, by plan
SELECT s.plan, pct(count(a.person_id), count(*)) AS activated_pct
FROM signups s LEFT JOIN activated_people() a ON a.person_id = s.person_id
GROUP BY s.plan
ORDER BY s.plan
```

A test loads these files into a project and runs this query, so they stay correct.
