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
- **Delivery:** `200` accepted durably; `413` too large (SDK splits); `429` / `503` with `Retry-After`; `401` / `403` stop the client. Retrying identical bytes is safe (`Slurp-Duplicate: 1`, plus `events.id` dedupe locally).
- **Archives:** gapless sequence per source, gzip, with a SHA-256 verified before import. Retention is optional (`RETENTION_DAYS`); a stale checkpoint gets `410 RetentionGap`.
- **Keys:** `slurp_pk_` publishable keys only send events; `slurp_sk_` secret keys only read one source's archives; the admin token controls the deployment.

## Durability and cost design

Durable Object SQLite bills rows written and rejects rows over 2 MB, so the Source object:

- group commits concurrent requests into one row and acknowledges only after the commit;
- splits rows at 1.5 MB;
- rotates to a new generation table on seal, archives the frozen one, then `DROP TABLE`s it (a `DELETE` would bill per row);
- persists the seal intent before the R2 put, so a crash replays identical bytes under the same sequence.

An acknowledged event is in Durable Object storage until its archive is sealed into R2. See [self-hosting](self-hosting.md) for limits and operations.

## Not included

Multi-user accounts, billing, a hosted service, desktop app and server-side query. Reports and analysis run locally.
