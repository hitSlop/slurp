# Changelog

## Unreleased

- The Worker has a dashboard at `/dashboard` that lists your projects and what is wrong with them: failing archive publication, a full ingest buffer, a project that was never set up. The page holds no data and asks for the `ADMIN_TOKEN`; the same report is at `GET /v1/admin/status` (admin token only).
- `slurp cloud status` lists every project with its issues in one request, and exits 1 when a project has an error. Run `slurp cloud upgrade` first: an older Worker is reported as not checked. Its project lines now show each project's state, sources and last archive (they always read "none yet" before).

## 0.2.1

- Discover built-in SQL macro signatures and examples with `slurp functions [NAME]` or MCP.
- Added isolated terminal-onboarding checks and deterministic slow-response Swift compatibility coverage.
- Setup accurately reports whether the Worker connection was verified, including local-only setup.
- Teammates using project secret keys initialize without admin-only SDK setup requests.
- Fixed person counts in the MCP summary and health after anonymous visitors identify.
- Added the `slurp_summary` view for tracked activity, active people, and identity/location coverage.
- DuckDB sessions default to UTC across SQL, reports, and the interactive shell.
- New projects get a richer overview with separate daily activity and people charts.
- Helper refresh failures warn without preventing ordinary reads.

## 0.2.0

The first supported release. Start with a fresh Worker and local setup. From this baseline onward, upgrades migrate supported stored data automatically.

- Commit the portable `slurp/slurp.toml` binding and reports; keep databases and credentials machine-local.
- Teammates initialize a clone with project secret keys, then publish and sync their own project's archives.
- Database upgrades use isolated backups, version checks, and transactional migrations. Deployment upgrades verify readiness and refuse downgrades.
- `slurp cloud init --domain HOST` configures a custom domain and preserves it on upgrades.
- New projects include an overview report; report builds default to `slurp/out/`.



This release establishes the contracts between the Worker, CLI, and SDKs. They are written down in [docs/contracts.md](docs/contracts.md).

- **Breaking: a record needs only an `event`.** `{"event":"signed_up"}` is a valid body. `id`, `type`, `timestamp` and `data` are optional, a single JSON object is a valid body, and `?key=` works on `/v1/events` as well as the `Authorization` header. The Worker answers `{"ok":true,"accepted":N}`, and a `400` lists every bad line (`{"error":"invalid records","rejected":[{"line":3,"reason":"..."}]}`) and stores nothing. `Slurp-Duplicate` is gone: a record without an `id` is a new event each time, so send an `id` to make a retry safe (the SDKs, `slurp send` and the MCP tools always do).
- **Breaking: archives hold envelopes.** Each line is `{received_at, sender, geo?, record}` with the client's record byte for byte inside, so the Worker never invents or reserves a client field. The local import fills in the defaults (a missing `id` becomes `slurp:<archive>:<line>`, a missing `timestamp` the `received_at`), and an event is identified by `(sender, id)`. `geo` is its own column instead of `context.geo`.
- **Sync never stops on content.** An id reused with different content, a line of the wrong shape and archives that retention deleted before they were read become rows in `_slurp.problems` instead of stopping the import. `slurp sync` counts them and `slurp health` reports them. Only integrity failures (a failed download, a size or SHA-256 mismatch, a truncated archive, a skipped archive number) stop a sync.
- **`slurp sync --now`** asks the Worker to publish what it has buffered (admin token) and then imports it, so events sent a moment ago are included. `slurp sync` no longer prints a countdown.
- **Breaking: keys carry a source.** A publishable key is `slurp_pk_<project>_<source>_<random>`, and its source is stamped on every event as `sender`. Make one with `slurp project key create PROJECT --scope publishable --source ios`; rotate by creating another key for the same source and revoking the old one. `slurp send` and `slurp identify` send as `cli` (or `--source NAME`) and the MCP send tools as `mcp`, so `context.source = "mcp"` is gone: filter with `WHERE sender <> 'mcp'`.
- **Breaking: a plain JSON control API.** The webrpc services and generated clients are replaced by `POST /v1/rpc/<Method>` with 11 methods. Their types are defined once in Rust (`crates/slurp-client/src/api.rs`) and exported to TypeScript. Signed download links and `archive_id` are gone: archives are downloaded with an authenticated `GET /v1/projects/<id>/archives/<seq>`. `slurp project update` and `slurp project webhook --rotate` are removed: to rotate a webhook, revoke its key and run `slurp project webhook` again (for Stripe, pass the new `--secret`). Webhook secrets are stored per connection, so rotating `ADMIN_TOKEN` no longer changes them.
- **A new publishing engine in the Worker.** Accepted events are stored as chunks of at most 6 MiB, an archive is planned as a stored publish intent, and the manifest row is committed together with the chunk deletion, so a restart resumes the same archive. Settings are parsed once and bad values fall back to the default with a warning. `ARCHIVE_MAX_BYTES` replaces `SEAL_MAX_BYTES`, and `GEO` is `on` or `off` for the whole Worker (the per-project geo setting and `--geo` / `--no-geo` are gone). Durable Object rows are kept under their 8 MB limit.
- **Breaking: no first-party Swift SDK.** iOS and macOS use Segment's `analytics-swift` pointed at your Worker. Set both `apiHost("HOST/v1")` and `cdnHost("HOST/v1")`: without `cdnHost` it fetches its settings from Segment's CDN and can send events there. The React Native SDK stays, as a thin wrapper over the JavaScript SDK.
- **JavaScript SDK: simpler delivery.** A retry resends the same events (not byte-identical bodies), a `401` or `403` stops the client for this run only (nothing is saved, so the next launch tries again), and saved state is namespaced by endpoint, project and source.
- **`slurp setup` verifies the DuckDB download** against pinned SHA-256 digests before installing it, and the native tests fail in CI instead of skipping when DuckDB is missing.
- **Fixed: report PNGs cut their charts off.** `slurp report build --png`, `slurp notify` images and MCP report builds drew each chart clipped to the top-left quarter of its plot: bars started at half height, lines and areas stopped part-way. Charts now draw whole and stay sharp at 2x.

## 0.1.2

- **The agent skill and the setup page cover every way to send events.** `slurp agent setup` now teaches an agent where the endpoint and key come from (`slurp init` creates the project and its first publishable key; `slurp project setup` shows them again), the web feedback widget, the Segment and Sentry SDKs in Python, and the GitHub, RevenueCat, Stripe and generic webhooks with the `releases` and `revenue` views. A test keeps it that way.
- **Feedback widget** (`@hitslop/slurp-sdk` 0.1.2): a small "Powered by Slurp" link under the form, which opens slurp.run in a new tab without telling it which site it came from. `poweredBy: false` hides it. The Send button also keeps its accent colour in dark mode.

## 0.1.1

Run `slurp cloud upgrade` to put the fixes below on an existing Worker (your data and settings are kept).

- **RevenueCat webhooks (Preview)**: `slurp project webhook PROJECT revenuecat` gives the URL and the Authorization header value to paste into RevenueCat. Purchases, renewals, cancellations and refunds arrive as `revenuecat.<type>` events (retries are one row), and a `revenue` view in SQL lists them. RevenueCat's optional HMAC signing is not supported yet.
- **Fixed: a redelivered webhook could stop `slurp sync`.** A webhook with no time of its own was stamped with its arrival time, so a redelivery had the same id and a different time, which the importer treats as a conflict. Such a delivery now keeps the time it first arrived. A generic POST with no `Idempotency-Key` and no body `timestamp` is its own event each time. See [webhooks](docs/webhooks.md).
- **Fixed: archives stay unpublished after a long R2 outage.** Cloudflare retries a failing alarm six times and then stops. Publishing now schedules its own retries with backoff until R2 answers, so a quiet project publishes by itself once R2 is back (`ARCHIVE_RETRY_MS`).
- **Fixed: oversized bodies were buffered before being refused.** `/v1/events` now reads its body as a capped stream and stops at the limit, even with no `Content-Length`.
- **Fixed: an impossible timestamp such as `1e300` failed a whole Sentry envelope.** Sentry and Segment events with a time that is not a real date now fall back to `sent_at`, then the arrival time.
- Archive listings sign every URL with one key and one expiry, and report that expiry.
- **slurp.run measures itself with Slurp** (see `dogfood/`): page views, the feedback widget and two clicks go to a Worker in the maintainers' account, and the report that reads them is committed as an example. The site also got a mobile pass.

## 0.1.0

The first release.

- **Self-hosted event capture** in your own Cloudflare account: a Worker with one Durable Object per project (its keys, group commit, sealing alarm) and an R2 bucket of sealed gzip NDJSON archives, deployed with one command (`slurp cloud init`) or the Deploy to Cloudflare button.
- **Projects and senders**: a project is one event stream; a website, an app and a webhook can all send into it with their own publishable keys (`slurp project key create PROJECT --scope publishable --name ios`), and every event is stamped with its key's name as `sender` (a column in your local `events` table). A key names its project (`slurp_pk_<project>_<random>`), so a request never waits on a global lookup, a revoked key stops on the next request, and the SDKs need no project id. `slurp init` is idempotent: asking for a name that exists joins that project and never changes a key.
- **Python**: the Segment and Sentry Python SDKs (`segment-analytics-python`, `sentry-sdk`) work unmodified by changing the host or the DSN, verified against a real Worker on Python 3.9, 3.12 and 3.14. There is no native Python SDK.
- **Webhooks (Preview)**: GitHub, Stripe or any tool that can POST sends events to `/hooks/<provider>` on your Worker, each with its own named key (so events carry `sender = 'github'`), checked against the provider's signature and stored whole. `slurp project webhook PROJECT github` prints the URL, the secret and the steps; a `releases` view in SQL lists GitHub releases and deployments. Tested against the providers' documented signature examples, not yet live deliveries. See [webhooks](docs/webhooks.md).
- **`slurp` CLI** (macOS and Linux): `cloud init|status|doctor|upgrade|destroy`, `connect`, `setup`, `init`, `send`, `identify`, `sync` into a local DuckDB file, `sql`, `health`, `report` and agent skills. Install with `curl -LsSf https://slurp.run/install | sh` or `npm install -g @hitslop/slurp`.
- **JavaScript SDK**, `@hitslop/slurp-sdk`: browser and Node capture with a durable queue, batching and byte-identical retries (0.1.1 also runs on React Native).
- **Reports**: Markdown with named SQL, charts, metrics and tables, rendered to a self-contained HTML file (with hover details), PNG and PDF; themes and templates you can write yourself; DuckDB's behavioral functions for retention, funnels and sessions.
- **SQL helpers** in every project database: `events_with_person`, `calendar()`, `session_start()`, `pct()` and more.
- **React Native / Expo SDK**, `@hitslop/slurp-react-native`: events kept in AsyncStorage so they survive the app being killed, sent when the app goes to the background or the network returns, with device and app context. Preview: tested against fakes, not yet on a device.
- **Swift SDK** (iOS, macOS, tvOS, watchOS): Foundation only, file-backed durable queue, byte-identical retries, lifecycle flush. Add `https://github.com/hitSlop/slurp` in Xcode. Preview: unit tested and run against a local Worker, not yet in an app on a device.
- **Use your Segment SDK**: change its host to your Worker (`/v1/t|i|p|s|g|a`, `/v1/b`, `/v1/batch` and the settings document). Verified with analytics-node, analytics-next and analytics-swift.
- **Use your Sentry SDK**: change the DSN (the public key is your publishable key in hex). Errors are stored whole as `error` events and read with the new `errors` view. No symbolication or issue UI. Verified with `@sentry/node` and `@sentry/browser`.
- **Records up to 1 MiB**, stored whole and never truncated (was 32 KiB); a larger record is refused with `413`.
- **Sharper report PNGs**: drawn at 2x (1680 px wide for the 840 px layout), so text and charts stay crisp on high-density screens and when shared in chat or email.
- **`slurp mcp`**: an MCP server over stdio so Claude Code, Claude Desktop, Cursor, Codex and Windsurf can read your events (`describe_schema`, read-only `sql` in a sandbox with no local file access, `sync`, `health`, reports). `--allow-send` adds `send_event` and `identify`, tagged `context.source = "mcp"`.
- **`slurp notify slack|discord`**: post a message and a report image from the command line (Slack bot token or webhook, Discord webhook), for scheduled reports.
- **A small public API**: every method of the Worker's webrpc schema is tagged `@public` (a client outside this repo may use it) or `@internal` (CLI and control plane), so a client for third parties can be generated from the public methods only.
- **Link previews**: a social card (`og.png`) and Open Graph and Twitter tags on every page of the site.
- **Feedback widget** in the JS SDK (`@hitslop/slurp-sdk/feedback`): a drop-in "Feedback" button and form that sends a `feedback` event with the message, an optional rating and email.
- **One set of delivery rules in every SDK**, checked by the shared scenarios in `sdks/conformance/delivery.json`: any 2xx acknowledges a batch; 408, 429, 5xx, network errors and requests with no answer are retried with the identical bytes; 413 splits a batch and drops only a single oversized event; 401 and 403 stop the client; the queue is bounded in bytes as well as events (`maxQueueBytes`); damaged saved lines are dropped rather than sent; a replaced key starts sending again. React Native stores its queue in 256 KB pieces to stay under AsyncStorage's per-value limit, and Swift reports errors on a queue of its own so handlers can safely call back into the client.
- **One saved connection**: the CLI keeps one plain token per Worker (no logins, sessions or refresh), and `slurp whoami` (the `Auth.Whoami` RPC) says what any key is (admin, secret or publishable, and its project and name), so a bot can verify its own read key. `slurp connect` accepts only the admin token and says why. See [How the connection works](docs/connection.md).

