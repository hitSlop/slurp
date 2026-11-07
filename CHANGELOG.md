# Changelog

## 0.1.0

The first release.

- **Self-hosted event capture** in your own Cloudflare account: a Worker with one Durable Object per source (group commit, sealing alarm) and an R2 bucket of sealed gzip NDJSON archives, deployed with one command (`slurp cloud init`) or the Deploy to Cloudflare button.
- **`slurp` CLI** (macOS and Linux): `cloud init|status|doctor|upgrade|destroy`, `connect`, `setup`, `init`, `send`, `identify`, `sync` into a local DuckDB file, `sql`, `health`, `report` and agent skills. Install with `curl -LsSf https://slurp.run/install | sh` or `npm install -g @hitslop/slurp`.
- **JavaScript SDK**, `@hitslop/slurp-sdk`: browser and Node capture with a durable queue, batching and byte-identical retries (0.1.1 also runs on React Native).
- **Reports**: Markdown with named SQL, charts, metrics and tables, rendered to a self-contained HTML file (with hover details), PNG and PDF; themes and templates you can write yourself; DuckDB's behavioral functions for retention, funnels and sessions.
- **SQL helpers** in every project database: `events_with_person`, `calendar()`, `session_start()`, `pct()` and more.
- **React Native / Expo SDK**, `@hitslop/slurp-react-native`: events kept in AsyncStorage so they survive the app being killed, sent when the app goes to the background or the network returns, with device and app context. Preview: tested against fakes, not yet on a device.
- **Swift SDK** (iOS, macOS, tvOS, watchOS): Foundation only, file-backed durable queue, byte-identical retries, lifecycle flush. Add `https://github.com/hitSlop/slurp` in Xcode. Preview: unit tested and run against a local Worker, not yet in an app on a device.
- **Use your Segment SDK**: change its host to your Worker (`/v1/t|i|p|s|g|a`, `/v1/b`, `/v1/batch` and the settings document). Verified with analytics-node, analytics-next and analytics-swift.
- **Use your Sentry SDK**: change the DSN (the public key is your publishable key in hex). Errors are stored whole as `error` events and read with the new `errors` view. No symbolication or issue UI. Verified with `@sentry/node` and `@sentry/browser`.
- **Records up to 1 MiB**, stored whole and never truncated (was 32 KiB); a larger record is refused with `413`.
