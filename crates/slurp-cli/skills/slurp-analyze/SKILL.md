---
name: slurp-analyze
description: Analyze product activation, retention, meaningful usage and failure recovery from Slurp events in local DuckDB.
---
Use slurp status, slurp describe and slurp sync before interpreting data freshness. Read references/analysis.md and select a query from queries/. Copy it into the project and bind actual event names and a defensible cutoff. Read references/benchmarks.md only when comparing categories. Validate denominators, identity, cohort maturity and join grain. Return evidence, counts, SQL, cutoff, checkpoint, uncertainty and the next useful question. Use DuckDB 2.x; slurp sql --file executes saved SQL. Do not modify events or _slurp tables.
