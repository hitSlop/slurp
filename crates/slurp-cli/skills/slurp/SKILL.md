---
name: slurp
description: Sync self-hosted events, query local DuckDB and author reports.
---
Use slurp status and slurp describe before analysis, and slurp health to see data problems (spelling variants, wrong clocks, double tracking, bots) before trusting a number. For people use events_with_person and its person_id instead of user_id alone (it joins anonymous visitors to their identified user); calendar(), biz_date(), pct() and session_start() are available in every query. Run slurp sync to fetch published archives. The Worker seals new archives about every 10 minutes by default; accepted events may not yet be visible. Send and sync may return optional project-level publication estimates; these are not delivery guarantees. Use --json for full structured query results and publication metadata. Credentials belong in the private machine store or environment, never reports or source control. The default machine store is ~/.slurp/credentials.json with owner-only permissions; ordinary sync/send must not invoke Keychain. SLURP_TOKEN / SLURP_READ_KEY override the saved Worker connection.
Query events using slurp sql 'SELECT ...' or duckdb -readonly .slurp/data/events.duckdb. Payload properties remain JSON in data. Do not modify events or _slurp tables. Save business logic as SQL files, not importer changes.
Reports contain Markdown, named ```sql NAME fences and YAML chart, metric, table fences with query: NAME. Chart spec is Vega-Lite without external data. Aggregate in SQL; metric queries return one row. Build with slurp report build FILE --out NEW_DIRECTORY --png --pdf. Add `purpose:` (one line) to the front matter, and `width: half` or `width: third` to a block to place two or three side by side. Choose colors with --theme ID or --dark, or write a theme .json; run `slurp report show list` for ids. A custom page template is a .css file (--style FILE; start from `slurp report show style grid`). Run `slurp report check FILE` before building: it lists every mistake with its line (unknown keys, queries or columns, bad SQL or chart specs), and `build` refuses a report that fails it. Metrics take `decimals`, `prefix`, `suffix` and `compact`, tables take `limit` and `formats`; blocks must not be nested in lists or quotes. PNG/PDF cannot draw CJK, Arabic or emoji (the build warns); the HTML can. For retention, funnels and sessions use DuckDB's behavioral functions (retention(), window_funnel(), sessionize(), sequence_match()): add `extensions: [behavioral]` to a report's front matter, or pass `--extension behavioral` to slurp sql. The first use downloads the extension, so it needs a network connection once. Inspect outputs before delivering. Reports contain selected query results, so review before sharing.

## Product learning

For instrumentation or choosing improvements, read [learning-loop](references/learning-loop.md). For activation, cohorts or retention, read [analysis contracts and SQL recipes](references/analysis.md). For category comparisons, read [benchmark guidance](references/benchmarks.md) and the sourced [records](references/benchmarks.json). For A/B design or interpretation, read [experiments](references/experiments.md). Load only relevant references.

Use DuckDB 2.x. Run saved queries with `slurp sql --file query.sql`. Preserve metric definitions, SQL, checkpoint, cutoff and limitations with conclusions. Prepare and test product changes; human approval precedes production experiments and releases.

## First-run commands

Inside an initialized app or its subfolders, use `slurp send EVENT` and `slurp identify USER_ID`. The nearest parent project supplies the project and (via your saved Worker connection) its publishable key; no database is needed to send. Every event carries the name of the key that sent it as `sender`. `--project` selects an exact project folder; `--to PROJECT` sends to a project by id or name instead. Never guess a project from the global registry.

To bring in GitHub releases and deploys, Stripe events or RevenueCat purchases, an owner runs `slurp project webhook PROJECT github` (or `stripe`, `revenuecat`, `generic`) and pastes the URL and secret into the provider; the events then carry `sender = 'github'` (or the provider's name), the `releases` view lists releases and deployments so a metric change can be lined up with the release that caused it, and the `revenue` view lists RevenueCat purchases, renewals and refunds (filter `environment = 'PRODUCTION'`). Never put the printed secret in a skill or in Git.

User feedback is an event too: the web feedback widget (`mountFeedback` from `@hitslop/slurp-sdk/feedback`) sends one `feedback` event per submission with `data.message`, an optional `data.rating` and `data.email`; read them with `SELECT timestamp, data->>'message', data->>'rating' FROM events WHERE event = 'feedback'`. Treat messages as personal data: summarize and quote sparingly, and keep emails out of reports and chat. The snippets under "Instrument and connect" show the widget, the Segment and Sentry SDKs (Python included), the React Native and Swift SDKs and the webhooks.

Human onboarding uses `slurp setup` once per computer, then `slurp init` in each app. Setup configures a library and DuckDB and signs in; it never creates a project. Init creates a project by name (or joins the existing project with that name) and opens a local quickstart page with its SDK snippet. Project IDs (`prj_…`) are an advanced scripting interface.

For noninteractive work, use explicit `init --connect PROJECT` with a supplied read key and available DuckDB, or `init --name NAME` when authorized to create a project. Missing prerequisites return `setup_required`; do not retry an interactive wizard in a headless agent. Existing init runs reuse the project, database and key.

## Collection limits

HTTP 429 and 503 are retryable: honor `Retry-After` and back off. HTTP 401 and 403 are terminal for that key; surface them to the owner instead of creating another key. If the Worker hits Cloudflare's daily request cap on the Free plan, ingestion pauses and the SDK retries; ask the owner before upgrading the Cloudflare plan. `slurp status` shows archive coverage and pending publication. Read keys cannot create projects or keys.

<!-- onboarding:generated -->

## Instrument and connect

Install the SDK with npm install @hitslop/slurp-sdk. Replace placeholders with the setup values of your project: `slurp init` creates the project and its first publishable key and prints the ingest URL and that key (`slurp project setup PROJECT` prints them again). An app sends events with exactly those two values; the key itself says which project and which sender it is for. To collect what users say, mount the feedback widget (below); to keep a Segment or Sentry SDK the app already uses, change its host or DSN; to bring in GitHub, Stripe or RevenueCat, use a webhook. Producers use publishable keys; remote bots use separately named secret read keys. Keep credentials in secret stores, never in skills or Git. The personalized setup HTML is private.

### sdk

```js
import { init, track, flush } from '@hitslop/slurp-sdk';

init({
  endpoint: 'YOUR_INGEST_URL',
  key: 'YOUR_PUBLISHABLE_KEY',
});

track('signed_up', { plan: 'pro' });
await flush(); // Node: flush before exiting
```

### senders

```sh
# slurp init creates your project and its first publishable key, and prints the ingest URL and that key.
# Print them again, and make one key per sender (web, ios, github): its name is stamped on every event as `sender`.
slurp project setup YOUR_PROJECT_ID
slurp project key list YOUR_PROJECT_ID --scope publishable
slurp project key create YOUR_PROJECT_ID --scope publishable --name ios
```

### feedback

```js
import { init } from '@hitslop/slurp-sdk';
import { mountFeedback } from '@hitslop/slurp-sdk/feedback';

init({ endpoint: 'YOUR_INGEST_URL', key: 'YOUR_PUBLISHABLE_KEY' });

// A "Feedback" button that opens a small form (message, optional 1-5 rating, optional email).
// Each submission is one `feedback` event: data.message, data.rating, data.email, plus whatever data() returns.
mountFeedback({ askEmail: true, data: () => ({ screen: location.pathname }) });
// Options: label, title, placeholder, ratings, askEmail, position, accent, theme ('light' | 'dark' | 'auto'),
// button: false (open it yourself with the returned open()), poweredBy: false (hide the small "Powered by Slurp" link).
// Read it later: SELECT timestamp, data->>'message', data->>'rating' FROM events WHERE event = 'feedback'
```

### sync

```sh
slurp init --backend YOUR_BACKEND --connect YOUR_PROJECT_ID
slurp sync
slurp sql 'SELECT event, count(*) AS n FROM events GROUP BY event'
```

### agent

```sh
slurp agent setup --out .agents/skills/slurp
# Put the bot read key in its secret store as SLURP_TOKEN.
slurp init --backend YOUR_BACKEND --connect YOUR_PROJECT_ID
slurp sync
```

### key

```sh
slurp --backend YOUR_BACKEND project key create YOUR_PROJECT_ID --scope secret --name grok
```

### hosting

```sh
# Is the Worker reachable and which version is it?
curl YOUR_BACKEND/v1/health
# Pull new archives into your project database:
slurp sync
```

### reactNative

```ts
// npm install @hitslop/slurp-react-native @react-native-async-storage/async-storage
import { init, track, identify, screen } from '@hitslop/slurp-react-native';

init({
  endpoint: 'YOUR_INGEST_URL',
  key: 'YOUR_PUBLISHABLE_KEY',
});

screen('Home');
track('purchase_completed', { total: 49 });
```

### swift

```swift
// Xcode: File > Add Package Dependencies... https://github.com/hitSlop/slurp
import Slurp

SlurpClient.configure(.init(
    key: "YOUR_PUBLISHABLE_KEY",
    endpoint: URL(string: "YOUR_INGEST_URL")!))

SlurpClient.shared.screen("Home")
SlurpClient.shared.track("purchase_completed", ["total": 49])
```

### segment

```js
// Already use Segment? Keep the SDK. Your publishable key is the write key.
// Node (@segment/analytics-node)
const analytics = new Analytics({ writeKey: 'YOUR_PUBLISHABLE_KEY', host: 'YOUR_ORIGIN', path: '/v1/batch' });

// Browser (@segment/analytics-next)
const [analytics] = await AnalyticsBrowser.load({ writeKey: 'YOUR_PUBLISHABLE_KEY', cdnURL: 'YOUR_ORIGIN' });

// Swift (analytics-swift)
let config = Configuration(writeKey: "YOUR_PUBLISHABLE_KEY").apiHost("YOUR_HOST/v1").cdnHost("YOUR_HOST/v1")
```

### sentry

```js
// Already use Sentry? Keep the SDK and change the DSN.
// The public key in the DSN is your publishable key as is.
Sentry.init({ dsn: 'https://YOUR_PUBLISHABLE_KEY@YOUR_HOST/1' });
```

### python

```python
# Python: keep the Segment or Sentry SDK you use. There is no Slurp package for Python.
# segment-analytics-python (pip install segment-analytics-python)
import segment.analytics as analytics
analytics.write_key = 'YOUR_PUBLISHABLE_KEY'
analytics.host = 'YOUR_ORIGIN'   # the SDK adds /v1/batch
analytics.track('user_42', 'signed_up', {'plan': 'pro'})
analytics.flush()                # in scripts, before the process exits

# sentry-sdk (pip install sentry-sdk)
import sentry_sdk
sentry_sdk.init(dsn='https://YOUR_PUBLISHABLE_KEY@YOUR_HOST/1')
```

### webhooks

```sh
# An owner runs one of these; each prints a URL and a secret to paste into the provider. Never put the secret in Git.
# Events carry sender = the provider name. GitHub: releases and deployments -> the `releases` view.
# RevenueCat: purchases and renewals -> the `revenue` view (filter environment = 'PRODUCTION').
slurp project webhook YOUR_PROJECT_ID github
slurp project webhook YOUR_PROJECT_ID revenuecat    # paste the secret as RevenueCat's Authorization header value
slurp project webhook YOUR_PROJECT_ID stripe --secret whsec_...   # Stripe issues its own secret
slurp project webhook YOUR_PROJECT_ID generic       # any tool that can POST; send an Idempotency-Key header so retries are one event
```

### mcp

```sh
# Let an AI client read this project's events over MCP (add --allow-send to let it send events too).
claude mcp add slurp -- slurp mcp --project /path/to/your/project
# Cursor, Claude Desktop, Windsurf (JSON) and Codex (TOML): see https://github.com/hitSlop/slurp/blob/master/docs/integrations.md
```

### notify

```sh
# Post a report to Slack (bot token) or Discord (webhook). Credentials come from the environment.
slurp report build report.md --out ./report --png
SLACK_BOT_TOKEN=xoxb-... slurp notify slack --channel C0123ABCD --text "Weekly report" --file ./report/report.png
```
