# Slurp for Swift

Event capture for [Slurp](https://slurp.run) on iOS, macOS, tvOS and watchOS. Events go to the Worker in your own Cloudflare account; `slurp sync` pulls them into DuckDB for your coding agent. Foundation only, no dependencies.

In Xcode: **File → Add Package Dependencies…** and enter `https://github.com/hitSlop/slurp`, or in `Package.swift`:

```swift
.package(url: "https://github.com/hitSlop/slurp", from: "0.1.0")
// target dependency: .product(name: "Slurp", package: "slurp")
```

`slurp init` prints your ingest URL, source ID and publishable key (`slurp_pk_…`, ingest-only, safe to ship in an app).

```swift
import Slurp

var configuration = SlurpClient.Configuration(
    key: "slurp_pk_…",
    endpoint: URL(string: "https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events")!,
    sourceId: "src_…")
SlurpClient.configure(configuration)

SlurpClient.shared.screen("Home")
SlurpClient.shared.track("purchase_completed", ["total": 49])
SlurpClient.shared.identify("user-42", traits: ["plan": "pro"])
```

`SlurpClient(configuration)` creates an independent client instead of the shared one. All methods are thread safe and return immediately.

## Events survive the app being killed

Every event is appended to a file in Application Support before anything is sent. A batch is written to its own file before its first upload and deleted only after the Worker acknowledges it, so a kill, a crash or a dead network never loses an event, and a retry sends the identical bytes (the Worker drops a duplicate it already stored). The visitor identity, signed-in user and session persist too. A crash while writing the queue can at worst leave a duplicate (same id, which the archive deduplicates) or a half-written last line, which is ignored.

Events are sent when `flushAt` (100) are queued, every `flushInterval` (5 s) while the app runs, when the app resigns active, enters the background or quits, and when it becomes active again. Failures back off with jitter and honor `Retry-After`, including across launches. A 413 splits the batch, a 400 drops it, and a 401/403 stops the client and discards its queue (the key is wrong or revoked). Events are never truncated; one larger than 1 MiB is refused and reported through `onError`.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `sourceId` | none | Include it so the visitor identity survives a key rotation |
| `flushAt`, `flushInterval` | 100, 5 s | When to send |
| `maxBatchEvents`, `maxBatchBytes` | 1000, 921,600 | Batch size; an event larger than the byte target travels alone |
| `maxQueue` | 10,000 | Events kept while offline; the oldest are dropped and reported |
| `sessionTimeout` | 1800 s | Inactivity before a new session starts |
| `context` | none | Closure returning extra context merged over the automatic one |
| `onError` | none | `(Error, dropped: Int)`; `dropped` is zero when work is kept for a retry |
| `flushOnBackground` | true | Send when the app leaves the foreground |
| `session`, `directory` | shared session, Application Support | Inject your own `URLSession` or queue folder |

Every event carries `context.os`, `context.device.model`, `context.app` (version, build, bundle id), `context.locale`, `context.timezone` and `context.library`. `flush()` is `async`, or pass a completion handler; its result has `accepted`, `rejected`, `pending`, `retryAt` and `stopped`. `reset()` forgets the user and starts a new visitor and session.

## Develop

```sh
swift test                         # from the repository root (what package users resolve)
cd sdks/swift && swift test        # the package on its own
SLURP_TEST_ENDPOINT=http://127.0.0.1:8787/v1/events SLURP_TEST_KEY=slurp_pk_… swift test --filter RealWorker
```

The unit tests stub the network with a `URLProtocol`. The last test sends to a real Worker when the two environment variables are set. It has been run against a local Worker; it has not yet been run inside an app on a device.

## License

MIT
