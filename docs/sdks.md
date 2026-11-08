# SDKs and compatibility

Slurp takes events from its own SDKs, from plain HTTP, and from the Segment and Sentry SDKs you may already use: point them at your Worker and change nothing else. Everything lands in the same archive, and `slurp sync` pulls it into one DuckDB table.

Every SDK takes two values, the **ingest URL** and the **publishable key** (see below for where they come from). Below, `WORKER` is your Worker's origin (`https://slurp.YOUR-SUBDOMAIN.workers.dev`) and `HOST` is the same without `https://`.

## Where the endpoint and key come from

You never make either by hand. Run `slurp init` inside your app: it creates the project on your Worker, and the Worker creates the project's first **publishable key** in the same step (named `default`). `slurp init` then prints, and the setup page it opens shows, the two values:

- **Ingest URL**: your Worker's address plus `/v1/events`, for example `https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events`.
- **Publishable key**: `slurp_pk_<project>_<random>`. It can only add events to that one project, so it is safe in a web page or an app. The key itself says which project the events belong to and which sender they come from; there is no third value to pass.

Print them again whenever you need them, and make more:

```sh
slurp project setup PROJECT                      # the ingest URL and the project's publishable keys; changes nothing
slurp project key list PROJECT --scope publishable
slurp project key create PROJECT --scope publishable --name ios    # one key per sender
slurp project key revoke PROJECT KEY_ID                            # stops that key at once
```

Give each place that sends its own key (`web`, `ios`, `github`): the name you choose is stamped on every event it sends as `sender`, so a query can tell them apart. The other two credentials are not for apps: a **secret key** (`slurp_sk_…`) reads one project's archives, for bots, and the **admin token** controls the whole Worker and stays on your machine. [How the connection works](connection.md) explains all three.

## What works

| | Package or setup | Status |
| --- | --- | --- |
| [JavaScript and TypeScript](../sdks/js) | `npm install @hitslop/slurp-sdk` | Published. Browser and Node. Tested against a real Worker |
| [React Native and Expo](../sdks/react-native) | `npm install @hitslop/slurp-react-native @react-native-async-storage/async-storage` | Tested against fakes of the React Native APIs; not yet run on a device |
| [Swift](../sdks/swift) | Add `https://github.com/hitSlop/slurp` in Xcode | Unit tested, and run against a local Worker; not yet in an app on a device |
| Segment SDKs | Change the host (below) | Verified with `@segment/analytics-node`, `@segment/analytics-next` (single and batching), `analytics-swift` and **`segment-analytics-python`** 2.4.0 |
| Sentry SDKs | Change the DSN (below) | Verified with `@sentry/node`, `@sentry/browser` and **`sentry-sdk` for Python** 2.74.0 |
| Python | `pip install segment-analytics-python` or `sentry-sdk`, then change the host or DSN (below) | Both run unmodified against a local Worker on Python 3.9, 3.12 and 3.14 (`backend/test/compat-python.test.ts`). There is no native Python SDK |
| HTTP, any language | `POST /v1/events` | Tested |
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

In Xcode choose **File → Add Package Dependencies…** and enter `https://github.com/hitSlop/slurp`. The package is the `Slurp` product; its version is the repository's release tag.

```swift
import Slurp

SlurpClient.configure(.init(key: "slurp_pk_…", endpoint: URL(string: "WORKER/v1/events")!))
SlurpClient.shared.screen("Home")
SlurpClient.shared.track("purchase_completed", ["total": 49])
```

Events are written to disk before they are sent and uploaded in byte-identical batches. Details: [sdks/swift](../sdks/swift/README.md).

### HTTP

POST newline-delimited JSON to `WORKER/v1/events` with `Authorization: Bearer slurp_pk_…`. Required per record: `id`, `type` (`track` or `identify`), `timestamp` (RFC 3339) and `data`; `track` needs `event`, `identify` needs `user_id`. A record may be up to 1 MiB and is stored whole. See [architecture](architecture.md#contracts).

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

Set both hosts in Swift: without `cdnHost` the SDK fetches its settings from Segment's CDN and can send events there instead.

What the Worker accepts: `POST /v1/t`, `/v1/i`, `/v1/p`, `/v1/s`, `/v1/g`, `/v1/a`, `/v1/b` and `/v1/batch`, `GET /v1/projects/<key>/settings`, and CORS preflights. The write key may arrive as Basic auth, in the body (`writeKey`) or as `?key=`.

How messages are stored:

| Segment | Slurp |
| --- | --- |
| `track` | `track` event; `properties` become `data` |
| `identify` | `identify`; `traits` become `data` (an identify with no `userId` becomes a `track` named `identify`) |
| `page`, `screen` | `track` events named `page` and `screen`; `properties`, `name` and `category` in `data` |
| `group`, `alias` | `track` events named `group` and `alias`; `group_id` or `previous_id` in `data` |
| `messageId` | `id`; if missing, a hash of the event, so a retry deduplicates |
| `userId`, `anonymousId`, `timestamp`, `context` | `user_id`, `anonymous_id`, `timestamp`, `context` |
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

`user.id` (else email, then username) becomes `user_id`; `context.library` names the Sentry SDK; `context.compat` is `sentry`. Read errors with the `errors` view, which pulls the exception, where it was thrown, release, environment and a grouping key out of the stored event when you query:

```sql
SELECT group_key, any_value(exception_type) AS type, any_value(message) AS message,
       count(*) AS n, count(DISTINCT user_id) AS users
FROM errors GROUP BY group_key ORDER BY n DESC LIMIT 20;
```

What this is not: Sentry does server-side work Slurp does not. There is no source-map or native symbolication, so browser stack traces stay minified and native frames stay as addresses (the debug ids to symbolicate them are kept in `data`, and symbolicating locally from your own build output is planned); `group_key` is a best-effort hash of the exception type and in-app frames, similar to but not the same as Sentry's issue grouping; there is no issue UI, alerting, release health or performance monitoring; Sentry's rate-limit headers are not implemented.

## Limits that apply to every path

- A record can be up to 1 MiB and is never truncated. A larger one is refused with `413` (or skipped, on the Segment and Sentry paths).
- Duplicates are harmless: a retry of identical bytes is recognised by the Worker, and `slurp sync` keeps one row per event `id`.
- Events become readable after the next archive seal, about 10 minutes by default.
