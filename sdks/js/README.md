# @hitslop/slurp-sdk

Browser and Node event capture for [Slurp](https://slurp.run), with no runtime dependencies. Events go to the Worker in your own Cloudflare account; `slurp sync` pulls them into DuckDB for your coding agent.

```sh
npm install @hitslop/slurp-sdk
```

`slurp init` in your app prints your project's snippet with the real values filled in: your ingest URL (`https://slurp.<your-subdomain>.workers.dev/v1/events`) and your publishable key (`slurp_pk_…`, ingest-only, safe in a web page).

Browser:

```js
import { init, track } from '@hitslop/slurp-sdk';

init({
  key: 'slurp_pk_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
});

track('signed_up', { plan: 'pro' });
```

Node:

```js
import { init, track, flush } from '@hitslop/slurp-sdk';

init({
  key: 'slurp_pk_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
});

track('order_completed', { total: 49 });

// Send queued events before the process exits.
await flush();
```

`init` creates or replaces the default client. `createClient(options)` creates an independent client with `track`, `identify`, `reset`, `flush`, `close` and a `pending` event count. `track` returns a locally generated UUIDv7, including when an event is rejected; use `onError(error, dropped)` to observe drops. Network failures never throw from `track` or `flush`. Call `identify('user-id', { plan: 'pro' })` to queue an identify record and attach `user_id` to subsequent events. Switching between known users rotates anonymous and session IDs; first identification keeps them so prior anonymous activity can be linked. Queued records retain their original identities. `reset()` clears it and starts a new anonymous identity and session. Thirty minutes without tracking starts a new session. Identity and session survive reloads through storage.

Each record is one JSON line. Identify records omit `event` and put trait updates in `data`:

```json
{"id":"019a3cb6-bc00-7000-8000-000000000001","type":"track","event":"signed_up","timestamp":"2025-11-01T00:00:00.000Z","user_id":"user-42","anonymous_id":"…","session_id":"…","data":{"plan":"pro"},"context":{"library":{"name":"@hitslop/slurp-sdk","version":"0.1.2"}}}
```

`user_id` is omitted until identification. Browser context also contains `page: {url, path, referrer, title}`, `user_agent`, `locale`, and `timezone`; Node context adds `runtime: {name: 'node', version: process.version}`. Event names must be non-empty strings of at most 200 characters (Unicode code points, as the Worker counts them). Data must be a plain object containing only JSON values: no cycles, dates, bigint, functions, undefined, symbols or nonfinite numbers. Data and context are snapshotted when captured. `context` accepts a plain JSON object or a function called for each record; use it for app, device, OS and screen metadata. `context.geo` is reserved for backend enrichment. `track(event, data, { userId, anonymousId, sessionId, context })` overrides one record without changing the client identity, for server applications handling multiple users. Events larger than 1 MiB of serialized UTF-8 JSON are dropped and reported; nothing is ever truncated. No server stamp fields are emitted.

Options besides the required `key` and full `endpoint`:

| Option | Default | Meaning |
| --- | --- | --- |
| `context` | Automatic environment | JSON context or a function producing capture-time context |
| `flushAt` | 100 | Queue size that triggers a send |
| `flushIntervalMs` | 5000 | Background flush interval |
| `maxBatchEvents` | 1000 | Maximum events per request |
| `maxBatchBytes` | 921600 | UTF-8 body target; an event larger than the target travels alone |
| `maxQueue` | 10000 | Queue cap by count; the oldest queued events that are not in a request are dropped and reported |
| `maxQueueBytes` | 4194304 | Most bytes kept offline; the oldest events that are not in a request are dropped and reported (never the ones being sent). Records can be up to 1 MiB, so a count limit alone is not a size limit; 4 MiB also stays under browser localStorage |
| `requestTimeoutMs` | 30000 | A request with no answer after this long is aborted and retried |
| `sessionTimeoutMs` | 1800000 | Session inactivity timeout |
| `storage` | Browser localStorage; Node memory | Adapter described below |
| `fetch` | Global fetch | Fetch implementation |
| `onError` | None | Error callback; `dropped` is zero when work is retained for retry |
| `flushOnHide` | true in browsers | Send one request using fetch keepalive on page hide |

Limits and intervals must be positive safe integers. Browser page hide sends one request of at most 60 KiB (with `?key=` in the URL, since keepalive requests carry no `Authorization` header); the rest stays queued and saved. Timers are unref'd in Node. `flush()` resolves when queued work is acknowledged, a retry is scheduled, or the client stops. Its result is `{accepted, rejected, pending, retryAt, stopped}`: accepted/rejected are cumulative record counts for this client instance, pending is current retained work, retryAt is an epoch-millisecond deadline or null, and stopped is true for a closed client and for one the Worker refused (401/403). Acceptance means durable ingest acknowledgment, not publication or read availability. It respects a pending retry deadline, including across reloads; it does not wait for that deadline. `close()` immediately stops timers, listeners and requests and persists outstanding work; call `flush()` first for a normal shutdown. Subsequent `track` calls are dropped and reported.

A request is raw NDJSON with a trailing newline: the first queued events (at most `maxBatchEvents`, `maxBatchBytes` and, after a 413, the current split limit), sent to `endpoint` with `Content-Type: application/x-ndjson` and `Authorization: Bearer <key>`. Every event has an `id` the SDK generated when you captured it, and an event is resent with the same id and the same bytes until the Worker acknowledges it, so a retry after a lost response can only repeat an event, never change it; `slurp sync` imports each (source, id) once. A retry carries the same events, not necessarily the same request: the SDK keeps no frozen batches, only the queue.

How each answer is handled:

| Answer | What the SDK does |
| --- | --- |
| 2xx | The events are removed. The split limit and backoff reset |
| 400 listing `rejected` lines | Only those lines are dropped and reported through `onError`; the rest is sent at once |
| any other 400 or 4xx (not 408, 413, 429) | The request's events are dropped and reported |
| 413 | The request is halved and retried; a single event the Worker refuses is dropped and reported |
| 408, 429, 5xx, a network error, or no answer within `requestTimeoutMs` | Retry later. 429 and 503 honor `Retry-After` (seconds or an HTTP date); the rest back off with jitter from 250-500 ms up to 30-60 s. The events stay queued |
| 401, 403 | Everything queued is dropped and reported, and this client instance stops. Nothing about the stop is saved, so the next client (the next launch) tries once more |

The state machine, with every rule, is written down in [`sdks/conformance/README.md`](../conformance/README.md) and checked by the scenarios in `sdks/conformance/delivery.json`.

Delivery depends on retained storage and a running client. Queue overflow, invalid or oversized events, permanent rejections and a process that exits before a save finishes can lose events. If saving fails (the storage throws), delivery carries on from memory and the failure is reported through `onError`; the events are then lost only if the process ends before a later save works. The browser default adapter is guarded: when `localStorage` is unavailable it falls back to memory, reports the error once and keeps delivering. Awaiting `flush` or `close` finishes pending writes. Neither call guarantees a successful network delivery when a retry is scheduled.

The storage adapter has localStorage's shape; methods may be synchronous or return promises:

```ts
interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}
```

Saved state holds the visitor identity, the queued events, and the retry deadline, and is namespaced by endpoint, project and source (both read from the publishable key `slurp_pk_<project>_<source>_<random>`), so two senders sharing a storage (two sites on one origin, or the `web` and `widget` sources) never send each other's queued events. Rotating a key means creating another key for the same source, so the queue and the visitor identity carry over to the new key. Replacing the default client with `init` hands its queue to the new client. Saved state is validated when it is read: lines that are not complete JSON records are dropped and reported through `onError` rather than sent. Use one active client per endpoint, source and adapter. **The default Node adapter is in memory, so a Node process that exits loses unsent events; the browser default is `localStorage`.** For restart recovery in Node, use the Node-only entry:

```js
import { createClient } from '@hitslop/slurp-sdk';
import { fileStorage } from '@hitslop/slurp-sdk/node';

const client = createClient({
  key: 'slurp_pk_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
  storage: fileStorage('/tmp/slurp-sdk.json'),
});
client.track('order_completed', { total: 49 });
await client.flush();
await client.close();
```

The parent directory must exist. `fileStorage` replaces the JSON file atomically using a sibling temporary file and rename (mode 0600). Reuse a single adapter for a file within one process; concurrent processes must use separate files. Atomic replacement protects process restart recovery, without a power-loss/fsync guarantee. The main entry never imports Node modules.

## Feedback widget

A drop-in "Feedback" button for web pages. It opens a small form (message, an optional 1 to 5 rating, an optional email) and sends one `feedback` event, so what people tell you lands next to what they did:

```js
import { init } from '@hitslop/slurp-sdk';
import { mountFeedback } from '@hitslop/slurp-sdk/feedback';

init({ key: 'slurp_pk_…', endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events' });
mountFeedback({ askEmail: true, data: () => ({ plan: currentPlan() }) });
```

The event is `{ event: 'feedback', data: { message, rating?, email?, ...data() } }` with the usual page context, so in SQL: `SELECT timestamp, data->>'message', data->>'rating' FROM events WHERE event = 'feedback'`. Options: `client` (default: the client from `init`), `label`, `title`, `placeholder`, `ratings` (default true), `askEmail` (default false), `position` (`bottom-right` or `bottom-left`), `accent`, `theme` (`auto` follows the visitor's dark mode; `light` or `dark` match your page), `event`, `data`, `button: false` (open it from your own button with the returned `open()`), `container`, `poweredBy` (default true: a small "Powered by Slurp" link under the form, opening slurp.run in a new tab without sending your site's address; `false` hides it). It returns `{ open, close, destroy }`. Text a person types is only ever set as text, never parsed as HTML, and the styles live in a shadow root so they neither affect nor inherit from your page. Browser only.

## Contributing

From the [repository](https://github.com/hitSlop/slurp) root:

```sh
pnpm --filter @hitslop/slurp-sdk typecheck
(cd sdks/js && node --test test/*.test.ts)
pnpm --filter @hitslop/slurp-sdk build
```

Unit tests cover the pure parts (`identity.ts`, `queue.ts`, `response.ts`), the capture scenarios verify identity transitions, contextual snapshots, key rotation and delivery results, and `test/conformance.test.ts` runs the shared delivery scenarios in `sdks/conformance/delivery.json`. The gateway integration scenario starts the real Worker (`backend/`) under `wrangler dev` with local R2 and Durable Objects, injects proxy faults, checks restart replay, retry timing, 413 splitting and permanent authentication failures, then verifies archive digests and that every delivered ID is archived. It needs Node 24+ and `npm install` in `backend/`; it uses no external services or paid APIs. `dist/` is ignored. Source uses erasable TypeScript and `.ts` import specifiers; the build rewrites them to `.js` and emits declarations.

## License

MIT
