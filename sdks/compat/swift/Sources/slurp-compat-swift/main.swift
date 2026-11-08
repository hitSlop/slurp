// Drives Segment's analytics-swift against a Slurp Worker the way docs/sdks.md tells people to.
//
//   slurp-compat-swift WORKER_URL PUBLISHABLE_KEY SCENARIO STORAGE_DIR
//
// Scenarios:
//   deliver         identify, track and screen, then flush until the queue is empty
//   queue-offline   the same events, one flush, then exit (point WORKER_URL at a closed port)
//   deliver-queued  capture nothing; flush whatever an earlier run left in STORAGE_DIR until the queue is empty
//   flush3          the same events, then three flushes in a row, reporting the queue after each (with a revoked key, or a rotated one)
//
// Prints one JSON line describing what the SDK itself saw: every request it made, the errors it reported, and how many batches were
// still queued on disk at each point. What the Worker stored is checked by the test. Exits 2 if the SDK ever tried to contact Segment.
import Foundation
import Segment

setvbuf(stdout, nil, _IOLBF, 0)

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 5 else { die("usage: slurp-compat-swift WORKER_URL PUBLISHABLE_KEY SCENARIO STORAGE_DIR") }
let (workerURL, writeKey, scenario, storageDir) = (args[1], args[2], args[3], args[4])
guard let worker = URL(string: workerURL), let workerHost = worker.host else { die("bad WORKER_URL \(workerURL)") }
let hostPort = worker.port.map { "\(workerHost):\($0)" } ?? workerHost

// Everything below runs on several queues; one lock guards the shared log.
final class Log {
    private let lock = NSLock()
    private var requests: [[String: String]] = []
    private var forbidden: [String] = []
    private var errors: [String] = []
    private var processed = 0
    func request(_ entry: [String: String]) { lock.lock(); requests.append(entry); lock.unlock() }
    func forbid(_ url: String) { lock.lock(); forbidden.append(url); lock.unlock() }
    func error(_ text: String) { lock.lock(); errors.append(text); lock.unlock() }
    func processedOne() { lock.lock(); processed += 1; lock.unlock() }
    func snapshot() -> (requests: [[String: String]], forbidden: [String], errors: [String], processed: Int) {
        lock.lock(); defer { lock.unlock() }
        return (requests, forbidden, errors, processed)
    }
}
let log = Log()

/// Counts events once they have passed every destination, so the harness knows when they are on disk.
final class Counter: Plugin {
    let type = PluginType.after
    weak var analytics: Analytics?
    func execute<T: RawEvent>(event: T?) -> T? { if event != nil { log.processedOne() }; return event }
}

// analytics-swift always builds https:// URLs; the local Worker speaks http, so requestFactory (the SDK's documented hook for
// proxies) rewrites the scheme. It also sees every request the SDK builds: one aimed at Segment is recorded and sent nowhere.
let configuration = Configuration(writeKey: writeKey)
    .apiHost("\(hostPort)/v1")
    .cdnHost("\(hostPort)/v1")
    .flushAt(1)
    .flushInterval(3600)
    // Where the SDK keeps its queue by default is <Application Support>/segment/<write key>/; the same layout, under STORAGE_DIR.
    .storageMode(.diskAtURL(URL(fileURLWithPath: storageDir, isDirectory: true).appendingPathComponent(writeKey, isDirectory: true)))
    .setTrackedApplicationLifecycleEvents(.none)
    .errorHandler { log.error(String(describing: $0)) }
    .requestFactory { request in
        var request = request
        guard let url = request.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return request }
        let host = url.host ?? ""
        log.request(["method": request.httpMethod ?? "GET", "host": host, "path": url.path])
        if host.contains("segment") {
            log.forbid(url.absoluteString)
            request.url = URL(string: "http://127.0.0.1:1/blocked")
        } else if worker.scheme == "http" && parts.scheme == "https" {
            parts.scheme = "http"
            request.url = parts.url
        }
        return request
    }

func spin(for seconds: TimeInterval, until done: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while !done() {
        if Date() > end { return false }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    return true
}

final class Flag {
    private let lock = NSLock()
    private var on = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return on }
    func set() { lock.lock(); on = true; lock.unlock() }
}

// Explicit flushes must own their uploads in the repeated-flush scenario.
if scenario == "flush3" { configuration.flushPolicies([]) }
let analytics = Analytics(configuration: configuration)
analytics.add(plugin: Counter())

var notes: [String] = []
// Wait for the settings request (it succeeds or fails) before capturing: events captured earlier wait in the SDK's startup queue.
let started = spin(for: 30) { analytics.find(pluginType: StartupQueue.self)?.running == true }
if !started { notes.append("startup did not finish in 30s") }

func pending() -> Int { analytics.pendingUploads?.count ?? 0 }
/// Flush and wait for the SDK to say it is done (its completion runs on a background queue; this thread keeps the main run loop turning).
func flushOnce(timeout: TimeInterval = 30) -> Bool {
    let done = Flag()
    analytics.flush { done.set() }
    return spin(for: timeout) { done.value }
}
func capture() {
    analytics.identify(userId: "user_42", traits: ["plan": "pro", "email": "ada@example.com"])
    analytics.track(name: "signed_up", properties: ["plan": "pro", "total": 49])
    analytics.screen(title: "Home", category: "App", properties: ["tab": "main"])
    if !spin(for: 15, until: { log.snapshot().processed >= 3 }) { notes.append("events were not all processed in 15s") }
}
func drain(timeout: TimeInterval = 30) {
    let end = Date().addingTimeInterval(timeout)
    while pending() > 0 && Date() < end {
        if !flushOnce() { notes.append("a flush did not complete") }
        _ = spin(for: 0.25) { false }
    }
}

var summary: [String: Any] = ["scenario": scenario]
summary["pendingAtStart"] = pending()
// The SDK's built-in defaults only say `"Segment.io": true`; an apiKey here can only have come from a settings response.
summary["settingsApiKey"] = analytics.settings()?.integrationSettings(forKey: "Segment.io")?["apiKey"] as? String ?? NSNull()
switch scenario {
case "deliver":
    capture(); drain()
case "queue-offline":
    capture(); _ = flushOnce()
case "deliver-queued":
    drain()
case "flush3":
    capture()
    var steps: [[String: Int]] = []
    for _ in 1...3 {
        if !flushOnce() { notes.append("an explicit flush did not complete"); break }
        let posts = log.snapshot().requests.filter { $0["method"] == "POST" }.count
        steps.append(["batchPosts": posts, "pending": pending()])
    }
    summary["afterEachFlush"] = steps
default:
    die("unknown scenario \(scenario)")
}

let seen = log.snapshot()
summary["pendingAtEnd"] = pending()
summary["requests"] = seen.requests
summary["errors"] = seen.errors
summary["forbidden"] = seen.forbidden
summary["notes"] = notes
summary["library"] = analytics.version()
print(String(data: try! JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]), encoding: .utf8)!)
exit(seen.forbidden.isEmpty ? 0 : 2)
