# Changelog

## 0.1.0

The first release.

- **Self-hosted event capture** in your own Cloudflare account: a Worker with one Durable Object per source (group commit, sealing alarm) and an R2 bucket of sealed gzip NDJSON archives, deployed with one command (`slurp cloud init`) or the Deploy to Cloudflare button.
- **`slurp` CLI** (macOS and Linux): `cloud init|status|doctor|upgrade|destroy`, `connect`, `setup`, `init`, `send`, `identify`, `sync` into a local DuckDB file, `sql`, `health`, `report` and agent skills. Install with `curl -LsSf https://slurp.run/install | sh` or `npm install -g @hitslop/slurp`.
- **JavaScript SDK**, `@hitslop/slurp-sdk`: browser and Node capture with a durable queue, batching and byte-identical retries.
- **Reports**: Markdown with named SQL, charts, metrics and tables, rendered to a self-contained HTML file (with hover details), PNG and PDF; themes and templates you can write yourself; DuckDB's behavioral functions for retention, funnels and sessions.
- **SQL helpers** in every project database: `events_with_person`, `calendar()`, `session_start()`, `pct()` and more.
