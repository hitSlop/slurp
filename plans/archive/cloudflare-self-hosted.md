> **Historical.** This is the design exploration from before the Worker was built: it compares a Basin-based path with the Worker-only path (the one that shipped) and describes a machine-level spool that was never built. The current design is in [docs/architecture.md](../../docs/architecture.md); measured results are in [spikes/results/](../../spikes/results/).

# Self-hosted Slurp on Cloudflare: plan, Basin vs Worker-only, and spikes

Status: Path W chosen and prototyped in `spikes/worker/` (results: `spikes/results/cloudflare-summary.md`). The Basin material below is kept for reference only. Written 2026-11-06. The status section below says what exists today; the rest is the original plan. Decisions marked **(decided)** came from the product owner; everything else is a recommendation to be confirmed by the spikes in section 9.

## Status (2026-11-07)

Path W is built and running in this repository. Verified: Worker + Durable Objects + R2 on a real Cloudflare account (deployed, tested with the real CLI, then deleted; see `spikes/results/cloudflare-real-account.md`); backend suite 23/23 including the real CLI contract test; SDK conformance 4/4; Rust 63/63; generated clients identical to the old repo's output.

Done: repo scaffold and move (apps/, packages/, backend/, crates/), hosted content removed, MIT license, `backend/` Worker with geo enrichment, group commit, row-size cap, crash-safe sealing, retention and backpressure, gzip archive support in the CLI, `slurp connect`, skills embedded with `include_dir`, `billing`/`usage` commands removed, landing self-host page with Deploy dialog and price comparison, docs and CI rewritten.

Still open: Free-plan behavior and a brand-new-account bootstrap (never run), the Deploy button needs a public repo and `deployRepoUrl`, `slurp cloud init` (wrangler-driven setup) and `cloud doctor`, the PTY terminal-setup test (removed with the hosted fixture, needs a port), a license holder name check in `LICENSE`, and a first commit (nothing is committed yet).

Sections 2 to 12 below are the original proposal; where they mention Basin, the Go backend or `/v1/sync`, the decisions above supersede them.

## 1. Goal

Let a user run the whole Slurp pipeline in their **own Cloudflare account**, set up by the CLI with as few manual steps as possible:

```
SDK (any endpoint) -> Cloudflare Worker -> sink -> R2
Rust CLI -> Worker /v1/sync -> local spool -> split by project -> per-project DuckDB -> SQL / reports
```

- The CLI still ships and keeps its walkthrough (library/SSD choice, DuckDB), then adds "find or help install the Cloudflare CLI (wrangler) and deploy our package to your account".
- SDKs take an arbitrary endpoint so a Slurp-hosted endpoint can coexist later.
- The existing hosted stack (Go ingester, Postgres, B2, WorkOS, Dodo billing) is **not touched** by this work.

## 2. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Cloudflare auth is `wrangler login` OAuth (one browser click; `--device` for headless). No computer-use / browser automation. | decided |
| D2 | **(revised 2026-11-06)** Primary write path is **Path W: SourceDO buffer + alarm-sealed gzip archives in R2**. No Basin. Runs on the Workers Free plan, one declarative `wrangler deploy`. | decided |
| D3 | Basin is out of scope for v1. It can return later as an optional `Sink`. Spikes S2, S3 and S9-as-fallback are cancelled; S9 was run as the primary and passed (see `spikes/results/cloudflare-summary.md`). | decided |
| D4 | v1 backend is a **TypeScript Worker** serving the webrpc-gen TS server (spike S6 passed; Hono only for non-RPC routes like `/v1/events`). Go cannot run on Workers (no first-class Go runtime; TinyGo/WASM is impractical; Containers are Paid). The Go backend is a spec: its validation rules and test vectors are ported, not its code. | decided |
| D5 | **Keep the Rust CLI.** A rewrite (e.g. TypeScript on Bun) buys nothing user-visible and would redo onboarding, drive discovery, DuckDB handling and Takumi report rendering. Revisit after v1. | decided |
| D6 | **No multi-language client generation in v1.** Control-plane calls reuse the existing webRPC wire format, hand-implemented in the Worker and typed from the already-generated TS client. oRPC / OpenAPI pipelines are deferred until a consumer exists. | recommendation (revised from an earlier oRPC proposal) |
| D7 | Reports/charts are unchanged: Markdown source with `sql` / `chart` / `metric` / `table` fences (Vega-Lite), HTML primary output, PNG/PDF derived. | decided |

## 3. What already fits (from code exploration)

- **CLI is backend-agnostic.** `backend=` is configurable (`crates/slurp-client/src/config.rs`, `crates/slurp-cli/src/backend.rs`), documented as self-hostable, with tests. `DEFAULT_BACKEND` is `https://api.slurp.run`.
- **Ingest URL is server-provided per source** (`CreateSourceResponse.ingestUrl`), so snippets and the setup page already work for any host. The JS SDK has no hardcoded host (`endpoint` is required).
- **A project is a source (`src_...`).** One key maps to one source (`backend/gateway.go:105-236`). Self-hosted keeps this: every record carries `source`, and the CLI splits by it.
- **Event contract** to preserve: NDJSON, 32 KiB/record cap, reserved fields (`received_at`, `received_seq`, `ts`, `props`, `context.geo`) rejected from clients, `track` needs `event`, `identify` needs `user_id` (`backend/canonical.go:50-128`). SDK semantics: 200 = accepted, 413 splits the batch, 429/503 honor `Retry-After`, 401/403 stop the client, retries resend identical bytes (`sdks/js/src/index.ts`).
- **Geo enrichment** (`backend/canonical.go:132`, needs a Cloudflare ingress secret) is free inside a Worker via `request.cf.{country,region,city}`.
- **DuckDB import is already idempotent**: `events.id` primary key plus a fingerprint rule and per-archive receipts in `_slurp.deliveries` (`crates/slurp-cli/src/lib.rs`, around lines 99 and 345). Duplicates from retries or overlapping sync windows are therefore safe.
- **Reports are local and backend-independent** (`crates/slurp-cli/src/report.rs`, `slurp-document`, `slurp-render`).

## 4. What must change

1. **No Postgres.** Production discovery is a Postgres manifest (`manifest_streams`, `manifest_objects`; "readers never LIST S3"). A Worker needs its own registry (sources, key hashes) and its own listing/cursor. Registry = SQLite Durable Object.
2. **No sequence or sha256 under Basin.** Basin writes UUID-named files; the production archive format (`<20-digit seq>-<sha256>.jsonl.zst`) does not exist. Under Basin the cursor is time-based over listed files; integrity relies on TLS and R2 etags; correctness relies on DuckDB dedupe.
3. **Auth.** Replace WorkOS device login and `source_memberships` with a per-deployment admin secret plus per-source keys (`slurp_pk_` write, `slurp_sk_` read). The backend already has a static-token verifier precedent (`-verifier static`, `backend/auth.go`).
4. **Billing disappears** from self-hosted: no 402, no `Billing`/`Usage` services, no `offer.json`.
5. **CLI reads through the Worker, not R2.** No R2 S3 keys are ever created for the CLI.
6. **Compression.** Basin JSON sinks can gzip; Workers have native gzip, not zstd. The CLI's `folder.rs` currently enforces `.jsonl.zst` (lines ~192, ~341) although `parse_key` already accepts `.jsonl.gz`. Needs a small change.
7. **`received_seq`.** The `events` table has it (stamped monotonically by the Go publisher). Basin cannot supply it. Derive it or make it nullable (spike S3).

## 5. Facts about Basin (Cloudflare docs, fetched 2026-11-06)

Sources: developers.cloudflare.com/changelog/post/2026-10-01-basin-ga/, /basin-pipelines/ (overview, getting-started, streams, sinks, platform/limits), /pipelines/platform/pricing, /changelog/post/2026-05-11-pipelines-pricing-announced/.

- "Basin" is the renamed Cloudflare Data Platform, GA 2026-10-01: **Basin Pipelines** (ex-Pipelines), **Basin Catalog** (ex-R2 Data Catalog, Iceberg), **Basin SQL** (ex-R2 SQL). Existing resource names keep working and are "deprecated over time".
- **Plan:** the overview and pricing pages say Basin Pipelines is *Workers Paid only*. A May 2026 changelog entry mentions 1 GB/month on Workers Free; this conflicts with the pricing page and is treated as unconfirmed (spike S2 tests it).
- **Ingest:** HTTP endpoint (`https://<stream-id>.ingest.cloudflare.com`, JSON array, optional Bearer token with the "Basin Pipelines Send" scope) or **Worker binding** `env.STREAM.send(records)` (no credentials; promise resolves when records are confirmed ingested). CORS behaviour is undocumented, and a Cloudflare token cannot go in a browser, so a Worker must sit in front anyway.
- **Limits:** 20 streams, 20 sinks, 20 pipelines per account; 5 MB per ingest request; 1 GB/s per stream.
- **R2 sink (raw files):** JSON (uncompressed or gzip) or Parquet (zstd default; snappy/gzip/lz4/none); base `--path`; **partitioning is strftime-only** (default `year=%Y/month=%m/day=%d`, Hive style); **file names are UUIDs**; roll interval default 300 s, minimum 10 s, no stated maximum; `--roll-size` MB (no documented bounds); exactly-once delivery to R2. Credentials are an R2 API token with Object Read & Write, passed as `--access-key-id` / `--secret-access-key`. The dashboard flow has an "automatic token creation" toggle; whether the wrangler flow can do the same is unknown (S2).
- **Setup commands:** `npx wrangler basin pipelines setup [--name N]` (interactive: schema file, sink type, auth on/off), `wrangler basin catalog enable`, `wrangler basin sql query`. The getting-started page says creating the catalog API token is **dashboard-only**. The generic `wrangler pipelines setup` form also appears in older docs.
- **Schemas:** structured (validated; non-matching events are accepted then dropped at sink delivery) or unstructured JSON.
- **Pricing:** ingress free. After 50 GB/month included: SQL transforms $0.04/GB; JSON sink $0.03/GB; Parquet/Iceberg sink $0.06/GB. Billed on **uncompressed** bytes. Standard R2 storage and operation charges apply separately. **Billing is not enabled yet** (Cloudflare promises at least 30 days notice).

## 6. The two write paths

### Path B: Basin (primary)

```
SDK -> Worker (auth slurp_pk_, validate, stamp source/received_at/geo)
        -> env.STREAM.send(records) -> Basin stream -> sink -> R2  year=/month=/day=/<uuid>.json.gz
RegistryDO (SQLite): sources, key hashes, admin key
```

Basin does the buffering and batching, so the Worker has no queue, sealing, retention or crash-recovery code.

### Path W: Worker-only (fallback; Free-plan capable)

```
SDK -> Worker -> SourceDO[source] (validate, stamp, dedupe by body hash, buffer in SQLite, ack after durable write)
                   -> alarm every ~10 min or >= 8 MB: gzip NDJSON -> R2 v1/sources/<src>/archives/<id>/events/<seq>-<sha>.jsonl.gz
RegistryDO + per-source manifest rows (seq, key, size, sha256, events)
```

Gives sequence numbers, sha256 and a manifest like production, runs on the Free plan, and is fully declarative to deploy (Durable Object migrations in `wrangler.jsonc`), at the price of ~5-7 more days of code (batch rows, alarm sealing, retention sweep, crash recovery).

An in-between "one R2 object per batch, no buffer" variant is **dismissed**: Class A operations make it about $19/month at 100M events and about $210 at 1B.

### Side-by-side

| Dimension | Basin (B) | Worker-only DO (W) |
|---|---|---|
| Plan required | Workers Paid ($5/mo floor) | Free works to ~75M events/mo (25/batch) |
| Who batches/buffers | Cloudflare | Our code (SourceDO) |
| Added build effort (beyond shared base) | ~4-6 d | ~5-7 d |
| Provisioning | stream + pipeline + sink + sink credentials; credentials may need a dashboard step (G1) | one declarative `wrangler deploy` |
| Output format | Hive-partitioned JSON/Parquet, UUID names, mixed sources | our own `<seq>-<sha>.jsonl.gz`, per-source prefixes |
| Cursor | time-based over R2 `list`/`uploaded` with overlap | archive sequence (existing model) |
| Integrity | TLS + etag; DuckDB dedupe | sha256 per archive + gapless seq |
| `received_seq` | not available | native |
| Freshness | one sink roll interval (5 min default; tunable, min 10 s) | one seal interval (~10 min, tunable) + optional live tail |
| Cost at 1B events/mo | ~$89 (billing off today: ~$22); Parquet ~$117 | ~$60-100 (DO row writes dominate) |
| Vendor risk | new GA product, recent renames, billing not live, 20-stream cap | uses long-stable primitives (Workers, DO, R2) |
| Future options | Iceberg / Basin SQL / Parquet | live tail, per-project read keys without filtering |

**Recommendation:** go Basin-first behind a `Sink` interface, but treat gate G1 as binding: if Basin cannot be provisioned from the CLI with at most one acceptable manual step, build W instead and keep Basin as an optional sink later.

## 7. Cost model (user's Cloudflare bill)

Assumptions (all rough; spike S5 replaces them with measurements): raw event 1 KB, batch of 25 events, about 150 B/event compressed, 90-day R2 retention, 30-day month.

Unit prices used (Cloudflare docs, 2026-11-06): R2 storage $0.015/GB-mo, Class A $4.50/M, Class B $0.36/M, free 10 GB / 1M Class A / 10M Class B, egress free. Workers Paid $5/mo including 10M requests and 30M CPU-ms; then $0.30/M requests and $0.02/M CPU-ms. Workers Free 100k requests/day, 10 ms CPU. Durable Objects (SQLite): Free 100k requests/day and 100k rows written/day; Paid 1M requests included then $0.15/M, 50M rows written included then $1/M. Basin: see section 5.

| Events/month (per day) | Batches/mo | **Basin (B)** | **Worker-only DO (W)** |
|---|---|---|---|
| 100k (3k) | 4k | $5 | $0 |
| 1M (33k) | 40k | $5 | $0 |
| 10M (333k) | 400k | $5 | $0 |
| 100M (3.3M) | 4M | ~$9 ($5 + transform $2 + JSON sink $1.5 + storage ~$0.5); Parquet ~$10.5 | ~$6 ($5 Paid + DO requests $0.45 + storage $0.5) |
| 1B (33M) | 40M | ~$89 once Cloudflare bills Pipelines (~$22 today); Parquet ~$117 | ~$60-100 (Workers $11 + DO requests $6 + storage $7 + DO row writes $30-70) |

Notes:
- B at 100M: 100 GB uncompressed -> transform (100-50) x $0.04 = $2; sink JSON (100-50) x $0.03 = $1.50.
- B at 1B: 1,000 GB -> transform 950 x $0.04 = $38; sink 950 x $0.03 = $28.50; Workers requests 40M -> $9 plus CPU ~$1.8; storage 450 GB -> ~$6.6.
- W stays $0 until about 3M batches/month (100k Worker requests/day and 100k DO requests/day) which is about 75M events at 25 per batch (about 300M at 100 per batch). R2's free 10 GB covers about 66M events stored (about 22M events/month at 90-day retention); beyond that storage is cents.
- Sensitivity: with 100 events/batch (server-side SDKs) W at 1B drops to about $13.
- B has **no Free-plan option**. Hitting the Workers Free daily cap on W pauses ingestion; the SDK persists and retries, so it is a delay, not data loss, but `slurp cloud doctor` should warn and suggest the $5 upgrade.
- Basin roll cadence barely matters for cost: one sink means file count does not grow with projects, and even 60 s rolls are about 43k PUTs/month, inside R2's free 1M Class A.

## 8. Architecture details (both paths)

### `POST /v1/events` (Worker)
Bearer `slurp_pk_...` (query `?key=` allowed only for publishable keys, for browser page-hide). Resolve key -> source (RegistryDO; short cache). Parse NDJSON, enforce the canonical rules above, stamp `source`, `received_at`, `context.geo`. Acknowledge **only after** `STREAM.send()` resolves (B) or the SourceDO write commits (W). Preserve 413 / 429+`Retry-After` / 401 / 403 semantics. CORS and per-key Origin allowlist (Phase 4).

### `POST /v1/sync` (Worker, read key)
Request `{cursor, maxBytes}`. The CLI never receives R2 credentials; the Worker reads R2 through its binding and streams frames (a JSON header line, then exactly `bytes` raw bytes):

- B: `{"t":"file","key","uploaded","bytes","etag"}` + the raw gzip file (no decompression, so near-zero CPU), then `{"t":"end","cursor","hasMore"}`. The Worker lists day partitions from the cursor's day and keeps objects whose `uploaded` is after `cursor - overlap` (overlap >= 2x the roll interval, because UUID names do not sort by time).
- W: `{"t":"archive","seq","name","bytes","sha256","events"}` frames in sequence order, optional `{"t":"tail",...}` frame for unsealed events (`slurp sync --live`), then `end`.

The cursor advances only on `end` (or on each fully verified archive under W). A truncated stream is safe to resume. Errors: 401/403, 410 retention gap (W), 429 `Retry-After`. In v1 the read key is account-level (single owner). Project-scoped bot keys need server-side line filtering (affordable on Paid CPU) and are Phase 4.

### CLI "pull once, split by project"
`slurp sync` (machine-level) downloads new files once into a per-backend spool (e.g. `~/SlurpLibrary/_spool/<backend>/`). For each project in `~/.slurp/projects.json` it imports rows `WHERE source = <project source>` into that project's DuckDB using the existing import and `_slurp.deliveries` receipts, with a per-project checkpoint. Overlap and retries collapse via the `id` primary key. Unknown sources are ignored. Each file is downloaded once no matter how many projects exist.

### Freshness
Basin does not stream to the CLI. It writes a new R2 file whenever the roll interval or roll size is hit; `slurp sync` is a pull-on-demand of whatever exists past its cursor. Visible latency is about one roll interval (default 5 min). Under W it is one seal interval, or seconds with `--live`.

### Registry (both paths)
One SQLite Durable Object holding sources (`src_...`), key hashes (SHA-256) with scope (`write` / `read`) and names, and the admin key hash. Admin calls are authenticated with the admin secret generated at deploy time and stored in the user's machine credential store (existing keychain/file support).

### Control plane
`POST /rpc/<Service>/<Method>` JSON, i.e. the existing webRPC wire format, implemented by hand in Hono with zod validation for the subset self-hosted needs (create/list/get source, create/revoke key, health). Handler types are imported from `backend/clients/typescript/slurp.gen.ts` so ridl changes fail `tsc`. The Rust CLI keeps its generated client (`crates/slurp-client/src/slurp.gen.rs`) for these calls. Other languages later via `webrpc/gen-openapi`. `GET /v1/health` returns `apiVersion`, Worker version and capabilities (`sync`, `sink: basin|do`).

### SDKs
Ingest SDKs (web, Node, React Native, Swift, Python...) are hand-written per platform because batching, persistence, byte-identical retry and beacons are platform behavior. They share a language-neutral **conformance suite** (`sdks/conformance/`): JSON scenarios (request bytes + server responses 200/413/429+Retry-After/401/402 -> expected client behavior) plus a mock server, first wired into `sdks/js`. The JS SDK should accept either a base URL or a full `/v1/events` URL.

### Reports and charts (D7)
Markdown is the source of truth (agent-authored, diffable, sanitized); `slurp report build` produces HTML (primary, self-contained, interactive) and derives PNG/PDF (Takumi). Unchanged. Backlog: `slurp report publish` uploads the HTML to the user's R2 behind a link served by their Worker.

## 9. Spikes

All spikes run on a **throwaway Cloudflare account** (use a fresh email, so the new-account path is real), results recorded in `plans/spike-results/cloudflare-*.md`. Total ~4-5 days. S1 and S2 can start in parallel; S2's gate decides which sink to build.

### S1: Fresh-account bootstrap (0.5-1 d)
**Question:** how much of "account -> deployed Worker" can the CLI do without the dashboard?
**Steps:** sign up; `wrangler login` and `wrangler login --device`; `wrangler whoami --json`; try `wrangler r2 bucket create` on a Free account with no card; upgrade to Workers Paid and observe how to detect it (API/`wrangler`); register a workers.dev subdomain (wrangler prompt vs API); non-interactive `wrangler deploy` with an R2 binding and Durable Object migration; `wrangler secret put`.
**Pass:** a documented, scriptable sequence with exact error messages for each gated step (R2 enablement/card, Paid upgrade, subdomain), and a polling method for each so the CLI can deep-link and wait.
**Output:** the "Dashboard needed?" table in the final doc, filled with verified facts.

### S2: Basin provisioning from the CLI; **Gate G1** (1-1.5 d)
**Question:** can we create stream + pipeline + R2 sink (including its credentials) without the dashboard?
**Steps:** on a Paid account run `wrangler basin pipelines setup` non-interactively (flags / config); try the separate stream/sink/pipeline commands; check whether an OAuth-logged-in wrangler can create the sink R2 credentials ("automatic token creation"); try creating them via the API with the OAuth token; test a structured schema with JSON-typed `data` / `context` (else stringified); test `STREAM.send()` ack semantics, error codes and the dropped-event path; confirm whether Workers Free has any Basin allowance (the changelog hint).
**Gate G1 passes if:** full provisioning needs no dashboard, or exactly one manual token step the product owner accepts. **Otherwise** build path W (Basin stays an optional later sink).
**Output:** exact command sequence, required token scopes, schema decision (typed vs unstructured).

### S3: Basin output layout, latency and cursor (1 d)
**Question:** does the time-based cursor design hold?
**Steps:** with S2's pipeline, send batches from a Worker at several rates; record file names, sizes, sizes vs roll interval/size, visibility latency at 10 s / 60 s / 300 s / hourly rolls; confirm idle intervals create **no empty files**; confirm whether an hourly (or longer) roll is accepted; inspect R2 `list()` ordering, `uploaded` vs file-visible time, objects appearing out of order; measure listing cost and the overlap needed for no misses; check `received_seq` usage in the CLI and pick derive-vs-nullable; confirm gzip JSON output and its line format is what the DuckDB `read_json` import needs.
**Pass:** a cursor + overlap rule that never misses a file in a 1-hour soak with concurrent writers, and a recommended default roll interval.

### S4: Worker CPU and limits for ingest (0.5 d)
**Steps:** validate + stamp a 900 KiB / 1000-event NDJSON batch (the SDK max) in a Worker, measure CPU on Free (10 ms) and Paid; test the 32 KiB record and 128-depth rules from `backend/canonical.go`; test `request.cf` geo availability.
**Pass:** a batch fits the CPU budget, or the validation split (Worker light check, deeper check elsewhere) is identified. Matters for path W on Free.

### S5: Real event-size distribution (0.5 d)
**Steps:** measure p50/p90/p99 event bytes and compressed bytes/event from `examples/`, `demos/`, the dogfood buffer and SDK test fixtures (the archived `spikes.md` S5 already planned this); measure real batch sizes per SDK type.
**Output:** replace the cost-model assumptions in section 7 and re-run the table.

### S6: Control-plane contract on Workers (0.5 d)
**Steps:** hand-write Hono handlers for the self-hosted subset of `slurp.ridl` (`Source`, keys, health) typed from `slurp.gen.ts`; run the existing generated **Rust** client and TS client against them on `wrangler dev`; identify `Source` fields that can be trimmed; optionally test whether webRPC's TS `-server` output runs on Workers (it targets Node; may need `nodejs_compat`); sanity-check `webrpc/gen-openapi` output for later.
**Pass:** CLI `source create/list/show` and `source key create/revoke` work unchanged against the Worker.

### S7: Local test strategy (0.5 d)
**Question:** how do we test without a real account in CI?
**Steps:** check which bindings run under `wrangler dev` / `@cloudflare/vitest-pool-workers` (R2, Durable Objects yes; Pipelines/Basin binding probably not); build a fake stream binding that writes Hive-partitioned gzip JSON files into local R2 with a configurable roll; confirm the same Worker bundle runs against it.
**Pass:** the CLI contract test (section 10, item 2) runs offline.

### S8: `/v1/sync` streaming (0.5 d)
**Steps:** pass through 16 MiB across many small R2 bodies in one response on Free and Paid; measure CPU/wall time; test truncation and resume, `maxBytes`, `hasMore`; test a slow client.
**Pass:** frames stream within limits with negligible CPU; truncated streams resume with no data loss or duplication beyond what DuckDB dedupes.

### S9 (only if G1 fails): Durable Object sink prototype (1-1.5 d)
**Steps:** SourceDO with per-batch SQLite rows, alarm-driven gzip sealing to R2, manifest rows, retention sweep; measure rows written per batch (inserts and deletes), behaviour and status codes when the Free daily cap is hit (the SDK must see a retryable response, not a 4xx that stops it), crash/alarm recovery.
**Pass:** one batch costs <= 3 rows written; a forced crash loses no acknowledged batch; cap behaviour is retryable.

### Spike exit
After S1-S8 (and S9 if needed) write `plans/spike-results/cloudflare-summary.md`: the chosen sink, the verified dashboard-needed table, the updated cost table, the cursor/overlap rule, and a go / no-go for the build phases below.

## 10. Build phases (after spikes)

**Phase 1: Worker (`cloudflare/worker/`)**: `index.ts` router; `ingest.ts`; `canonical.ts` (port of `backend/canonical.go:50-128` and `stamp.go`); `sink/` (`Sink` interface; `basin.ts`; `do.ts` only if G1 fails); `registry-do.ts`; `sync.ts`; `rpc.ts` (webRPC-wire Hono handlers); `wrangler.jsonc` template. Export Go canonical test vectors (`backend/canonical_test.go`) to `cloudflare/worker/fixtures/canonical/*.json` consumed by both Go and TS tests so the validators cannot drift.

**Phase 2: CLI `slurp cloud` (Rust)**: new `crates/slurp-cli/src/cloud.rs` with `init | status | upgrade | doctor | destroy`. `init`: find or offer wrangler (pinned version), `wrangler login`, account pick, Paid-plan check/deep-link/poll, bucket, Basin provisioning (per S2), embed the built Worker bundle (`crates/slurp-cli/assets/worker/`, `include_bytes!`), `wrangler deploy`, secrets, health check, save backend profile and admin key. Also: `onboarding.rs` new step "Slurp Cloud / Your Cloudflare" beside library/SSD; `backend.rs`, `service.rs` static admin token instead of WorkOS and hide billing/usage when self-hosted; `crates/slurp-client/src/remote.rs` new `sync` remote (frame reader, spool, cursor); `crates/slurp-cli/src/lib.rs` source filter + fan-out; `folder.rs` accept `.jsonl.gz`.

**Phase 3: SDKs, tests, docs**: contract tests against the generated clients; conformance suite; `sdks/js/src/index.ts` endpoint normalization; `docs/self-hosted-cloudflare.md`; updates to `docs/README.md`, `architecture.md`, `cli.md`, `docs/agent-skill/slurp/SKILL.md`, `docs/onboarding/snippets.json`, landing docs/pricing.

**Phase 4: Hardening**: project-scoped read keys with server-side filtering, Origin allowlists, per-key rate limits, R2 lifecycle retention, `cloud upgrade` with version-compat check, `destroy` with confirmation, Parquet option.

**Phase 5 (backlog)**: Swift / React Native / Python ingest SDKs on the conformance suite; `slurp report publish`; DO sink if not already built; evaluate the Worker as the hosted backend (multi-tenant) to retire Go/Postgres/B2.

Estimated build effort (one developer, rough): shared base 12-15 d; Basin sink +4-6 d; DO fallback +5-7 d.

## 11. Verification (for the build)

1. Worker unit tests (`vitest` + `@cloudflare/vitest-pool-workers`) with a fake stream binding: shared canonical fixtures, auth/scope matrix, geo, sync cursor/overlap/truncation.
2. Contract test: local Worker + the real Rust CLI (`init`, `send`, `sync`) + the JS SDK against the fake sink; assert rows land in the correct project DuckDB files and duplicates collapse.
3. Real-account E2E on a throwaway account: `slurp cloud init` from zero, send events, wait one roll interval, `slurp sync`, query, build an HTML/PNG/PDF report; then `cloud upgrade` and `destroy`.
4. Conformance suite passes for `sdks/js`; the generated TS and Rust webRPC clients pass contract tests against the Worker.
5. Compare the cost table with the real Cloudflare bill after the E2E.

## 12. Risks and open questions

- **Basin is new:** recent rename, billing not live (30-day notice promised), docs gaps (sink file bounds, CORS, HTTP auth details). Mitigation: `Sink` interface and the W fallback.
- **Dashboard-only steps** (account signup, Workers Paid upgrade, possibly R2 enablement, possibly the sink token) cannot be removed; the CLI can only deep-link and poll. Computer use is explicitly out of scope (D1).
- **Free-plan abuse/cost:** a public ingest endpoint on the user's account can burn their daily cap or bill; add rate limits and an Origin allowlist (Phase 4).
- **Data model:** `received_seq` handling, mixed-source files (every project's CLI skims all files; fine for one owner, revisit with multi-user).
- **Business model** for self-hosted (free CLI feature vs paid tier) is undecided.
- **Retention default** in the user's R2 (90 days like hosted, or keep forever since it is their bucket).
- **Branching:** work starts on a new branch (e.g. `feat/cloudflare-selfhost`) after `refactor/backend-migrations-sqlc` lands; the worktree currently has many uncommitted changes.
