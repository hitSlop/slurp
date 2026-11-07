---
name: slurp
description: Sync self-hosted events, query local DuckDB and author reports.
---
Use slurp status and slurp describe before analysis, and slurp health to see data problems (spelling variants, wrong clocks, double tracking, bots) before trusting a number. For people use events_with_person and its person_id instead of user_id alone (it joins anonymous visitors to their identified user); calendar(), biz_date(), pct() and session_start() are available in every query. Run slurp sync to fetch published archives. The Worker seals new archives about every 10 minutes by default; accepted events may not yet be visible. Send and sync may return optional source-level publication estimates; these are not delivery guarantees. Use --json for full structured query results and publication metadata. Credentials belong in the private machine store or environment, never reports or source control. The default machine store is ~/.slurp/credentials.json with owner-only permissions; ordinary sync/send must not invoke Keychain. SLURP_TOKEN / SLURP_READ_KEY override the saved Worker connection. If migrating an older installation, a human can run slurp credentials migrate-keychain once; do not repeatedly retry that command from an unattended agent.
Query events using slurp sql 'SELECT ...' or duckdb -readonly .slurp/data/events.duckdb. Payload properties remain JSON in data. Do not modify events or _slurp tables. Save business logic as SQL files, not importer changes.
Reports contain Markdown, named ```sql NAME fences and YAML chart, metric, table fences with query: NAME. Chart spec is Vega-Lite without external data. Aggregate in SQL; metric queries return one row. Build with slurp report build FILE --out NEW_DIRECTORY --png --pdf. Add `purpose:` (one line) to the front matter, and `width: half` or `width: third` to a block to place two or three side by side. Choose colors with --theme ID or --dark, or write a theme .json; run `slurp report show list` for ids. A custom page template is a .css file (--style FILE; start from `slurp report show style grid`). Run `slurp report check FILE` before building: it lists every mistake with its line (unknown keys, queries or columns, bad SQL or chart specs), and `build` refuses a report that fails it. Metrics take `decimals`, `prefix`, `suffix` and `compact`, tables take `limit` and `formats`; blocks must not be nested in lists or quotes. PNG/PDF cannot draw CJK, Arabic or emoji (the build warns); the HTML can. For retention, funnels and sessions use DuckDB's behavioral functions (retention(), window_funnel(), sessionize(), sequence_match()): add `extensions: [behavioral]` to a report's front matter, or pass `--extension behavioral` to slurp sql. The first use downloads the extension, so it needs a network connection once. Inspect outputs before delivering. Reports contain selected query results, so review before sharing.

## Product learning

For instrumentation or choosing improvements, read [learning-loop](references/learning-loop.md). For activation, cohorts or retention, read [analysis contracts and SQL recipes](references/analysis.md). For category comparisons, read [benchmark guidance](references/benchmarks.md) and the sourced [records](references/benchmarks.json). For A/B design or interpretation, read [experiments](references/experiments.md). Load only relevant references.

Use DuckDB 2.x. Run saved queries with `slurp sql --file query.sql`. Preserve metric definitions, SQL, checkpoint, cutoff and limitations with conclusions. Prepare and test product changes; human approval precedes production experiments and releases.

## First-run commands

Inside an initialized app or its subfolders, use `slurp send EVENT` and `slurp identify USER_ID`. The nearest parent project supplies the source and SDK key; no database or human login is needed to send. `--workspace` selects an exact project; `--source` is an explicit ingestion override. Never guess a project from the global registry.

Human onboarding uses `slurp setup` once per computer, then `slurp init` in each app. Setup configures a library and DuckDB and signs in; it never creates a source or project. Init creates or selects a project by name and opens a local quickstart page with its SDK snippet. Source IDs are an advanced scripting interface.

For noninteractive work, use explicit `init --source SOURCE` with a supplied read key and available DuckDB, or `init --name NAME` when authorized to create a project. Missing prerequisites return `setup_required`; do not retry an interactive wizard in a headless agent. Existing init runs reuse the source, database and key.

## Collection limits

HTTP 429 and 503 are retryable: honor `Retry-After` and back off. HTTP 401 and 403 are terminal for that key; surface them to the owner instead of creating another source. If the Worker hits Cloudflare's daily request cap on the Free plan, ingestion pauses and the SDK retries; ask the owner before upgrading the Cloudflare plan. `slurp status` shows archive coverage and pending publication. Read keys cannot create sources or keys.

<!-- onboarding:generated -->

## Instrument and connect

Install the JavaScript SDK with `npm install @hitslop/slurp-sdk`. Replace placeholders with source setup values, or send from the CLI with `slurp send EVENT --data JSON` and `slurp send --stdin` (NDJSON), or over HTTP from any language. Producers use publishable keys; remote bots use separately named secret read keys. Keep credentials in secret stores, never in skills or Git. The personalized setup page is local and holds your keys: do not share it.

### sdk

```js
import { init, track, flush } from '@hitslop/slurp-sdk';

init({
  endpoint: 'YOUR_INGEST_URL',
  sourceId: 'YOUR_SOURCE_ID',
  key: 'YOUR_PUBLISHABLE_KEY',
});

track('signed_up', { plan: 'pro' });
await flush(); // Node: flush before exiting
```

### sync

```sh
slurp init --backend YOUR_BACKEND --source YOUR_SOURCE_ID
slurp sync
slurp sql 'SELECT event, count(*) AS n FROM events GROUP BY event'
```

### agent

```sh
slurp agent setup --out .agents/skills/slurp
# Put the bot read key in its secret store as SLURP_TOKEN.
slurp init --backend YOUR_BACKEND --source YOUR_SOURCE_ID
slurp sync
```

### key

```sh
slurp --backend YOUR_BACKEND source key create YOUR_SOURCE_ID --scope secret --name grok
```

### hosting

```sh
# Is the Worker reachable and which version is it?
curl YOUR_BACKEND/v1/health
# Pull new archives into your project database:
slurp sync
```
