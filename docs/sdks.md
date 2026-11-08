# SDKs and compatibility

Slurp takes events from its own JavaScript and React Native SDKs, from plain HTTP, and from the Segment and Sentry SDKs you may already use (Swift included): point them at your Worker and change nothing else. Everything lands in the same archive, and `slurp sync` pulls it into one DuckDB table.

Every SDK takes two values, the **ingest URL** and the **publishable key** (see below for where they come from). Below, `WORKER` is your Worker's origin (`https://slurp.YOUR-SUBDOMAIN.workers.dev`) and `HOST` is the same without `https://`.

## Where the endpoint and key come from

You never make either by hand. Run `slurp init` inside your app: it creates the project on your Worker, and the Worker creates the project's first **publishable key** in the same step (for the source `default`). `slurp init` then prints, and the setup page it opens shows, the two values:

- **Ingest URL**: your Worker's address plus `/v1/events`, for example `https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events`.
- **Publishable key**: `slurp_pk_<project>_<source>_<random>`. It can only add events to that one project, so it is safe in a web page or an app. The key itself says which project the events belong to and which source they come from; there is no third value to pass.

Print them again whenever you need them, and make more:

```sh
slurp project setup PROJECT                      # the ingest URL and the project's publishable keys; changes nothing
slurp project key list PROJECT --scope publishable
slurp project key create PROJECT --scope publishable --source ios  # one key per source
slurp project key revoke PROJECT KEY_ID                            # stops that key on its next request
```

Give each place that sends its own source (`web`, `ios`, `github`): the source of the key is stamped on every event it sends as `sender`, so a query can tell them apart. A source is only a name inside the key (lowercase letters, digits and `_`, starting with a letter, up to 32 characters). Rotating a key means creating another for the same source and revoking the old one: the source, and so the SDK's saved queue, stay the same. `slurp send` and `slurp identify` send as `cli`, and the MCP send tools as `mcp`. The other two credentials are not for apps: a **secret key** (`slurp_sk_…`) reads one project's archives, for bots, and the **admin token** controls the whole Worker and stays on your machine. [How the connection works](connection.md) explains all three.

## What works

| | Package or setup | Status |
| --- | --- | --- |
| [JavaScript and TypeScript](../sdks/js) | `npm install @hitslop/slurp-sdk` | Published. Browser and Node. Tested against a real Worker |
| [React Native and Expo](../sdks/react-native) | `npm install @hitslop/slurp-react-native @react-native-async-storage/async-storage` | Tested against fakes of the React Native APIs; not yet run on a device |
| Swift (iOS, macOS, tvOS, watchOS) | Segment's `analytics-swift`: add `https://github.com/segmentio/analytics-swift` in Xcode, set both hosts (below) | Segment's SDK; there is no Slurp Swift SDK. Version 1.10.4 is run against a real Worker on macOS in CI (`backend/test/compat-swift.test.ts`); [what that proves](#swift-ios-macos-tvos-watchos) |
| Segment SDKs | Change the host (below) | Verified with `@segment/analytics-node`, `@segment/analytics-next` (single and batching) and **`segment-analytics-python`** 2.4.0. `analytics-swift` is tested separately (Swift row) |
| Sentry SDKs | Change the DSN (below) | Verified with `@sentry/node`, `@sentry/browser` and **`sentry-sdk` for Python** 2.74.0 |
| Python | `pip install segment-analytics-python` or `sentry-sdk`, then change the host or DSN (below) | Both run unmodified against a local Worker on Python 3.9, 3.12 and 3.14 (`backend/test/compat-python.test.ts`). There is no native Python SDK |
| HTTP, any language | `POST /v1/events` with only an `event` in the body | Tested |
| The CLI | `slurp send`, `slurp identify` | Tested |

Coming, with no dates: first-party Rust and Kotlin (Android) SDKs, and local symbolication of Sentry stack traces in the CLI. Other Segment and Sentry SDKs (Kotlin, Go, Ruby, React Native, Cocoa, Android...) speak the same protocols and should work with the same URL change, but have not been run against a Worker, so they are not listed as supported.

## Slurp SDKs

### JavaScript and TypeScript

```sh
npm install @hitslop/slurp-sdk
```

```js
import { init, track, identify, flush } from '@hitslop/slurp-sdk';

init({ endpoint: 'WORKER/v1/events', key: 'slurp_pk_…' });
identify('user_42', { plan: 'pro' });
track('signed_up', { plan: 'pro' });
await flush(); // in scripts, send queued events before exiting
```

Options, storage adapters and delivery rules: [sdks/js](../sdks/js/README.md). In the browser, unsent events are kept in `localStorage`. **In Node the default queue is in memory**, so call `await flush()` before the process exits, or pass `storage: fileStorage(path)` from `@hitslop/slurp-sdk/node` to keep unsent events across restarts.

For a feedback form, `import { mountFeedback } from '@hitslop/slurp-sdk/feedback'` adds a drop-in "Feedback" button that sends a `feedback` event (message, optional rating and email), with a small "Powered by Slurp" link under the form (`poweredBy: false` hides it); see [the widget](../sdks/js/README.md#feedback-widget).

### React Native and Expo

```sh
npm install @hitslop/slurp-react-native @react-native-async-storage/async-storage
```

```ts
import { init, track, identify, screen } from '@hitslop/slurp-react-native';

init({ endpoint: 'WORKER/v1/events', key: 'slurp_pk_…' });
screen('Home');
track('purchase_completed', { total: 49 });
```

The queue lives in AsyncStorage, so events survive the app being killed; they are sent when the app goes to the background and when the network returns (pass NetInfo). Details: [sdks/react-native](../sdks/react-native/README.md).

### Swift (iOS, macOS, tvOS, watchOS)

Slurp has no Swift SDK of its own. Use Segment's `analytics-swift` and point it at your Worker. See [Use the Segment SDK you already have](#use-the-segment-sdk-you-already-have): set both `apiHost("HOST/v1")` and `cdnHost("HOST/v1")`.

**What is tested.** `backend/test/compat-swift.test.ts` builds a small program against `analytics-swift` 1.10.4 (pinned in `sdks/compat/swift/Package.resolved`) and runs it on macOS against a real Worker, in CI on every change. It proves that:

- `identify`, `track` and `screen` are stored with the key's source as `sender`; a `screen` is a `track` named `screen` with `name`, `category` and the properties in `data`;
- the SDK reads its settings from `GET /v1/projects/<key>/settings` on the Worker, and with both hosts set it makes no request to `segment.com` or `segment.io` (the program fails if it tries);
- events captured while the Worker is unreachable stay on disk, and a later launch delivers them once flushed;
- after a `401` (revoked key) the SDK keeps the batches and sends them again at every flush (below).

It does not run on a device or a simulator, and not on tvOS or watchOS. The SDK builds its URLs with `https://`; the test rewrites them to `http` for a local Worker with the SDK's `requestFactory` hook, which a deployed Worker does not need.

### analytics-swift compared with the Slurp JS SDK

| | `analytics-swift` | Slurp JS SDK (`@hitslop/slurp-sdk`) |
| --- | --- | --- |
| Queue across restarts | Kept on disk by default. Tested: events captured with the Worker unreachable were delivered by the next launch. It does not send at launch by itself: the queue goes out at the next flush (every 30 s by default, or when 20 events are queued) | Kept in `localStorage` (browser) or AsyncStorage (React Native); in Node only with `fileStorage`. Sent again after a relaunch |
| Flush when the app goes to the background | Yes on iOS (from the SDK's source and docs; not tested here). | Yes: browser page hide, React Native `background` and `inactive` (tested against fakes) |
| After a `401` or `403` | Tested with a revoked key: reports the error, keeps every batch and sends it again at every flush, so a dead key keeps retrying. Only a `400` drops a batch (from the SDK's source) | Keeps the queue and pauses for this client instance; the next launch tries once |
| After the key is rotated | Queued events are lost to the new key. The queue folder is named after the write key, and each batch file carries the key it was closed under. Tested: a launch with the new key starts empty and the old batches stay on disk under the old key | A new key for the same source shares the queue and delivers it |
| `session_id` | None: Segment SDKs send no session, and Slurp does not derive one | Always set; a new session after 30 minutes of inactivity |
| Event mapping | `track` and `identify` as themselves; `screen` becomes a `track` named `screen`; ids come from Segment's `messageId`; `context.compat` is `segment` | `track` and `identify` as themselves; the React Native `screen()` is a `track` named `screen` too |

To rotate the key of an iOS or macOS app, ship the new key and revoke the old one only after installs have updated and had a chance to flush: a launch with the new key does not send what the old key queued.

### HTTP

POST to `WORKER/v1/events`. The body is one JSON object, or one object per line (NDJSON). Only `event` is required:

```sh
curl -X POST 'WORKER/v1/events?key=slurp_pk_…' --data-binary '{"event":"signed_up"}'
# {"ok":true,"accepted":1}
```

- **Key:** `?key=slurp_pk_…` or `Authorization: Bearer slurp_pk_…`. When both are present, the query key wins. Only publishable keys work.
- **Optional fields:** `id`, `type` (`track` or `identify`, default `track`), `timestamp` (RFC 3339, upper-case `T` and `Z`), `data` and `context` (objects), `user_id`, `anonymous_id`, `session_id`. An `identify` needs `user_id`. Any other field is kept as it is. A record may be up to 1 MiB and is stored whole.
- **Missing fields:** the import gives a record with no `id` the id `slurp:<archive>:<line>`, and one with no `timestamp` the time the Worker received it.
- **All or nothing:** if any line is invalid, nothing is stored and the `400` lists every bad line: `{"error":"invalid records","rejected":[{"line":3,"reason":"timestamp must be RFC 3339"}]}` (up to 100).
- **Retries:** a record without an `id` is a new event every time it is sent, byte-identical repeats included. Send an `id` to make a retry safe: the same `id` from the same source is stored once. The SDKs and `slurp send` always send one.
- **Status codes:** `200` durable; `401` / `403` wrong, revoked or non-publishable key (the Slurp SDKs keep their queue and stop sending until the next launch, so a new key for the same source delivers it); `413` body too large, send fewer records per request; `429` / `503` with `Retry-After`, retry the same records later.

The exact rules are in [contracts.md](contracts.md#sending-events-post-v1events).

## Use the Segment SDK you already have

Your **publishable key is the write key**. Secret keys are refused.

```js
// Node: @segment/analytics-node
const analytics = new Analytics({ writeKey: 'slurp_pk_…', host: 'WORKER', path: '/v1/batch' });
```

```js
// Browser: @segment/analytics-next. cdnURL makes it load its settings from your Worker.
const [analytics] = await AnalyticsBrowser.load({ writeKey: 'slurp_pk_…', cdnURL: 'WORKER' });
```

```python
# Python: segment-analytics-python (pip install segment-analytics-python)
import segment.analytics as analytics
analytics.write_key = 'slurp_pk_…'
analytics.host = 'WORKER'   # the SDK adds /v1/batch
analytics.track('user_42', 'signed_up', {'plan': 'pro'})
analytics.flush()           # in scripts, before the process exits
```

```swift
// Swift: analytics-swift
let config = Configuration(writeKey: "slurp_pk_…").apiHost("HOST/v1").cdnHost("HOST/v1")
```

Set both hosts in Swift: without `cdnHost` the SDK fetches its settings from Segment's CDN and can send events there instead. In Xcode, add the package `https://github.com/segmentio/analytics-swift`; the full snippet is on the [Connections page](https://slurp.run/connections/#sdks).

What the Worker accepts: `POST /v1/t`, `/v1/i`, `/v1/p`, `/v1/s`, `/v1/g`, `/v1/a`, `/v1/b` and `/v1/batch`, `GET /v1/projects/<key>/settings`, and CORS preflights. The write key may arrive as Basic auth, in the body (`writeKey`) or as `?key=`.

How messages are stored:

| Segment | Slurp |
| --- | --- |
| `track` | `track` event; `properties` become `data` |
| `identify` | `identify`; `traits` become `data` (an identify with no `userId` becomes a `track` named `identify`) |
| `page`, `screen` | `track` events named `page` and `screen`; `properties`, `name` and `category` in `data` |
| `group`, `alias` | `track` events named `group` and `alias`; `group_id` or `previous_id` in `data` |
| `messageId` | `id` (Segment SDKs always send one, so a retry is stored once; a message without one has no `id`) |
| `userId`, `anonymousId`, `timestamp`, `context` | `user_id`, `anonymous_id`, `timestamp`, `context`. A missing timestamp is left out, never set to now, and the import uses the arrival time |
| `integrations`, `sentAt`, `writeKey` | not stored. `context.compat` is set to `segment` |

Limits: events are re-serialized rather than stored byte for byte (so a number beyond JavaScript's precision is rounded); an event that cannot be stored (invalid, or over 1 MiB) is skipped without failing the rest of its batch, and the response says how many were accepted and rejected; a request with no storable event gets a `400`, which Segment SDKs drop rather than retry. Sessions are not derived: Segment SDKs send none.

## Use the Sentry SDK you already have

Change the DSN. The public key in the DSN is your publishable key as is (it is only letters, digits and `_`, which is all Sentry SDKs allow there). The setup page shows the finished DSN for your project:

```js
Sentry.init({ dsn: 'https://slurp_pk_…@HOST/1' }); // the trailing /1 is ignored
```

```python
# Python: sentry-sdk (pip install sentry-sdk)
import sentry_sdk
sentry_sdk.init(dsn='https://slurp_pk_…@HOST/1')
```

The Worker accepts `POST /api/<project>/envelope/` and the legacy `/api/<project>/store/`, with the key in `X-Sentry-Auth`, the query string or the envelope's DSN header, plain or gzipped.

| Sentry sends | Stored |
| --- | --- |
| An error (a real exception, or level `error` or `fatal`) | `track` named `error`; **the whole Sentry event as sent is in `data`**: exception, stack frames, breadcrumbs, tags, contexts, request, `debug_meta`, release, environment |
| Any other event, such as `captureMessage` | `track` named `message`, whole |
| User feedback | `track` named `user_feedback` |
| Cron check-ins | `track` named `check_in` |
| Sessions, transactions, replays, attachments, profiles, spans, logs, metrics, client reports | accepted and dropped, so the SDK sees success |

An error or message uses Sentry's `event_id` as its `id`; user feedback and check-ins use a hash of their bytes, so a retried envelope is stored once. `user.id` (else email, then username) becomes `user_id`; `context.library` names the Sentry SDK; `context.compat` is `sentry`. Read errors with the `errors` view, which pulls the exception, where it was thrown, release, environment and a grouping key out of the stored event when you query:

```sql
SELECT group_key, any_value(exception_type) AS type, any_value(message) AS message,
       count(*) AS n, count(DISTINCT user_id) AS users
FROM errors GROUP BY group_key ORDER BY n DESC LIMIT 20;
```

What this is not: Sentry does server-side work Slurp does not. There is no source-map or native symbolication, so browser stack traces stay minified and native frames stay as addresses (the debug ids to symbolicate them are kept in `data`, and symbolicating locally from your own build output is planned); `group_key` is a best-effort hash of the exception type and in-app frames, similar to but not the same as Sentry's issue grouping; there is no issue UI, alerting, release health or performance monitoring; Sentry's rate-limit headers are not implemented.

## Limits that apply to every path

- A record can be up to 1 MiB and is never truncated. A larger one is refused with `413` (or skipped, on the Segment and Sentry paths).
- Duplicates are harmless when events carry an `id`: `slurp sync` keeps one row per `(sender, id)`, and a repeat with the same content is only counted. The same `id` with different content is set aside in `_slurp.problems` (see `slurp health`).
- Events become readable after the Worker next publishes an archive, about 10 minutes by default. `slurp sync --now` publishes first (admin token).
