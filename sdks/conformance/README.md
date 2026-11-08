# SDK delivery conformance

This is what a Slurp SDK implements to deliver events: a durable queue, one send loop, and a fixed reaction to every answer. Wire formats (the record, the request, the responses, the credentials) are in [`docs/contracts.md`](../../docs/contracts.md): read "Credentials", "Sending events" and "SDK delivery" there first. [`delivery.json`](delivery.json) holds the executable scenarios; every SDK runs all of them (the JS and React Native runners are `sdks/js/test/conformance-runner.ts`, the Swift one is in `sdks/swift/Tests`). When you find a delivery bug, add a scenario there before you fix it.

The design rests on one fact: **the Worker does not deduplicate requests, the import does** (by source and event id). So an SDK only has to make sure that every record is eventually sent at least once, with the same `id` every time. It does not have to resend identical request bytes, so it keeps no frozen batches: a request is just the first lines of the queue.

## What a client holds

| Thing | Persisted | Notes |
|---|---|---|
| `anonymousId`, `sessionId`, `lastActivity`, `userId?` | yes | The visitor. Survives restarts |
| `queue` | yes | One serialized JSON record (one line, no newline inside) per event, oldest first. Lines are final: ids and timestamps are generated when the event is captured and never change |
| `retryAt`, `attempts` | yes | The earliest time to send again (epoch ms, 0 for none), and how many failed attempts in a row |
| `version` | yes | `1` |
| in-flight count `k` | no | The first `k` lines belong to the request being answered |
| split limit | no | Most lines the next request may take. Unlimited at start; halved by a 413; unlimited again after a 2xx |
| stopped | no | Set by a 401 or 403. Lives and dies with this client instance |
| flush timer | no | One timer holding the earliest deadline |

The saved value is `{version: 1, anonymousId, sessionId, lastActivity, userId?, queue: [line…], retryAt, attempts}` and nothing else (no batches, no stop flag), under the key

```
<id>:v1:<endpoint, with no query, hash or trailing slash>:<project hex>:<source>
```

where `<id>` is the SDK's own prefix, and the project hex and source come from the publishable key with `^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_([0-9a-f]{48})$`. A key that does not parse is used whole. So rotating a key (another key for the same source) keeps the queue and the visitor, and two senders sharing a storage never send each other's events. On load, drop saved lines that are not one complete JSON object, and report them as dropped.

## States

A client moves Loading, then Idle or Queued; Queued to Sending when a flush starts; Sending back to Sending while lines remain, to Idle when the queue is empty, to Waiting after a retryable failure, or to Stopped when the key is refused; Waiting to Sending once `retryAt` has passed. `close()` leads to Closed from any state.

| State | Meaning |
|---|---|
| Loading | The saved state is being read. Captures wait and are applied in order once it is read, so nothing is lost and nothing is applied to the wrong state |
| Idle | Nothing queued |
| Queued | Lines waiting; the flush timer is armed |
| Sending | One request is in flight with the first `k` lines. At most one request at a time |
| Waiting | A send failed; nothing is sent before `retryAt`. The lines stay queued |
| Stopped | The key was refused. Every capture is dropped and reported. Not saved |
| Closed | `close()` was called: timers, listeners and the request are cancelled and the state is saved once more |

## Transitions

| Trigger | Does |
|---|---|
| capture (`track`, `identify`) | Validate (below), advance the identity, build and append one line, trim, save. Send now if the queue has `flushAt` (default 100) lines and `retryAt` has passed; otherwise arm the flush timer for `flushIntervalMs` (default 5 s), or for `retryAt` if that is later |
| flush timer, `flush()`, page hide, app backgrounds | Run the send loop. A page hide sends one request only (see rules) |
| send loop | While there is a line, no `retryAt` in the future, and the client is not stopped or closed: take a request, send it, react to the answer |
| answer | See the table below |
| `reset()` | New `anonymousId` and `sessionId`, no `userId`; saves |
| `close()` | Cancel everything, save, and let a client created later for the same storage wait for that save |

**Taking a request.** `k` lines from the front of the queue, where `k ≤ maxBatchEvents` (1000), `k ≤` the split limit, and the lines total at most `maxBatchBytes` (900 KiB, counting a newline per line). The first line always goes, even when it alone is larger. The body is the lines joined by `\n` with a trailing `\n`. Mark the `k` lines in flight.

**Reacting to the answer** (`k` lines were sent):

| Answer | Action |
|---|---|
| 2xx | Remove the `k` lines. Reset the split limit, `retryAt` and `attempts`. Count `k` as accepted. Save. Carry on |
| 400 with a JSON body whose `rejected` lists `{line, reason}` | Remove exactly the listed lines (1-based within this request; ignore numbers outside `1..k`). Report them as dropped. The other lines stay queued: send them at once, no waiting. When no listed number is valid, treat it as any other 400 |
| any other 400, and every 4xx not named in this table | Remove the `k` lines. Report them as dropped. Carry on |
| 413 | Halve the split limit to `ceil(k / 2)`; the lines stay queued. When `k = 1`, remove and report that single line instead. Carry on |
| 401, 403 | Remove every queued line and report all of them as dropped. Stop this client instance. Save the (now empty) queue. Nothing about the stop is saved, so the next client on this storage starts normally |
| 408, 429, 5xx, network error, timeout | Keep the lines. `attempts += 1`. `retryAt = now + delay`, where the delay is the `Retry-After` of a 429 or 503 (digits of seconds, or an HTTP date; a date in the past means 0), and otherwise `min(500 ms · 2^(attempts-1), 60 s)` times a random factor between 0.5 and 1. Save. Stop the loop and arm the timer for `retryAt` |

The request **timeout** (default 30 s) aborts the request and counts as a network error. Release the in-flight marker whenever a request ends without removing its lines.

## Rules

1. **The flush timer keeps the earliest deadline.** A capture arms the timer only if none is armed for an earlier time. A stream of captures never postpones a flush.
2. **Overflow never drops lines in flight.** After a capture, while the queue has more than `maxQueue` lines (default 10 000) or more than `maxQueueBytes` bytes (4 MiB; 2 MiB in React Native), remove the oldest line that is **not** in flight, and report the count as dropped. Lines in flight are removed only by the answer.
3. **Saving never blocks sending.** A save that fails (the storage throws) is reported once, until a later save works, and delivery carries on from memory. The events survive as long as the process does.
4. **Saves are ordered and the last one wins.** A client created for a storage whose previous client was just closed (`init` twice) waits for that client's last save before it reads. Nothing is lost and nothing is duplicated.
5. **Retries carry the same records.** A line is never rebuilt: same `id`, same bytes every time it is sent. The request around them may differ, because the queue may have changed in between.
6. **Page hide** (browsers) sends one request with `?key=<publishable key>` in the URL instead of an `Authorization` header (`Content-Type: text/plain`, `keepalive: true`), of at most 60 KB. A first line bigger than that waits for a normal send.
7. **Validate only what the Worker validates** (see Capturing) and never invent a limit of your own.
8. **Closed means closed.** After `close()` a capture is dropped and reported.

## Capturing

- `track(event, data?, overrides?)` returns the new event's `id` at once (a UUIDv7), even when the event is dropped for being invalid.
- An event name is 1 to 200 Unicode code points, counted as code points (not UTF-16 units or bytes) and well-formed UTF-16. This is the only check that can disagree with the Worker, so it follows the Worker exactly: the JS runner checks it against `backend/fixtures/canonical/records.json`.
- `data` is a JSON object; `context` is a JSON object that must not contain `geo`. A record is at most 1 MiB; a bigger one is dropped and reported, never truncated.
- The SDK always sets `id`, `timestamp` (RFC 3339, from the clock at capture) and, for a track, `type`; `anonymous_id`, `session_id` and `user_id` come from the identity unless the caller overrides them for one record. The user cannot set `id` or `timestamp`.
- **Identity.** A new `anonymousId` and `sessionId` come from `reset()`, or when `identify` switches from one known user to a different one. The first `identify` keeps both, so earlier anonymous activity links to the user. A new session starts when `now - lastActivity >= sessionTimeoutMs` (default 30 minutes), using `>=`. `lastActivity` is set at every capture.

## The scenario file

`delivery.json` documents its own format in its `description`. A new SDK needs: a way to make a client with options and a fake `fetch` that answers from a script, a storage the runner can make fail or slow, and a way to restart (close, then create another client on the same storage). Run the scenarios in order; each is independent. The scenarios that take real time are the `Retry-After` ones (about 1 to 2 s each) and the flush-timer one (about 1 s).

Not covered by scenarios because they need a real page or app: page-hide keepalive (see `sdks/js/test/delivery.test.ts`), and the app lifecycle hooks of React Native and Swift.
