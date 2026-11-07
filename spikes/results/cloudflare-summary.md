# Cloudflare self-hosted: spike results (2026-11-06)

**Call: Path W (Durable Object buffer, no Basin).** Decided by the product owner; the spikes below support it and shrink the CLI work.

Code: `spikes/worker/` (Worker + RegistryDO + SourceDO), tests in `spikes/worker/test/`. All results are from local `wrangler dev` (workerd, simulated DO/R2) unless marked **needs real account**.

## Results

| Spike | Result | Evidence |
|---|---|---|
| S6 webrpc server on Workers | **Pass.** `webrpc-gen -target=typescript -server` (v0.49.0) emits web-standard `serveXRpc(service, ctx, Request): Promise<Response \| null>`, one per service. Runs on workerd unchanged; no Hono needed for the control plane. | `src/index.ts` serves Health, Source, Archive. `tsc` clean against the generated `SourceServer`/`ArchiveServer` interfaces. |
| Generated TS client vs Worker | **Pass.** 5/5 tests: auth gates, source/key CRUD, requestId retry rotating only that create's key, name validation, errors map to the right typed errors. | `test/e2e.test.ts` |
| Real Rust CLI vs Worker | **Partial pass.** `slurp source create/setup` and `slurp send --source` work unchanged (static admin token via `SLURP_TOKEN`). `slurp sync` lists and downloads, then fails: `Unknown frame descriptor` (gzip fed to the zstd decoder). | manual run, scratchpad |
| S9 DO sink | **Pass.** 2 SQLite rows written per batch (target was <= 3). Alarm sealed 71 batches / 2,750 events / 2 MB into one 94 KB archive; 50 parallel batches to one source all 200. Dedupe of identical retried batch works. | `test/measure.ts` |
| S8 signed download | **Pass.** HMAC-signed `/v1/objects/<b64 r2key>?exp&sig` streams from R2; sha256 and size match manifest; bad signature 403. | e2e test |
| S4 CPU on Free (10 ms) | **Not measurable locally.** 900 KiB / 1000-event batch took 35 ms wall in workerd (includes JSON.parse of every record). Treat as at risk on Free; check on a real account. | **needs real account** |
| S1 fresh-account bootstrap | **Not run.** Needs a throwaway Cloudflare account. | **needs real account** |

## Findings that change the plan

1. **Keep the existing `Archive` service contract.** Path W's manifest (seq, name `<20-digit seq>-<sha256>.jsonl.gz`, size, sha256, signed URL, coverage, `after` checkpoint, 410 RetentionGap) *is* `Archive.ListObjects`. The Worker serves it as-is, so the CLI's existing sync/verify/checkpoint logic is reused. The bespoke `/v1/sync` framing in the old plan (section 8) is dropped.
2. **No native zstd in workerd** (`CompressionStream` supports only gzip/deflate). Archives are `.jsonl.gz`. CLI change is small (about 0.5 day): `jsonl.zst` is hard-coded in `slurp-client/src/folder.rs` (2 extension checks, 1 decoder), `reader.rs:76`, `archive.rs:14`, and `slurp-cli/src/lib.rs:294,425`. Add one helper that picks zstd or `flate2::GzDecoder` by extension. DuckDB `read_json` already reads `.gz`.
3. **Stamping must be textual.** The Rust side keeps wide integers (`arbitrary_precision`); `JSON.parse`/`stringify` would corrupt e.g. `12345678901234567890`. `src/canonical.ts` prefixes `received_at`/`received_seq` like Go's `stampLines`; verified byte-for-byte. `received_seq` (`batchId<<20|n`) is native in W.
4. **Geo enrichment is open.** Go rewrites `context` via RawMessage. In TS this needs a lossless approach (`lossless-json`, `JSON.parse` source access, or splicing the `context` substring). Not built in the spike.
5. webrpc server requires `Content-Type: application/json` (400 otherwise). Fine for generated clients.
6. Dedupe by body hash only covers unsealed batches; after sealing, a retried batch is deduped by DuckDB `events.id` PK (already the design).

## Still to do before build
- S1 on a real throwaway account (bootstrap, Free vs Paid gates, `wrangler deploy` of DO migration + R2, workers.dev subdomain). Also confirm CPU for a 1000-event batch on Free (S4) and the Free-cap behavior (must be a retryable status).
- Crash/alarm recovery test (kill mid-seal) and retention sweep.
- Port the canonical test vectors from the Go repo into JSON fixtures before leaving that repo (depth 128 rule and duplicate-key handling are not ported yet).
- Close SQL gap: S7 offline test harness is already satisfied (everything above ran offline).

## Update 2026-11-07
All "still to do" items except a brand-new-account bootstrap and Free-plan caps are done: real-account run (`cloudflare-real-account.md`), geo, crash/replay, retention, canonical vectors (`backend/fixtures/canonical/`). Basin was rejected; the spike code was promoted into `backend/`.
