# SDKs

Libraries that send events to your Slurp Worker. All of them write the same record (see the [event format](../docs/architecture.md)) and share the same delivery rules: a queue that is durable by default in browsers (`localStorage`), React Native (AsyncStorage) and Swift (a file) and opt-in in Node (`fileStorage`, see [the JS SDK](js/README.md)), batching, retries that resend the same events (every event has an id, and the import keeps each one once, so a retry never double counts), and no truncation.

| SDK | Package | Status |
| --- | --- | --- |
| [JavaScript and TypeScript](js) | `@hitslop/slurp-sdk` on npm | Published. Browser and Node |
| [React Native and Expo](react-native) | `@hitslop/slurp-react-native` on npm | Written and tested against fakes; not yet run on a device |
| [Swift](swift) | Swift package: add `https://github.com/hitSlop/slurp` in Xcode, then `import Slurp` | Written; unit tests and a run against a local Worker pass; not yet run in an app on a device |

Already using Segment or Sentry? You do not need an SDK: point their SDK at your Worker. See [Connections and compatibility](../docs/sdks.md).

**Delivery conformance.** Every SDK runs the same scenarios in [`conformance/delivery.json`](conformance/delivery.json): status handling (2xx, 400 with and without a `rejected` list, 401/403, 408, 413 splitting, 429 and 503 with `Retry-After`, 5xx, network errors), retries carrying the same records, restarts, batching by count and bytes, queue overflow, storage failures and what is reported as dropped. [`conformance/README.md`](conformance/README.md) is the delivery state machine a new SDK implements; the wire formats are in [`docs/contracts.md`](../docs/contracts.md). When a delivery bug is found in one SDK, add a scenario there so all of them (and any new one) get the test.

