# @hitslop/slurp-sdk

Browser and Node event capture for [Slurp](https://slurp.run), with no runtime dependencies. Events go to the Worker in your own Cloudflare account; `slurp sync` pulls them into DuckDB for your coding agent.

```sh
npm install @hitslop/slurp-sdk
```

`slurp init` in your app prints your project's snippet with the real values filled in: your ingest URL (`https://slurp.<your-subdomain>.workers.dev/v1/events`), your source ID and your publishable key (`slurp_pk_…`, ingest-only, safe in a web page).

Browser:

```js
import { init, track } from '@hitslop/slurp-sdk';

init({
  key: 'slurp_pk_…',
  sourceId: 'src_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
});

track('signed_up', { plan: 'pro' });
```

Node:

```js
import { init, track, flush } from '@hitslop/slurp-sdk';

init({
  key: 'slurp_pk_…',
  sourceId: 'src_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
});

track('order_completed', { total: 49 });

// Send queued events before the process exits.
await flush();
```

`init` creates or replaces the default client. `createClient(options)` creates an independent client with `track`, `identify`, `reset`, `flush`, `close` and a `pending` event count. `track` returns a locally generated UUIDv7, including when an event is rejected; use `onError(error, dropped)` to observe drops. Network failures never throw from `track` or `flush`. Call `identify('user-id', { plan: 'pro' })` to queue an identify record and attach `user_id` to subsequent events. Switching between known users rotates anonymous and session IDs; first identification keeps them so prior anonymous activity can be linked. Queued records retain their original identities. `reset()` clears it and starts a new anonymous identity and session. Thirty minutes without tracking starts a new session. Identity and session survive reloads through storage.

Each record is one JSON line. Identify records omit `event` and put trait updates in `data`:

```json
{"id":"019a3cb6-bc00-7000-8000-000000000001","type":"track","event":"signed_up","timestamp":"2025-11-01T00:00:00.000Z","user_id":"user-42","anonymous_id":"…","session_id":"…","data":{"plan":"pro"},"context":{"library":{"name":"@hitslop/slurp-sdk","version":"0.1.0"}}}
```

`user_id` is omitted until identification. Browser context also contains `page: {url, path, referrer, title}`, `user_agent`, `locale`, and `timezone`; Node context adds `runtime: {name: 'node', version: process.version}`. Event names must be non-empty strings of at most 200 characters. Data must be a plain object containing only JSON values: no cycles, dates, bigint, functions, undefined, symbols or nonfinite numbers. Data and context are snapshotted when captured. `context` accepts a plain JSON object or a function called for each record; use it for app, device, OS and screen metadata. `context.geo` is reserved for backend enrichment. `track(event, data, { userId, anonymousId, sessionId, context })` overrides one record without changing the client identity, for server applications handling multiple users. Events larger than 1 MiB of serialized UTF-8 JSON are dropped and reported; nothing is ever truncated. No server stamp fields are emitted.

Options besides the required `key` and full `endpoint`:

| Option | Default | Meaning |
| --- | --- | --- |
| `sourceId` | None | Public source ID; include it so identity survives publishable-key rotation |
| `context` | Automatic environment | JSON context or a function producing capture-time context |
| `flushAt` | 100 | Queue size that triggers a send |
| `flushIntervalMs` | 5000 | Background flush interval |
| `maxBatchEvents` | 1000 | Maximum events per request |
| `maxBatchBytes` | 921600 | UTF-8 body target; an event larger than the target travels alone |
| `maxQueue` | 10000 | Unbatched queue cap; oldest queued events are dropped and reported; unacknowledged batch bodies remain intact |
| `sessionTimeoutMs` | 1800000 | Session inactivity timeout |
| `storage` | Browser localStorage; Node memory | Adapter described below |
| `fetch` | Global fetch | Fetch implementation |
| `onError` | None | Error callback; `dropped` is zero when work is retained for retry |
| `flushOnHide` | true in browsers | Try one head batch using fetch keepalive on page hide |

Limits and intervals must be positive safe integers. Browser page hide sends at most 60 KiB; larger bodies stay persisted. Timers are unref'd in Node. `flush()` resolves when queued work is acknowledged, a retry is scheduled, or the client stops. Its result is `{accepted, rejected, pending, retryAt, stopped}`: accepted/rejected are cumulative record counts for this client instance, pending is current retained work, retryAt is an epoch-millisecond deadline or null, and stopped includes closed clients. Acceptance means durable ingest acknowledgment, not publication or read availability. It respects a pending retry deadline, including across reloads; it does not wait for that deadline. `close()` immediately stops timers, listeners and requests and persists outstanding work; call `flush()` first for a normal shutdown. Subsequent `track` calls are dropped and reported.

Batches are raw NDJSON with a trailing newline, sent to `endpoint` with `Content-Type: application/x-ndjson` and `Authorization: Bearer <key>`. Before the first send, the SDK persists the exact completed body. Retries and restarts resend those bytes so the gateway can dedupe a committed request whose response was lost. A 200 acknowledges a batch; 429/503 honor `Retry-After` (seconds or HTTP date), and other 5xx/network errors back off with jitter from 250–500 ms to 30–60 s. A 413 splits existing lines without reserializing them; a rejected singleton is dropped. A 400 or other permanent rejection drops the batch. A 401/403 drops all pending work and permanently stops that client, including when its state is restored. Storage write failures retain work and prevent sending until a snapshot succeeds.

Delivery depends on retained storage, gateway dedupe retention, and a running client. Queue overflow, invalid/oversized events, permanent rejections, and failed browser persistence can lose events. Browser localStorage access is guarded; if unavailable it falls back to memory and reports the error. A process exiting before storage writes finish can lose newly queued events; awaiting `flush` or `close` finishes those writes. Neither call guarantees a successful network delivery when a retry is scheduled.

The storage adapter has localStorage's shape; methods may be synchronous or return promises:

```ts
interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}
```

Version-2 storage keys are namespaced by endpoint and public source ID when supplied, with publishable-key fallback otherwise. The incompatible version-1 state remains untouched. Supply `sourceId` for identity continuity across key rotation. Use one active client per endpoint/source and adapter; independent clients can use separate adapters. The default Node adapter is in memory. For restart recovery, use the Node-only entry:

```js
import { createClient } from '@hitslop/slurp-sdk';
import { fileStorage } from '@hitslop/slurp-sdk/node';

const client = createClient({
  key: 'slurp_pk_…',
  sourceId: 'src_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
  storage: fileStorage('/tmp/slurp-sdk.json'),
});
client.track('order_completed', { total: 49 });
await client.flush();
await client.close();
```

The parent directory must exist. `fileStorage` replaces the JSON file atomically using a sibling temporary file and rename (mode 0600). Reuse a single adapter for a file within one process; concurrent processes must use separate files. Atomic replacement protects process restart recovery, without a power-loss/fsync guarantee. The main entry never imports Node modules.

## Contributing

From the [repository](https://github.com/hitSlop/slurp) root:

```sh
pnpm --filter @hitslop/slurp-sdk typecheck
(cd sdks/js && node --test test/*.test.ts)
pnpm --filter @hitslop/slurp-sdk build
```

The capture scenarios verify identity transitions, contextual snapshots, key rotation and delivery results. The gateway integration scenario starts the real Worker (`backend/`) under `wrangler dev` with local R2 and Durable Objects, injects proxy faults, checks deduped restart replay, retry timing, 413 splitting and permanent authentication failures, then verifies archive digests and the exact delivered IDs. It needs Node 24+ and `npm install` in `backend/`; it uses no external services or paid APIs. `dist/` is ignored. Source uses erasable TypeScript and `.ts` import specifiers; the build rewrites them to `.js` and emits declarations.

## License

MIT
