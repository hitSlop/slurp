# Wire contracts

The Worker, the CLI and the SDKs agree on what is written here, and nothing else. Change this file first when a contract changes.

Rules every part follows:

1. **The Worker validates and stamps; the importer applies defaults.** The Worker never invents a client field, so two copies of one record always agree. Missing fields get defaults in exactly one place: the import into DuckDB.
2. **Store facts, derive the rest.** Persist what happened (a chunk was committed, an archive was published); compute schedules and status from it.
3. **Sync never stops on content.** A bad, conflicting or missing event becomes a diagnostic row; only integrity failures stop a sync.

## Credentials

| Credential | Format | Can |
|---|---|---|
| Admin token | `ADMIN_TOKEN` secret, at least 20 characters | Everything |
| Secret key | `slurp_sk_<project hex 16>_<random hex 48>`, with a label (`name`) | Read one project's archives |
| Publishable key | `slurp_pk_<project hex 16>_<source>_<random hex 48>` | Send events to one project, as one source |

- **Projects** are `prj_<16 hex>`.
- **A source is a name** (`default`, `web`, `ios`, `cli`, `mcp`, `github`, …) matching `^[a-z][a-z0-9_]{0,31}$`. It is not an entity: a source exists while it has keys.
  - Rotating a key means creating another key for the same source and revoking the old one. The source, and so the SDK queue and the dedupe scope, stay the same.
  - Publishable keys are stored as they are, so they can be shown again. Secret keys are stored only as SHA-256.
  - The Worker always takes the source from the stored key row, never by trusting the text of the key.
- **Parse a publishable key** with `^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_([0-9a-f]{48})$`. Group 1 is the project hex and group 2 the source. The key contains only word characters, so it works as a Sentry DSN public key.

## Sending events: `POST /v1/events`

- **Auth:** `Authorization: Bearer <publishable key>`, or exactly one `?key=<publishable key>` (used for browser keepalive requests and curl). When both are present, the query key wins. A query credential must be publishable.
- **Body:** NDJSON, at most `MAX_BODY_BYTES` (default 10 MiB), read as sent (no gzip decoding).
  - A single JSON object is a one-line body.
  - Lines are split on `\n`; a trailing `\r` and surrounding whitespace are trimmed. Lines that are empty after trimming are skipped.
  - Line numbers count every line, from 1.
- **Each record** is one JSON object of at most 1 MiB, checked like this:
  - **Syntax:** it must parse with `JSON.parse`. Every string and key must be well-formed UTF-16 (no lone surrogates). Nesting depth is at most 128.
  - **Optional fields, type-checked when present:**
    - `type`: `"track"` or `"identify"`, default `track`
    - `id`: a string of 1-256 UTF-8 bytes
    - `timestamp`: an RFC 3339 string with a valid calendar date and time, with upper-case `T` and `Z` (DuckDB cannot read the lower-case forms)
    - `data` and `context`: objects
    - `user_id`, `anonymous_id` and `session_id`: non-empty strings
    - `event`: when present, a string of 1-200 Unicode code points
  - **A track record** (`type` absent or `"track"`) needs `event`.
  - **An identify record** needs `user_id`.
  - **Explicit `null`** for any of the fields above is invalid.
  - **Any other field** is kept as it is. No field name is reserved: server metadata lives outside the record (see the envelope below).
- **Atomic:** if any line is invalid, nothing is stored.
- **Ids make retries safe:** send an `id`. The SDKs, `slurp send` and the MCP tool always do. Records without an id are each a new event, including byte-identical repeats.

| Response | Meaning |
|---|---|
| `200 {"ok":true,"accepted":N}` | Durable (committed to the project's Durable Object) before this is sent. `N` can be 0 |
| `400 {"error":"invalid records","rejected":[{"line":3,"reason":"timestamp must be RFC 3339"}]}` | Nothing stored. Every bad line is listed, up to 100 |
| `400 {"error":"…"}` | The body itself is unreadable |
| `401 {"error":"invalid key"}` / `403 {"error":"publishable key required"}` | Stop sending with this key |
| `413 {"error":"body too large"}` | Send fewer records per request |
| `429` / `503` with `Retry-After` (seconds) | Retry the same records later |

CORS: `access-control-allow-origin: *`, exposing `Retry-After`. Preflight allows `POST, OPTIONS` and the `Authorization, Content-Type` headers.

### Compatibility endpoints

These are unchanged in shape and authenticated with a publishable key. They feed the same ingest path:
- Segment `/v1/{t,i,p,s,g,a,b,batch}` and `/v1/projects/<key>/settings`
- Sentry `/api/<n>/envelope/` and `/api/<n>/store/`
- Webhooks `/hooks/<provider>?key=<key>`

Rules for adapters:
- **Never invent a client field.** A timestamp the source did not send is omitted, never set to now or `sentAt`. An id is only ever one the protocol supplies, or a deterministic hash when the protocol defines it.
- Segment and Sentry skip invalid individual records, because their SDKs drop a whole request on 400. Webhooks are single records.
- The Segment endpoints answer an unknown, revoked or secret write key with **400**, not 401: Segment SDKs drop a batch only on 400, and analytics-swift resends every queued batch at every flush after a 401, indefinitely.
- Geo is never added to webhooks, because the caller is the provider's server.

## Archives

R2 key: `projects/<project id>/archives/<seq zero-padded to 20 digits>.jsonl.gz`. `seq` starts at 1 and is gapless per project. An archive is gzip NDJSON with at most `ARCHIVE_MAX_BYTES` (default 8 MiB) of uncompressed input, or one stored chunk when a chunk alone is larger.

Each line is an **envelope**:

```
{"received_at":"2026-11-07T12:00:00.000Z","sender":"web","geo":{"city":"Lyon","country":"FR","region":"ARA"},"record":<the client's record, byte for byte>}
```

- `received_at`: when the Worker accepted the request (ISO 8601, milliseconds, UTC).
- `sender`: the source of the key that sent it.
- `geo`: only when `GEO` is on and Cloudflare's `request.cf` gives values. It holds `city`, `country` and `region`, sorted by key. `country` is ISO 3166-1 alpha-2, never `XX` or `T1`.
- `record`: the trimmed line as sent. Numbers, key order and escapes are untouched. The one change: a raw line break (`\r` or `\n`) becomes a space. Valid JSON can only hold a raw line break as whitespace between tokens, so nothing meaningful changes, and an envelope is always exactly one line. (This matters for webhooks, whose providers may send pretty-printed JSON.) The fields appear in this order, and `record` is always last.

### Control API: `POST /v1/rpc/<Method>`

- **Request:** a JSON body (`{}` is allowed) with `Authorization: Bearer <token>`.
- **Success:** `200` with JSON.
- **Failure:** an HTTP status plus `{"error":{"code":"<code>","message":"…"}}`.

| code | status |
|---|---|
| `invalid_argument` | 400 |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `already_exists` | 409 |
| `unavailable` | 503 (admin token not configured, or storage unavailable) |

The types are defined once, as serde structs in `crates/slurp-client/src/api.rs` (`#[serde(rename_all = "camelCase")]`). They are exported to `backend/src/api.gen.ts` with ts-rs, and CI fails if that file is stale. Optional fields are omitted when absent, never `null`.

```
ProjectInfo  { id, name, title?, createdAt }
ApiKey       { keyId, project, scope: "publishable"|"secret", source?, name?, createdAt, revokedAt?, key? }   // key: always for a publishable key; for a secret key only in the CreateKey response
Webhook      { provider, url, secret, sender, steps: string[] }
Coverage     { first?: u64, last?: u64, lastAt?: string, pending: bool }   // first = oldest retained seq
ArchiveInfo  { seq: u64, size: u64, sha256, events: u64, createdAt }
```

| Method | Auth | Request | Response |
|---|---|---|---|
| `Whoami` | any valid token | `{}` | `{ scope: "admin"\|"secret"\|"publishable", project?, source?, name? }` |
| `CreateProject` | admin | `{ name, title? }` (idempotent by name) | `{ project, created, publishableKey, ingestUrl }`, where the key is for source `default` |
| `GetProject` | admin | `{ project }` (id or name) | `{ project, ingestUrl }` |
| `ListProjects` | admin | `{}` | `{ projects }` |
| `SourceKey` | admin | `{ project, source }` | `{ key: ApiKey }`: the source's oldest live publishable key, created if there is none |
| `CreateKey` | admin | `{ project, scope, source? , name? }` | `{ key: ApiKey }`. Publishable needs `source`; secret takes `name` (default `default`) |
| `ListKeys` | admin | `{ project, scope? }` | `{ keys }` |
| `RevokeKey` | admin | `{ project, keyId }` | `{ key }` |
| `ConnectWebhook` | admin | `{ project, provider, secret? }` | `Webhook` |
| `ListArchives` | admin, or that project's secret key | `{ project, after?: u64, limit?: 1..5000 (default 1000) }` | `{ coverage: Coverage, archives: ArchiveInfo[], next?: u64, gap?: { from: u64, to: u64 } }` |
| `Publish` | admin | `{ project }` | `{ coverage: Coverage }` |

Method notes:
- **`ConnectWebhook`** is idempotent.
  - The provider's source is the provider name, so its events carry `sender = "github"`.
  - The webhook's secret is tied to its key. When there is no connection, or its key has been revoked, connecting creates a new key and, for generated-secret providers (`github`, `revenuecat`, `generic`), a new random secret. Both are stored and shown again.
  - **Rotating** means revoking that key with `RevokeKey` and connecting again. The URL and the secret both change.
  - Stripe issues its own secret, so it is passed as `secret` (`whsec_…`). It is `""` until then, and passing it again replaces it.
  - `steps` are the setup instructions to show the user. They come from the Worker's provider registry, so a new provider needs no CLI change.
- **`ListArchives`**:
  - Without `after`, it starts at `coverage.first`.
  - When `after + 1 < coverage.first`, archives were deleted by retention before they were read. The response then carries `gap: {from: after + 1, to: first - 1}` and continues from `first`.
  - `pending` is true while accepted events are not yet in an archive.
- **`Publish`** archives everything buffered when it is called, up to the watermark taken at the start, so continuous traffic cannot keep it running. It shares the one in-flight publication with the alarm.

### Download: `GET` or `HEAD /v1/projects/<project id>/archives/<seq>`

- **Auth:** `Authorization: Bearer <admin token or that project's secret key>`.
- **Responses:**
  - `200`: gzip bytes, with `content-type: application/gzip`, `content-length` and `etag`
  - `404`: the archive does not exist or was deleted by retention
  - `401` / `403`
- A download URL grants nothing by itself: the bearer token is the only credential.

### Other routes

| Route | Use |
|---|---|
| `GET /v1/health` | `{ ok, apiVersion: 2, configured, build, geo }`, with no auth |
| `GET /healthz` | `ok` |
| `GET /` | The setup page |
| `POST /v1/admin/purge` | Admin, with `{"confirm":"delete-all-data"}`. Unchanged |

## Worker settings (`wrangler.jsonc` `vars`)

These are parsed once, in `backend/src/config.ts`. An empty, non-numeric, non-finite or below-minimum value falls back to the default, with one warning per variable.

| Variable | Default | Minimum | Meaning |
|---|---|---|---|
| `SEAL_INTERVAL_MS` | 600000 | 1 | An archive is published this long after its oldest buffered event was committed |
| `ARCHIVE_MAX_BYTES` | 8388608 | 1 | The uncompressed input per archive. Publishing starts at once when this much is buffered |
| `GROUP_COMMIT_MS` | 500 | 0 | Concurrent requests inside this window share one stored chunk |
| `BUFFER_CAP_BYTES` | 67108864 | 1 | Unpublished data per project. Above it, ingest answers 429 |
| `MAX_BODY_BYTES` | 10485760 | 1 | Largest request body |
| `RETENTION_DAYS` | 0 | 0 | 0 keeps archives forever. Fractions are allowed (tests use them) |
| `ARCHIVE_RETRY_MS` | 5000 | 1 | First retry after an R2 failure. It doubles up to `SEAL_INTERVAL_MS`, forever |
| `GEO` | `on` | | `on` or `off` |

Also: `ADMIN_TOKEN` (a secret) and `SLURP_BUILD`.

## Local import (CLI)

These are fresh tables: there is no migration from earlier layouts.

```
events(sender, id, type, event, timestamp, user_id, anonymous_id, session_id, data JSON, context JSON, geo JSON,
       received_at, archive_seq, line, raw JSON, fingerprint, PRIMARY KEY(sender, id))
_slurp.identity(version, backend, project)   -- the binding of this database to one project on one Worker
_slurp.deliveries(project, sequence, sha256, bytes, imported_at, PRIMARY KEY(project, sequence))
_slurp.problems(kind 'conflict'|'invalid'|'gap', sender, id, archive_seq, line, record, detail, seen_at,
                PRIMARY KEY(kind, archive_seq, line))   -- a gap row uses archive_seq = from, line = 0, record = {"from":n,"to":m}
```

**Per archive**, after its size and SHA-256 match the listing:
1. Read the gzip NDJSON in Rust. For each line `n` (from 1), parse the envelope with `serde_json::value::RawValue` for `record`.
   - If that fails, or `record` is not an object, write an `invalid` problem.
   - Otherwise the fingerprint is the SHA-256 of the record's exact bytes.
2. In one DuckDB transaction:
   - **Defaults:**
     - `id = coalesce(record.id, 'slurp:' || seq || ':' || n)`
     - `type = coalesce(record.type, 'track')`
     - `timestamp = coalesce(record.timestamp, received_at)`
     - `data = coalesce(record.data, {})`
   - **Shape checks:** a line with the wrong shape (an unknown type, a track without `event`, an identify without `user_id`) becomes an `invalid` problem.
   - **Identity** is `(sender, id)`. The first copy by `(archive_seq, line)` wins, whether it is already in `events` or in this archive.
     - A copy with the same fingerprint is a duplicate and is only counted.
     - A copy with a different fingerprint is a `conflict` problem.
   - Insert the events and the receipt.
   - Replaying an archive changes nothing.
3. **A `gap` from `ListArchives`** is written as a problem, and sync continues. `slurp sync`, `slurp status` and `slurp health` then report `history_incomplete: {from, to}` (the span of every gap) and print a prominent warning: those events are lost.

**Fatal sync errors** (the only ones):
- a download failure, after retries
- a size or SHA-256 mismatch
- truncated gzip
- a receipt for a different project
- a published sequence that skips a number

Sync output: `{downloaded, imported, duplicates, conflicts, invalid, gaps, checkpoint, …}`. `slurp health` reports the problems.

`slurp sync --now` calls `Publish` (admin only) and then syncs. A secret key gets a clear "needs the admin token" error.

The CLI and MCP send with source keys from `SourceKey`. `slurp send` and `identify` use `cli`; the MCP send tools use `mcp`. `slurp init` uses `default`.

## SDK delivery

Every SDK implements this. `sdks/conformance/delivery.json` holds the executable scenarios.

- **State:**
  - The persisted state is `{version: 1, anonymousId, sessionId, lastActivity, userId?, queue: [line…], retryAt, attempts}`, stored under `<endpoint without query, hash or trailing slash>` + `<project hex>` + `<source>`, all parsed from the key. A key that doesn't parse uses the whole key.
  - Nothing else is persisted: no frozen batches and no stop flag.
- **Requests:**
  - A request takes the first `k` queued lines: `k ≤ maxBatchEvents` (default 1000), at most `maxBatchBytes` (default 900 KiB), and at most the current split limit.
  - Retries only need to carry the same records (the same ids), not the same request bytes.
- **Responses:**

  | Response | What the SDK does |
  |---|---|
  | 2xx | Remove the `k` lines; reset the split limit and backoff |
  | 400 with `rejected` | Remove and report the listed lines (line numbers are 1-based within the request); send the rest at once |
  | Any other 400, and every 4xx not listed below | Drop the `k` lines and report them |
  | 413 | Halve the split limit. With `k = 1`, drop and report that line |
  | 408, 429, 5xx, network error, timeout | Back off: `Retry-After` on 429 or 503 (digits or an HTTP date), otherwise exponential with jitter, 0.5 s doubling to 60 s. The lines are not removed |
  | 401 / 403 | Keep everything queued and stop sending from this client instance; new captures are still queued, within the queue limits. Nothing extra is persisted: the next launch tries once more, and a new key for the same source (which shares the storage) delivers the queue |

- **Rules:**
  - The flush timer keeps the earliest deadline; a new capture never postpones it.
  - Overflow (`maxQueue`, `maxQueueBytes`) drops the oldest lines that are **not** in flight.
  - Replacing a client (`init` twice) finishes the old client's last save before the new one reads.
- **Identity:**
  - A new `anonymousId` and `sessionId` come with `reset()`, or when `identify` switches to a different user.
  - A new session starts after `sessionTimeoutMs` (default 30 min) of inactivity, using `>=`.
  - An event name's length is counted in code points.
