# Real-account run (2026-11-06)

Deployed `backend/` as a throwaway Worker (`slurp-spike-<rand>`) and R2 bucket to the Longtail Labs account, ran the e2e suite and the real Rust CLI against the real edge, then deleted everything. Verified afterwards: Worker gone (`/healthz` 404, API code 10007), bucket deleted (which also proves it was empty), zero `slurp*` buckets left, other buckets untouched.

## Bootstrap (S1, partial)
- `wrangler` was already authenticated (OAuth, `workers_scripts` write, R2 usable). `wrangler r2 bucket create <name>` worked non-interactively.
- **One `wrangler deploy`** created the Worker, both SQLite Durable Object classes (migration `new_sqlite_classes`) and the R2/vars bindings. `wrangler secret put ADMIN_TOKEN` (stdin) set the only secret. workers.dev URL was printed; the account already had a workers.dev subdomain.
- Not covered: a brand-new account (signup, card for R2, subdomain registration) and the Free plan. This account is not a fresh Free account, so Free-plan behavior (daily caps, 10 ms Worker CPU, R2 enablement) is still unverified.

## Results
| Check | Result |
|---|---|
| e2e suite on the real edge | 7/7 control-plane, ingest, geo, seal, download and archive tests pass (after making the group-commit test read every archive: the 20 s alarm sealed mid-test). |
| Real alarm | Sealed on its own at the 20 s interval; no alarm left armed when idle. |
| Real CLI loop | `init --name` -> `send` -> alarm seal -> `sync` (downloaded the `.jsonl.gz` through the signed URL) -> `sql`: 3 events imported, wide number `12345678901234567890` exact, `received_seq` present, second sync is a no-op. |
| Geo | Real `request.cf`: `{"basis":"request_ip","city":"Regina","country":"CA","provider":"cloudflare","region":"Saskatchewan"}`. Client-supplied geo headers ignored. |
| Worker CPU (`wrangler tail`) | `/v1/events`: **0 to 1 ms**, including the 1000-event 945 KB batch. |
| Durable Object CPU | 1 to 2 ms for small batches; **20 to 46 ms** for a 1000-event 945 KB batch (scan + geo splice + stamp); alarm seal 7 to 12 ms. DO CPU limit is 30 s by default (docs), not the 10 ms Workers Free limit. |
| Latency | Sequential 20-event batches: p50 659 ms, p95 1132 ms (500 ms group-commit window + network). 1000-event batch: 0.4 to 1.4 s. |
| Concurrency | 60 parallel curls finished in 1.08 s wall (p50 0.92 s). Node `fetch` serialized the same requests to 37 s: client artifact (same as archived S26 note); use curl or a pooled client for load tests. |

## Findings
1. **DO SQLite rejects any string/blob/row over 2 MB** (docs; also enforced by workerd). Group commit could build larger rows (one request can be 10 MiB). Fixed: rows are capped at 1.5 MB and split, `received_seq` stays unique. Regression test fails with 503s without the cap.
2. The CLI sends source names like `app_my_saas`; the Worker now uses the gateway's real alias rules (lowercase letters/digits/underscore, no `__`, reserved prefixes and SQL words rejected, UUID `requestId`).
3. Rows-written cannot be read reliably from the DO counter in production (objects are evicted between requests). Use Cloudflare's analytics for the billed figure; local tests show 0.23 to 0.25 rows/request at 20 events/request with group commit and a constant 12 rows per seal regardless of batch count.
4. Still unmeasured: Free-plan daily cap behavior (must surface as retryable 503, not a 4xx), billed rows and cost on the dashboard, brand-new-account bootstrap.
