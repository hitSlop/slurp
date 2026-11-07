# Load and cost calibration (2026-11-06)

A throwaway Worker and R2 bucket (`slurp-cost-<rand>`, seal interval 60 s) on the Longtail Labs account, deployed with `slurp cloud init` and removed with `slurp cloud destroy` afterwards (verified: Worker 404, bucket gone, saved connection removed). Load came from `backend/scripts/load.mjs` on a laptop: open loop, one source, 10 KB-ish JSON events (about 560 bytes each, random ids and values), over a home connection. About 40,000 requests and 1.3 million events in total.

## Throughput of one source

| Events per request | Target req/s | Events/s sent | Accepted | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 20 | 100 | 2,000 | 100% | 479 ms | 1.2 s | 1.7 s |
| 20 | 200 | 4,000 | 100% | 498 ms | 1.2 s | 2.2 s |
| 20 | 400 | 8,000 | 100% (339 ok/s) | 1.1 s | 3.0 s | 4.0 s |
| 20 | 800 | client-bound (432 req/s sent) | 100% | 5.1 s | 6.8 s | 8.3 s |
| 100 | 50 | 5,000 | 100% | 715 ms | 1.4 s | 2.1 s |
| 100 | 100 | 10,000 | 82% (355 x 503, 7 resets) | 3.9 s | 10 s | 15 s |
| 100 | 150 | 15,000 | 87% (381 x 503) | 14 s | 23 s | 27 s |

- The limit is **events per second**, not requests: about **5,000 to 7,000 events/s per source**. With 20-event requests the source held 100% success to about 340 requests/s (6,800 events/s); with 100-event requests it saturated near 50 requests/s (5,000 events/s). Per-event work in the Durable Object (scan, geo splice, stamp) is about 0.15 ms.
- Latency has a 0.5 s floor from the group-commit window; it is flat to about 4,000 events/s and then rises as requests queue. Past saturation the Worker sheds load with retryable `503` (and a few connection resets). The script compares archive bytes, not event counts, so "no accepted event lost" is not re-verified here; the earlier real-account run and `durability.test.ts` cover that.
- The 800 req/s step is limited by the load generator, not the Worker; treat it as "at least this much, unmeasured".
- This replaces the earlier "about 800 to 1,000 requests/s" estimate, which was extrapolated from 60 parallel requests.

## Per-request cost drivers

From `wrangler tail` during a 40 req/s run (sampled, 209 ingest requests):

| | CPU p50 | p95 | max |
|---|---|---|---|
| Worker `/v1/events` | 0 ms | 1 ms | 2 ms |
| Durable Object group commit | 0 ms | 2 ms | 5 ms |
| Durable Object alarm (seal) | 6 ms | | |

The model's `cpuMsPerRequest: 1` stands. Durable Object CPU is not a separate bill line, so it does not enter the price.

## Archive size

| Run | Events accepted | Archive bytes | Bytes per event |
|---|---|---|---|
| 20 per request | 679,300 | 58.7 MB (69 objects) | 86.5 |
| 100 per request | 523,300 | 44.8 MB (35 objects) | 85.6 |

Gzip makes the synthetic events about 6.5 times smaller. They are more repetitive than real events (fixed field names, a handful of values), so this is a lower bound; the model keeps 320 bytes per event as its central value and 200 to 1,000 for the range. Check yours: `slurp sync`, then divide the size of `.../archives` by the event count.

## Not measured

- **Billed usage.** Cloudflare's analytics API needs an API token with Account Analytics read; the wrangler login does not have it and none was provided. Rows written per request (model: 0.25) and Durable Object duration are therefore still the model's figures. To check after a run, open the Worker's and Durable Object's Metrics in the dashboard: rows written, GB-s duration, requests, and R2 Class A operations.
- A month of sustained traffic, the Free plan's daily caps, and a brand-new account.

## What changed in the price model

- Added Durable Object duration (one always-busy source is about 332K GB-s a month, inside the 400K GB-s included; more sources are billed above that) and R2 writes per archive.
- Added `eventsPerSecondPerSource: 5000` and a peak factor of 3 to decide how many sources a volume needs. At 10B events a month the average is 3,900 events/s, so peaks need 3 sources.
- 10B central estimate $887 to $897; range now $416 to $3,216. Other volumes are unchanged.
- Removed the claim that one source "is near its tested limit of about 800 requests a second".
