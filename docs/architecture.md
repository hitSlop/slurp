# Architecture

Slurp is a Cloudflare Worker you deploy to your own account, SDKs that send it events, and a CLI that pulls published archives into a local DuckDB file for your coding agent. Nothing runs on a server you manage. The wire formats are written down in [contracts.md](contracts.md); this page explains how the pieces fit.

```
SDK / HTTP ──► Worker (POST /v1/events)
                ├─ check that every line parses and has the right shape (the record is never changed)
                └─ ProjectDO (one per project, SQLite)
                     ├─ group commit ─► chunk rows (at most 6 MiB each), each line wrapped in an envelope:
                     │                  {received_at, sender, geo?, record}
                     └─ alarm, or slurp sync --now ─► publish intent ─► gzip NDJSON archive in R2  +  manifest row (seq, sha256, size)

slurp sync ──► Worker (POST /v1/rpc/ListArchives) ──► GET /v1/projects/<id>/archives/<seq>  (bearer key, served from R2)
              verify size and sha256 ─► import into per-project DuckDB ((sender, id) primary key makes retries safe)
```

## Pieces

- **Worker** (`backend/`): TypeScript, no framework, one route table. It serves `POST /v1/events`, the Segment, Sentry and webhook endpoints that feed the same ingest path, the control API, authenticated archive downloads, `/v1/health` and the setup page.
  - **The control API** is plain JSON: `POST /v1/rpc/<Method>` with a bearer token, 11 methods (`Whoami`, `CreateProject`, `GetProject`, `ListProjects`, `SourceKey`, `CreateKey`, `ListKeys`, `RevokeKey`, `ConnectWebhook`, `ListArchives`, `Publish`).
  - **Its types** are serde structs in `crates/slurp-client/src/api.rs`, exported to `backend/src/api.gen.ts` with ts-rs. A test fails when that file is stale, so the CLI and the Worker cannot disagree.
- **RegistryDO**: one SQLite Durable Object that is only an index of projects (id, unique name, title). It is not consulted when an event arrives.
- **ProjectDO**: one per project. It owns the project's keys and webhook connections (with their secrets), buffers accepted events durably as chunks, publishes them into R2 archives and keeps the manifest.
  - A publishable key names its project and its source (`slurp_pk_<project id>_<source>_<random>`), so a request goes straight to that project's object: no global lookup. A revoked key stops working on the next request, because nothing is cached.
  - Nothing is stored until a project is created, so forged project ids cost nothing.
  - Publishable keys are stored as they are (they are public by design and can be shown again); secret keys are stored only as a SHA-256.
  - A source is just a name inside the key (`web`, `ios`, `cli`, `github`). It exists while it has keys, and the Worker always takes it from the stored key row.
- **R2**: immutable archives `projects/<project>/archives/<20-digit seq>.jsonl.gz`. The CLI never receives R2 credentials; it downloads through your Worker.
- **CLI** (`crates/`): Rust. Downloads and verifies archives, imports into DuckDB idempotently, runs SQL and builds reports. `slurp-client` owns the typed API, transport and archive validation, `slurp-document` sanitizes Markdown, `slurp-render` renders HTML/PNG/PDF.
- **Report rendering**: the embedded Vega compiler measures labels through Takumi with the bundled Geist fonts. PNG renders inline SVG at 2× density; PDF retains vector chart graphics. `vendor/takumi-core` contains the pinned DPR correction and its provenance. Rebuild chart assets with `pnpm --dir report-assets build`; `pnpm --dir report-assets check` verifies source, bundle, versions and themes without writing files.
- **SDKs** (`sdks/js`, `sdks/react-native`): a durable queue, batching, and retries that resend the same events. iOS and macOS use Segment's `analytics-swift` pointed at the Worker; there is no Slurp Swift SDK.

## Contracts

The full rules are in [contracts.md](contracts.md). In short:

- **Three rules.** The Worker validates and stamps; the importer applies defaults. Store facts, derive the rest. Sync never stops on content.
- **Record format:** one JSON object per line (a single object is a valid body), at most 1 MiB, stored whole and never truncated. Only `event` is required (`{"event":"signed_up"}`). `id`, `type` (`track` or `identify`), `timestamp` (RFC 3339), `data` and the rest are optional and type-checked when present; an `identify` needs `user_id`. Any other field is kept as it is.
- **The envelope** is how the Worker adds its own facts without touching the client's: each stored line is `{received_at, sender, geo?, record}` with the record's exact bytes inside. No field name is reserved, so a client cannot clash with server metadata. `sender` is the source of the key that sent it (`web`, `ios`, `github`), so many senders can write into one project and be told apart.
- **Delivery:** `200 {"ok":true,"accepted":N}` means durable. A `400` stores nothing and lists every bad line in `rejected`. `413` means too large (the SDK splits); `429` / `503` come with `Retry-After`; `401` / `403` stop the SDK for this run.
- **Identity and retries:** an event is `(sender, id)`. A record without an `id` is a new event each time it is sent, so anything that may be retried needs one; the SDKs, `slurp send` and the MCP send tools always add one. The import gives a record with no `id` the id `slurp:<archive>:<line>`, and one with no `timestamp` its `received_at`.
- **Archives:** a gapless sequence per project, gzip, with a SHA-256 verified before import. Retention is optional (`RETENTION_DAYS`).
- **Keys:** `slurp_pk_` publishable keys only send events, as one source; `slurp_sk_` secret keys only read one project's archives; the admin token controls the deployment. Downloads are authenticated `GET`s: the same bearer token, admin or that project's secret key. A download URL grants nothing by itself. `backend/test/authorization.test.ts` pins this.

## How the CLI pulls archives

`slurp sync` is a pull, over the same API the Worker serves:

1. `ListArchives` returns the coverage (the first retained sequence, the last published one, and whether accepted events are still waiting) and the next archives with their sequence, size, SHA-256 and event count.
2. The **cursor is the highest archive sequence recorded in `_slurp.deliveries` inside the project's DuckDB file**. There is no separate cursor file, so the cursor and the data can never disagree. A new database starts at the first retained sequence.
3. Each archive is downloaded with `GET /v1/projects/<id>/archives/<seq>` and the saved token to a temporary file, and checked against the listed size and SHA-256 (`slurp_client::download_verified`).
4. The CLI reads the gzip NDJSON in Rust, then imports it in **one DuckDB transaction** together with its receipt, and deletes the file. Missing fields get their defaults here and nowhere else. Re-running a sync, or running it after a crash, repeats at most one archive and changes nothing.
5. **Sync never stops on content.** For each line, the first copy of a `(sender, id)` wins. A copy with the same content is counted as a duplicate; a copy with different content, a line of the wrong shape, or a run of archives that retention deleted before they were read becomes a row in `_slurp.problems` (`conflict`, `invalid`, `gap`). `slurp sync` counts them and `slurp health` reports them.
6. Only integrity failures stop a sync: a download that fails after retries, a size or SHA-256 mismatch, a truncated gzip, a receipt for a different project (the project was reset), or a published sequence that skips a number.

`slurp sync --now` first calls `Publish` (admin token only), so events sent a moment ago are in the archives it imports.

The database is a **rebuildable cache**: the archives in R2 are the source of truth. One DuckDB file per app is deliberate: one file for the agent to query, typed columns, instant queries, and a cursor that lives with the data. Re-reading raw JSONL on every query would cost seconds at a million events and minutes at a hundred million, and DuckLake would add a catalog and a Parquet folder to solve problems (concurrent writers, shared catalogs, time travel) that a single local writer does not have. It becomes interesting for a shared team database.

### Reading archives

`slurp sync` (inside an app) is the one way events reach your computer: download, verify, import into the project's DuckDB file. `slurp read PROJECT` prints the same published envelopes as NDJSON without a database (for pipes and bots); it uses the same verified-download path, so both handle checksums and retention gaps identically.

### Compression

Archives are gzip (`.jsonl.gz`): Workers compress gzip natively, and a stronger codec would need a WASM encoder on the publishing path for a small saving on the R2 bill.

## Durability and cost design

Durable Object SQLite bills rows written and rejects rows over 8 MB, so the Project object:

- group commits concurrent requests into one chunk row and acknowledges only after the commit;
- keeps each chunk at 6 MiB or less, so a row always fits;
- stores a publish intent (the archive's sequence and the last chunk it covers) before it writes to R2, so a crash resumes the same archive under the same sequence, and commits the manifest row, the removal of the published chunks and the end of the intent in one transaction;
- derives its schedule from the stored facts (when the oldest chunk was committed, whether an intent is open, when the next archive expires) and writes the alarm only when that time changes, because each write bills a row.

An acknowledged event is in Durable Object storage until its archive is published into R2. If R2 fails, publishing retries with backoff (`ARCHIVE_RETRY_MS`, doubling up to `SEAL_INTERVAL_MS`) until it works. See [self-hosting](self-hosting.md) for limits and operations.

## Not included

Multi-user accounts, billing, a hosted service, desktop app and server-side query. Reports and analysis run locally.
