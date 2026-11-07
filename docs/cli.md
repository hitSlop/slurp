# Slurp CLI

Capture application events with the Slurp SDK, sync them into a local DuckDB file, and let your coding agent analyze them and author reports. Each workspace binds one source on your own Worker to one database. No desktop, daemon, DuckLake, or bundled analytical engine.

## Install and start

Install a release (macOS or Linux; Windows is not supported yet):

```sh
curl -LsSf https://slurp.run/install | sh
# or: npm install -g @hitslop/slurp
```

To build from source instead you need Rust stable (and Go 1.27.1 for backend development): `cargo build -p slurp-cli && export PATH="$PWD/target/debug:$PATH"`. Slurp uses the DuckDB CLI; **2.0.0** is the tested release, and it uses JSON and SQL without DuckLake extensions. `slurp setup` finds DuckDB or installs it for you.

```sh
slurp setup
cd /path/to/your/app
slurp init
slurp sync
slurp describe
slurp sql 'SELECT event, count(*) AS n FROM events GROUP BY event'
slurp duckdb
# Ask your agent to create report.md, then:
slurp report build report.md --out .slurp/output/first --png --pdf
slurp report open .slurp/output/first
```

`setup` runs once per computer: choose a default event library, prepare DuckDB, and connect your Worker. It creates no project or source. `init` runs inside each app: create or select a named project, choose its data folder, and open its personalized quickstart. Running `init` first guides you through missing machine setup.

For a complete live test, follow the [six-event walkthrough](live-walkthrough.md), including waiting for the next archive seal, syncing and building a local report.

`setup` finds DuckDB or asks before downloading an official binary into `~/.slurp/bin/duckdb`. It changes no shell configuration. Alternatively pass `init --duckdb /absolute/path/to/duckdb`. Service operations do not require DuckDB. Local reports and SQL do not require cloud login.

Once configured, `slurp setup` opens a short menu: Done, Change the default library, Compare / buy an SSD, and Check setup. Done leaves settings untouched. `slurp --json setup` returns a read-only availability summary, including disconnected storage, without accessing credentials or starting login. The default library change applies only to future projects; physical migration is not included.

Worker commands include `cloud init|status|doctor|upgrade|destroy` (deploy and operate your Worker, see [self-hosting](self-hosting.md)), `connect`, `whoami`, `source create/list/show/setup/update`, `source key create/list/revoke`, `source member list/add/remove`, `send`, and `identify`. Run `slurp connect https://your-worker.workers.dev --token-stdin < admin-token.txt` once per computer: it verifies the Worker and its admin token, then saves both (see [self-hosting](self-hosting.md)). Without a saved backend the CLI targets the local `wrangler dev` Worker at `http://127.0.0.1:8787`. Backend selection uses `--backend` / `SLURP_BACKEND`, then the saved workspace binding, then a project-root `slurp.toml`, then system settings, then the backend saved by `slurp connect`, and finally the local `wrangler dev` default. Local commands accept `--workspace DIRECTORY`. Init saves the resolved binding in `.slurp/project.toml`; existing databases retain their original backend and source. Use a fresh workspace when changing servers.

## Bot access

Create a separate revocable read key for each bot:

```sh
slurp source key create src_ID --scope secret --name muse
slurp agent setup --out .agents/skills/slurp
```

Transfer the returned key through your bot's secret store. On its machine set `SLURP_TOKEN` to that key, initialize a workspace using the explicit source ID and backend, then run `slurp sync`. Bots never sign in; they only need the key. Keys and signed download URLs never belong in project files. Saved sessions and SDK keys use the private machine credential file by default; headless bots can override with environment credentials.

## Credentials without prompts

The default store is `~/.slurp/credentials.json`, or `SLURP_HOME/credentials.json`.
It is plaintext with owner-only permissions (`0600`) inside the private Slurp home
(`0700`). It holds backend-scoped sessions and backend/source-scoped SDK keys.
Writes are locked and atomic; credentials never belong in project/event folders or
Git. Another process running as your user can read the file. No decryption key or
Keychain access is required for ordinary sync/send. Environment credentials take
priority over saved values.

To reuse credentials from an earlier Keychain-based installation, run once:

```sh
slurp credentials migrate-keychain
slurp sync
```

Import copies this backend's session and cached source SDK keys. It may prompt for
each Keychain item this one time. Existing file values win, and the original
Keychain entries remain. Repeat for another server with `--backend URL` when
needed. No values are printed. A denied import leaves the destination unchanged.
SDK
keys can be imported separately by rerunning the migration command.

Native storage remains available by setting `credential_store = "keychain"` in
`~/.slurp/config.toml`. The default is `"file"`. The stores are independent:
missing credentials, file errors, and failed refreshes never trigger automatic
Keychain fallback. Logout clears the selected backend's saved session; cached SDK
keys remain until separately revoked/removed. Corrupt or overly permissive files
are rejected without exposing or overwriting their contents.

## Send events from your project

```sh
slurp send signed_up --user-id demo_alice --data '{"plan":"pro"}'
slurp identify demo_alice --data '{"plan":"pro"}'
# Canonical NDJSON from a file or pipeline:
slurp send --stdin < events.ndjson
# Explicit source outside an initialized project:
slurp send signed_up --source src_ID --backend https://YOUR_API --data '{}'
```

These commands use the project's source, cached ingest URL, and publishable key in the selected machine credential store. Sending does not require DuckDB, a connected data drive, or an admin token. A missing SDK key produces an owner/key-setup instruction rather than creating a key automatically. The old source-first positional form is replaced by `--source`.

Project-aware commands find the nearest `.slurp/project.toml` in the current folder or its parents. This includes send, identify, sync, SQL, status, doctor, describe, and report builds. `--workspace PATH` selects an exact initialized folder. A malformed nearest configuration fails instead of falling through to a different project. Init still targets the exact current or selected folder, allowing nested projects; setup and the registry are machine-wide. File arguments remain relative to the calling folder.

In project mode, environment key/endpoint overrides require both `SLURP_SOURCE_ID` and `SLURP_BACKEND` to match the selected binding. Unrelated environment values cannot redirect that project's events, including a backend left over from another app. Explicit `--source` accepts environment credentials or the corresponding cached key. Publishable keys only send events; `SLURP_TOKEN` read keys remain separate for sync.

## Data contract

- `.slurp/project.toml`: non-secret source binding and engine/database paths.
- `<library>/<project-folder>/events.duckdb`: default database. Explicit scripted source bindings without a library use `.slurp/data/events.duckdb`, ignored by Git. `init --data-dir DIRECTORY` selects another project data folder; `--database FILE` selects an exact database path.
- `events`: canonical track/identify envelope fields, JSON `data` and `context`, complete `raw_record`, and producer fingerprint.
- `_slurp.identity` and `_slurp.deliveries`: versioned binding and committed delivery receipts. Do not edit these or `events` manually.
- Reports are ordinary Markdown files. Generated output directories are ignored; choose a fresh `--out` for each successful build.

Sync verifies immutable compressed objects and loads JSONL through installed DuckDB. It commits events and their archive receipt together. Identical IDs with identical producer content are skipped; conflicting IDs roll back that archive. Backend receive timestamps and geo stamps do not turn a retry into a conflict. There is no business-data cleaning, schema inference, or automatic identity stitching.

Your Worker seals buffered events into an archive about every 10 minutes by default (`SEAL_INTERVAL_MS`), or sooner when a batch reaches 8 MB. Send and sync display the Worker's estimate of the next seal when available. An estimate describes the source buffer, not whether an individual event is published. Accepted events may not yet be available to sync. Local sync is independent of cloud retention: committed local rows remain. Retention gaps and archive resets require a new workspace; existing data is preserved. Sync and external database readers must take turns. Close open DuckDB sessions before syncing.

Queries return columns, exact JSON values, up to 1,000 rows, and an explicit truncation flag. DuckDB subprocesses have a 60-second timeout and a 32 MiB output bound. Arbitrary local SQL is trusted code, not a filesystem sandbox.

## Helpers and health checks

Every project database gets a few helpers (installed on `slurp init`, and added to older databases the next time you run a command), so queries stay short:

| Helper | What it gives you |
|---|---|
| `events_with_person` | `events` plus a `person_id`: `u:<user id>` when the person is known, else `a:<anonymous id>`. An anonymous visitor is linked to a user only when their identify events name exactly one user; a visitor tied to two users is left separate. Count people with `count(DISTINCT person_id)`. |
| `identity_links` | The anonymous id to user id links behind it. |
| `calendar(start, end)` | One row per day (or `step := '1 hour'`), so charts show zero days instead of skipping them. Columns `biz_date`, `weekday`, `is_weekday`. |
| `biz_date(ts)`, `biz_trunc(part, ts)` | The date or `date_trunc` in your timezone. UTC by default; define your own `biz_tz()` in a query to change it. |
| `session_start(ts, previous_ts, gap_minutes)` | 1 when an event starts a new session. Add the 1s up in a window to number sessions without an extension (see the comment in `crates/slurp-cli/assets/helpers.sql`). |
| `pct(part, total)`, `share(x)`, `safe_num(x)` | Percentages and shares that return NULL instead of failing on zero or bad values. |

```sql
SELECT biz_date(timestamp) AS day, count(DISTINCT person_id) AS people
FROM events_with_person GROUP BY 1 ORDER BY 1
```

`slurp health` runs four exact checks and prints only what needs attention: event names spelled more than one way, events stamped in the future (a wrong client clock), the same event tracked twice under different ids, and ids far busier than everyone else (bots, test accounts). It suggests fixes and changes nothing; `--json` includes the evidence.

## Behavioral SQL: retention, funnels, sessions

DuckDB's `behavioral` community extension adds product-analytics functions that are awkward in plain SQL: `retention()`, `window_funnel()`, `sessionize()`, `sequence_match()`, `sequence_count()` and `sequence_next_node()`. Slurp can load it for you; it is installed once from DuckDB's community repository (this computer must be online the first time) and works offline afterwards. It is the only community extension Slurp allows.

```sh
slurp sql --extension behavioral "SELECT behavioral_version()"
```

In a report, name it in the front matter and `slurp report build` loads it for every query:

```yaml
---
extensions: [behavioral]
---
```

Weekly retention, one boolean per week per user, then averaged per cohort (see [examples/demo/retention.md](../examples/demo/retention.md)):

```sql
WITH act AS (SELECT DISTINCT user_id, date_trunc('week', timestamp::TIMESTAMP)::DATE AS wk FROM events WHERE user_id IS NOT NULL),
first AS (SELECT user_id, min(wk) AS cohort FROM act GROUP BY 1),
per_user AS (
  SELECT f.cohort, retention(a.wk = f.cohort, a.wk = f.cohort + 7, a.wk = f.cohort + 14) AS r
  FROM act a JOIN first f USING (user_id) GROUP BY a.user_id, f.cohort
),
cells AS (SELECT cohort, generate_subscripts(r, 1) - 1 AS week, unnest(r)::INT AS hit FROM per_user)
SELECT cohort, week, avg(hit) AS retained FROM cells GROUP BY cohort, week ORDER BY cohort, week
```

Funnel, counting a session only when the steps happen in order within an hour (see [examples/demo/funnel.md](../examples/demo/funnel.md)):

```sql
SELECT count(*) FILTER (WHERE level >= 2) AS started FROM (
  SELECT window_funnel(INTERVAL 1 HOUR, timestamp::TIMESTAMP, event = 'opened', event = 'started', event = 'done') AS level
  FROM events GROUP BY session_id)
```

Tips: use `GROUP BY` inside the aggregate's query (not `ORDER BY` inside the call or `OVER ()`), take at most 32 conditions per call, and cast `timestamp` to `TIMESTAMP` for `window_funnel`. In `retention()`, the first condition defines the cohort and every later element answers "was the user also active at this offset".

## Reports

See [Writing reports](reports.md) for the file format, blocks, number formats and the checks `slurp report check` runs, and [examples/demo](../examples/demo) for finished reports. Define named `sql NAME` fences and `metric`, `table`, or `chart` YAML fences with `query: NAME`. Charts contain a Vega-Lite `spec`; external chart datasets are disabled. Metric queries must return one row. Aggregate chart data in SQL; chart and metric queries returning more than 1,000 rows fail explicitly (a table shows its first rows and says how many there are).

YAML front matter can declare scalar defaults:

```yaml
---
params:
  event_name: {type: string, default: signup}
---
```

Reference `$event_name` in SQL and override with `--param event_name=purchase`. `slurp report check FILE` reports every problem with its line (unknown keys and queries, chart fields that are not columns, bad SQL, bad chart specs). Builds evaluate all named queries in one read-only snapshot. HTML embeds charts and fonts; PNG uses Takumi and PDF uses takumi-pdf. Generated reports embed selected query results; review before sharing.

Choose colors with `--theme` (a built-in id, or your own `.json` file) or `--dark`, the page layout with `--style` (`grid`, or your own `.css` template), and append tweaks with `--css FILE`. Front matter takes `theme:`, `style:`, `purpose:` and `date:`, and any block takes `width: half` or `third`. `slurp report show list|theme|style` prints the built-in themes and template to copy. See [report-styling.md](report-styling.md) to write your own.

## Architecture

`slurp_app` is a library target in the CLI package. It owns workspace, query, sync, cancellation/progress, and report operations without terminal interaction. `main.rs` and the reused service command adapter handle user interaction. Future desktop code can call the library directly; no local RPC protocol or daemon is introduced.

`slurp-client` owns cloud authentication, transport, and archive validation. `slurp-document` sanitizes Markdown. `slurp-render` owns browser-free chart/Takumi rendering. `report-assets` contains the retained desktop chart/theme source and licenses; Node is needed only when deliberately rebuilding the checked-in chart bundle. The source repository is not a runtime dependency.

## Verification

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
SLURP_TEST_DUCKDB=/path/to/duckdb cargo test --workspace
cargo doc --workspace --no-deps
(cd backend && npm install && npm run typecheck && npm test)
(cd packages/sdk-js && node --test test/*.test.ts)
backend/api/generate.sh --check
SLURP_TEST_DUCKDB=/path/to/duckdb python3 scripts/e2e.py
SLURP_TEST_DUCKDB=/path/to/duckdb python3 scripts/test-setup-terminal.py
```

Native DuckDB tests require `SLURP_TEST_DUCKDB`; they report their omission when unset. The CLI contract test (`backend/test/cli.e2e.test.ts`) runs this binary against the real Worker under `wrangler dev` with local R2 and Durable Objects, and does not contact Cloudflare. Private environment values are excluded from releases and source control.

## Local setup dashboard

`slurp init` writes a private, self-contained project quickstart and opens it in interactive terminals. `--no-open` suppresses the browser; JSON and noninteractive runs never open it. Rerunning init reuses the saved source, database, and SDK key. Browser failures return a warning. Machine setup only opens the browser for account sign-in or the optional public storage guide.

The page includes SDK snippets, sync commands, report instructions, and a bot handoff. New cloud projects receive an SDK key cached in the selected machine credential store. Existing connections use a cached key or offer owners a publishable key during interactive review. Read-only connections get analysis instructions. With an explicit `SLURP_SOURCE_ID`, `SLURP_PUBLISHABLE_KEY` and `SLURP_READ_KEY` (or a `slurp_sk_` `SLURP_TOKEN`) can personalize the page. Human session tokens are never embedded. Ordinary init reruns never create or rotate keys. Keys are masked until revealed; copying the SDK snippet includes the publishable key. Bot keys have a separate copy control.

Personalized HTML is stored under `~/.slurp/setup`, or `SLURP_HOME/setup`, with owner-only permissions. It contains credentials if supplied: keep it private, delete it when no longer needed, and use the CLI to revoke keys. It is an offline snapshot; rerun init to refresh it. There is no local server.

`apps/setup/` uses Svelte 5 + Vite and produces a single HTML file embedded in the Rust binary. Rebuild it with `pnpm install && pnpm --filter slurp-setup check && pnpm --filter slurp-setup build`. SDK snippets in `docs/onboarding/snippets.json` feed the page and generated agent instructions. No frontend tooling is required by installed CLI users. Future interactive reports can use Svelte/Vega in exported HTML without changing the storage architecture.

## Product learning skills

Slurp requires DuckDB 2.x. Setup offers the pinned official 2.0.0 CLI; you can supply your own executable with `slurp init --duckdb /path/to/duckdb`. New DuckDB 2 files require a compatible engine. Existing older files retain their format.

```sh
slurp agent setup --out .agents/skills/slurp --all
slurp sql --file .agents/skills/slurp/queries/coverage.sql
```

The offline bundle includes `slurp`, `slurp-instrument`, `slurp-analyze`, and `slurp-improve`. Each installed skill contains its references and SQL recipes. Reinstalling preserves matching files and refuses local edits; use `--force` to explicitly replace edits. Select an installation path supported by your agent. No credentials are embedded in skills.

Before running activation, retention or frequency recipes, copy the SQL into your project and set its event names, dates, identity unit and observation cutoff. References explain denominators, cohort maturity, experiment design and sourced retention comparisons. Benchmark records retain source populations and dates; they are directional context until definitions match. Human approval precedes production experiments and releases.

Commands return JSON when piped, readable text on a terminal, and accept `--json` or `--output text|json|auto`. SQL renders a table with a row-count/timing footer; long cells may be clipped to fit the terminal, while JSON preserves the full returned values. Query row limits are always reported. Init prints a short connection summary and actionable warnings. A reused session is identified during account verification; file credentials work without Keychain prompts. Keychain is optional.

Send output confirms acceptance and includes an optional `publication` object; the earlier hard-coded `published: false` field is removed. Sync always returns downloaded/imported/duplicate counts, `has_published_archives`, and optional `publication` metadata. The object contains `state`, `observedAt`, `intervalSeconds`, and optional `estimatedAt`; states are idle, pending, publishing, retrying, or blocked. Countdown text uses server timestamps. Missing metadata is represented as null, never an invented countdown.

## Public website and shared design

`apps/site/` is the static Astro public site: home, quickstart (`/docs/`), connections (`/connections/`), and
the self-hosting page with the cost comparison (`/self-host/`). Run `pnpm --filter slurp-site check`
and `pnpm --filter slurp-site build`; `pnpm --filter slurp-site dev` starts a local preview. Static hosting can
serve `apps/site/dist/`. The one-click Cloudflare deploy button points at `deployRepoUrl` in
`apps/site/src/lib/config.mjs` (the public GitHub repository); set it to an empty string to hide the button.

`packages/web-shared/` owns the wordmark, mascot, licensed fonts, and common styles used by
both public pages and the Svelte setup page in `apps/setup/`. Changes to shared design
require rebuilding both projects. The setup build regenerates the HTML embedded
in the CLI; installed users still need no frontend tooling or network connection.
Public builds use placeholder snippets only and never consume personalized setup
context. Setup retains its private snapshot and masked/copyable credential controls.


The Connections catalog distinguishes current CLI/SDK workflows from ideas labeled
Exploring. These entries do not enable connectors or promise release dates.
Shared SVG icon definitions and section tracking live in `packages/web-shared/`; the
public rail uses page navigation plus a section index, while setup uses its five
local sections. On narrow screens the section index becomes a disclosure.

## Project storage and setup

`slurp setup` prepares this computer with a default library and DuckDB 2. Connect it to your Worker first with `slurp connect`, or pass `setup --backend https://your-worker.workers.dev`. Setup ignores the current project's binding and never changes its files. Its first welcome explains the event-to-agent flow; later runs show existing preferences.

Storage choices are external SSD, internal disk (`~/SlurpLibrary`), or a custom library folder. External drives use `<drive>/SlurpLibrary`. Discovery is read-only and shows available space, with Rescan after connecting a drive. The optional offline buying guide includes the US$50–100 tier and larger options with dated USD reference prices; buying a drive is optional. Open it separately with `slurp setup --storage-guide`.

`slurp init` runs in your app's folder. It suggests the folder name as the app name, creates a new cloud project or selects an existing one by name, and proposes `<library>/<folder>/events.duckdb`. Source IDs are handled internally. You can edit the data folder before review. New projects receive a publishable SDK key in the selected machine credential store; existing owners may explicitly create an SDK key when linking. Read-only connections can analyze events without issuing new keys.

```sh
# Normal interactive flow:
slurp setup
cd /path/to/app
slurp init

# Explicit local preparation, without browser login:
slurp setup --library '/Volumes/YourDrive/SlurpLibrary' --duckdb /path/to/duckdb --no-connect

# Scripts: provide credentials through the environment or saved machine credential store.
slurp init --name 'My App' --no-open
slurp init --source src_ID --data-dir ./event-data --duckdb /path/to/duckdb --no-open
```

`--name` creates a project using a friendly title and generated internal alias; `--source` connects an existing ID or service alias. An explicit stable ID supports offline binding and bot read keys without browser login. `--name` and `--source` are mutually exclusive. `init --data-dir` selects an exact data folder; `--database` selects a database file, and the two conflict. Relative paths resolve against `--workspace`; `~/` expands to your home. Explicit engine paths and saved machine preferences take priority over PATH and earlier managed installations.

Machine setup can be rerun to change defaults for future apps. Rerunning init preserves the current project's source and database, even when global defaults change. Missing libraries or databases return `storage_unavailable`; Slurp never silently switches disks or recreates missing storage. Initialization refuses to overwrite databases. Cloud creation has a durable checkpoint: retries after local failure reuse the created source and cached key rather than replaying the backend's key-rotating creation request.

Project init offers skill installation and an exact preview of the optional feedback reminder for existing root `AGENTS.md` / `CLAUDE.md` files. Scripts opt in with `--install-skills` and `--agent-notes`; `--no-install-skills` / `--no-agent-notes` suppress interactive offers. Reminders are added once, preserve text and permissions, and skip links outside the workspace. No instruction files are created.

`--no-open` suppresses browser opening. Use `setup --no-connect` (alias `--no-login`) for local-only preparation. Noninteractive and explicit JSON runs never prompt, open browsers, or install DuckDB. Missing prerequisites return `setup_required` with an actionable message. Explicit init flags can satisfy prerequisites without a machine wizard. `TERM=dumb` uses plain text and numbered menus; `NO_COLOR` suppresses color.

## System settings and project index

`~/.slurp` is the shared home for the CLI and future desktop app. Set `SLURP_HOME` to use another location for all Slurp state and managed executables.

```text
~/.slurp/
  config.toml      # Backend, library, DuckDB, and credential_store preferences
  credentials.json # Private Worker connection and SDK keys (0600; plaintext)
  credentials.lock # Serializes atomic credential updates
  projects.json    # Registered project folders and database locations
  bin/duckdb       # Optional managed engine
  setup/           # Private offline setup pages
  service/         # Cached service metadata
  cache/           # Request and authentication locks
```

Machine setup saves `backend`, `library_dir`, and `duckdb` in `config.toml`, preserving comments and unrelated settings. Init also creates the file when absent. Credential values stay in `credentials.json` by default; `credential_store = "keychain"` explicitly selects native storage. The project index contains paths and source bindings, with no credentials or event data. Events stay in each project's selected storage.

```sh
slurp config                         # Show system settings and their path
slurp projects                       # List registered projects and availability
slurp projects forget /path/to/app    # Remove only the index entry
```

Successful init registers the project by its canonical folder path. Rerun init to register a project created with an older CLI. Listing uses metadata only, so disconnected drives and missing project folders remain listed without recreating storage. Concurrent updates are locked and written atomically; a damaged index produces an error and is preserved. Registration failures are returned as `registry_warning` after successful initialization.

Earlier service preferences remain readable from `~/Library/Application Support/Slurp` on macOS and `~/.local/share/slurp`. Existing managed DuckDB executables in those locations are reused. These files and event databases are not moved; setup pages and new state use the new home. Existing backend-scoped OS credentials can be imported explicitly with `slurp credentials migrate-keychain`. File reads never fall back to the OS store.
