# 0.2.0 migration baseline

Synthetic data written by the 0.2.0 CLI, its embedded Worker, and the published JavaScript SDK. The CLI came from the stable release workflow's macOS ARM artifact. The Worker ran locally with geo disabled. No production data or credentials are included.

- `database.duckdb`: two events, two import receipts, one conflict in `_slurp.problems`, and one row in the user table `fixture_labels`. The conflicting delivery leaves the first event unchanged.
- `project.sql` and `registry.sql`: application tables and indexes from the Worker's SQLite storage. Miniflare and Cloudflare runtime metadata are excluded.
- `archive-1.ndjson.gz` and `archive-2.ndjson.gz`: the original compressed archive bytes. `archives.json` records their published checksums and format numbers.
- `sdk-state.json`: an identity and two events queued by the npm SDK, before delivery.
- `manifest.json`: release provenance, the fixture project's binding, expected counts, and SHA-256 digests.

Treat these files as immutable input. For the first migration, copy the relevant fixture into a temporary directory, run the real upgrade, and check the old events, receipts, problems, user table, and queued identities survive. Repeat the upgrade to check it is idempotent. Keep the original fixtures unchanged when adding later baselines.

The database needs DuckDB 2.x. The SQL files contain ordinary application statements suitable for loading into SQLite or a test Durable Object. The SDK state is the saved value, without a live endpoint or key.
