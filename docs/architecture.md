# Architecture

Slurp is a Cloudflare Worker you deploy to your own account, SDKs that send it events, and a CLI that pulls sealed archives into a local DuckDB file for your coding agent. Nothing runs on a server you manage.

```
SDK / HTTP ──► Worker (POST /v1/events)
                ├─ validate, stamp received_at / received_seq, add geo from request.cf
                └─ SourceDO (one per source, SQLite)
                     ├─ group commit ─► batch rows (generation tables)
                     └─ alarm ─► seal ─► gzip NDJSON archive in R2  +  manifest row (seq, sha256, size)

slurp sync ──► Worker (webrpc Archive.ListObjects) ──► signed GET links ──► R2
              verify sha256 ─► import into per-project DuckDB (events.id primary key makes retries safe)
```

## Pieces

- **Worker** (`backend/`): TypeScript, no framework. Serves the webrpc `Health`, `Source` and `Archive` services (generated from `backend/api/slurp.ridl`), plus `/v1/events`, `/v1/objects` (signed downloads) and `/v1/health`. `Auth` answers only `CurrentUser` for the admin token; `Usage` and `Billing` are stubs.
- **RegistryDO**: one SQLite Durable Object that holds sources, hashed API keys and `requestId` idempotency records.
- **SourceDO**: one per source. Buffers accepted batches durably, seals them into R2 archives on an alarm and keeps the manifest.
- **R2**: immutable archives `v1/sources/<source>/archives/<archive id>/events/<20-digit seq>-<sha256>.jsonl.gz`. The CLI never receives R2 credentials.
- **CLI** (`crates/`): Rust. Downloads and verifies archives, imports into DuckDB idempotently, runs SQL and builds reports. `slurp-client` owns transport and archive validation, `slurp-document` sanitizes Markdown, `slurp-render` renders HTML/PNG/PDF.
- **SDKs** (`packages/sdk-js`): durable queue, byte-identical retries, batching.

## Contracts

- **Event format:** newline-delimited JSON, at most 32 KiB per record. Required: `id`, `type` (`track` or `identify`), `timestamp` (RFC 3339), `data` (object); `track` needs `event`, `identify` needs `user_id`. Server-owned fields (`received_at`, `received_seq`, `context.geo`) are rejected from clients. Records are validated and stamped *textually*: client bytes, including arbitrary JSON numbers, are never re-serialized. The test vectors are in `backend/fixtures/canonical/`.
- **Delivery:** `200` accepted durably; `413` too large (SDK splits); `429` / `503` with `Retry-After`; `401` / `403` stop the client. Retrying identical bytes is safe: a retry that arrives while the original is still being committed waits for that commit (it is never acknowledged before the events are durable), later retries answer `Slurp-Duplicate: 1`, and `events.id` dedupes locally.
- **Archives:** gapless sequence per source, gzip, with a SHA-256 verified before import. Retention is optional (`RETENTION_DAYS`); a stale checkpoint gets `410 RetentionGap`.
- **Keys:** `slurp_pk_` publishable keys only send events; `slurp_sk_` secret keys only read one source's archives; the admin token controls the deployment.

## How the CLI pulls archives

`slurp sync` is a pull, over the same webrpc API the Worker serves:

1. `Archive.GetCoverage` returns the archive ID, the first retained sequence and the latest published sequence.
2. The **cursor is the highest archive sequence recorded in `_slurp.deliveries` inside the project's DuckDB file**. There is no separate cursor file, so the cursor and the data can never disagree. A new database starts at the first retained sequence.
3. `Archive.ListObjects(after, limit)` returns the next manifest rows, each with its sequence, name, size, SHA-256 and a signed download link (valid for an hour, served by the Worker from R2).
4. Each archive is downloaded to a temporary file, checked against the listed size and SHA-256 (`slurp_client::download_verified`, which also asks for a fresh link if the old one expires mid-sync), imported in **one DuckDB transaction** together with its receipt, and deleted. Re-running a sync, or running it after a crash, repeats at most one archive and changes nothing.
5. Safety checks: a different archive ID than the receipts means the source was reset; a cursor below the first retained sequence is `410 RetentionGap`; a skipped sequence is a publication gap. Sequences are gapless integers.

The database is a **rebuildable cache**: the sealed archives in R2 are the source of truth. One DuckDB file per app is deliberate: one file for the agent to query, typed columns, instant queries, and a cursor that lives with the data. Re-reading raw JSONL on every query would cost seconds at a million events and minutes at a hundred million, and DuckLake would add a catalog and a Parquet folder to solve problems (concurrent writers, shared catalogs, time travel) that a single local writer does not have. It becomes interesting for a shared team database.

### Two ways to read archives

| | Project sync (`slurp sync` inside an app) | Portable folder (`slurp sync SOURCE --out DIR`, for bots) |
|---|---|---|
| Output | One DuckDB file per app | A folder of the sealed archives plus `source.json` |
| Archives on disk | No: temporary files, deleted after import | Yes: kept, verified again on every run |
| Cursor | `_slurp.deliveries` in the database | The folder's manifest |
| Add `--import` | not needed | Imports the downloaded folder into DuckDB |

Both download through the same verified-download path, so they handle expired links, checksums and retention gaps identically.

### Compression

Archives are gzip because Workers can compress gzip natively and the CLI reads gzip and zstd by magic bytes. zstd at a Worker-friendly level saves only a few percent on event data; the large savings (17 to 28% in our measurements) need slow levels or brotli, which would need a WASM encoder on the sealing path for a small saving on the R2 bill. If it is ever worth it, compact old archives off the hot path into larger zstd objects; clients already read them.

## Durability and cost design

Durable Object SQLite bills rows written and rejects rows over 2 MB, so the Source object:

- group commits concurrent requests into one row and acknowledges only after the commit;
- splits rows at 1.5 MB;
- rotates to a new generation table on seal, archives the frozen one, then `DROP TABLE`s it (a `DELETE` would bill per row);
- persists the seal intent before the R2 put, so a crash replays identical bytes under the same sequence.

An acknowledged event is in Durable Object storage until its archive is sealed into R2. See [self-hosting](self-hosting.md) for limits and operations.

## Not included

Multi-user accounts, billing, a hosted service, desktop app and server-side query. Reports and analysis run locally.
