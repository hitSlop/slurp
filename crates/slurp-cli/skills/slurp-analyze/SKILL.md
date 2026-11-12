---
name: slurp-analyze
description: Analyze product activation, retention, meaningful usage and failure recovery from Slurp events in local DuckDB.
---
For goal-driven improvement work, read `references/learning-loop.md` and `slurp/GOALS.md` first. Ask only for missing priorities, save agreed goals and dated learnings there, and resume the next check on later invocations. Keep standalone queries and reports focused on the user’s request.

Use slurp status, slurp describe and slurp sync before interpreting data freshness. Run slurp definitions first and reuse the project's definitions of active, activated or retained people. Read references/analysis.md and select a query from queries/. Copy it into the project and bind actual event names and a defensible cutoff; once the user agrees on what it measures, save it as a definition in slurp/definitions/ so later analyses reuse it. Read references/benchmarks.md only when comparing categories. Validate denominators, identity, cohort maturity and join grain. Return evidence, counts, SQL, cutoff, checkpoint, uncertainty and the next useful question. Use DuckDB 2.x; slurp sql --file executes saved SQL. Do not modify events or _slurp tables.
