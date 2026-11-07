import Foundation

/// Event capture for Slurp. Events are written to disk before anything is sent, so they survive the app being killed,
/// and are uploaded in batches to your Worker. Thread safe: call it from anywhere.
///
///     let slurp = SlurpClient(.init(key: "slurp_pk_…", endpoint: URL(string: "https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events")!))
///     slurp.track("purchase_completed", ["total": 49])
public final class SlurpClient: @unchecked Sendable {
    public struct Configuration {
        /// Your publishable key (`slurp_pk_…`): ingest only, safe to ship in an app.
        public var key: String
        public var endpoint: URL
        /// Send when this many events are queued.
        public var flushAt = 100
        /// Send at least this often (seconds) while the app is running.
        public var flushInterval: TimeInterval = 5
        public var maxBatchEvents = 1000
        /// A batch is filled up to about this many bytes; an event larger than that travels alone.
        public var maxBatchBytes = 921_600
        /// Events kept while offline. The oldest are dropped (and reported) beyond this.
        public var maxQueue = 10_000
        /// Bytes kept while offline, counting queued events and batches not yet acknowledged. The oldest are dropped (and reported)
        /// beyond this. Events can be up to 1 MiB each, so a count limit alone is not a size limit.
        public var maxQueueBytes = 50 * 1024 * 1024
        /// A request with no answer after this many seconds is cancelled and retried with the same bytes.
        public var requestTimeout: TimeInterval = 30
        /// A new session starts after this much inactivity (seconds).
        public var sessionTimeout: TimeInterval = 1800
        /// Extra context merged over the automatic device and app context. Called on the thread that records the event.
        public var context: (() -> [String: Any])?
        /// Called when an event is refused or dropped. `dropped` is zero when work is kept for a retry. Runs on a queue of its own,
        /// never the SDK's, so it is safe to call back into the client (read `pending`, `flush`, `close`) from here.
        public var onError: ((Error, _ dropped: Int) -> Void)?
        /// Send when the app goes to the background and when it quits. On by default.
        public var flushOnBackground = true
        public var session: URLSession = .shared
        /// Where the queue lives. Defaults to Application Support/Slurp/<endpoint and source>.
        public var directory: URL?

        public init(key: String, endpoint: URL) {
            self.key = key
            self.endpoint = endpoint
        }
    }

    /// Cumulative counts for this client, plus what is still waiting.
    public struct FlushResult: Equatable {
        public var accepted: Int
        public var rejected: Int
        public var pending: Int
        /// When the next send is allowed after a failure, or nil.
        public var retryAt: Date?
        /// True after a 401/403 (the key is wrong or revoked) or `close()`.
        public var stopped: Bool
    }

    // MARK: default instance

    private static let sharedLock = NSLock()
    private static var sharedClient: SlurpClient?

    /// The client created by `configure`.
    public static var shared: SlurpClient {
        sharedLock.lock(); defer { sharedLock.unlock() }
        guard let client = sharedClient else { fatalError("call SlurpClient.configure(_:) before using SlurpClient.shared") }
        return client
    }

    /// Create (or replace) the default client.
    @discardableResult
    public static func configure(_ configuration: Configuration) -> SlurpClient {
        let client = SlurpClient(configuration)
        sharedLock.lock()
        let old = sharedClient
        sharedClient = client
        sharedLock.unlock()
        old?.close()
        return client
    }

    // MARK: state (touched only on `queue`)

    private let config: Configuration
    private let queue = DispatchQueue(label: "run.slurp.client")
    /// Application callbacks (`onError`, flush completions) run here, so nothing the app does in one can block or re-enter `queue`.
    private let callbackQueue = DispatchQueue(label: "run.slurp.callbacks")
    private let store: DurableQueue
    private let uploader: Uploader
    private var state: DurableQueue.State
    private var accepted = 0
    private var rejected = 0
    private var sending = false
    private var closed = false
    private var timer: DispatchWorkItem?
    private struct Waiter { var call: (FlushResult) -> Void; var onCallbackQueue: Bool }
    private var waiters: [Waiter] = []
    private var observers: [NSObjectProtocol] = []

    public convenience init(_ configuration: Configuration) {
        self.init(configuration, store: nil)
    }

    /// `store` lets tests supply a queue whose disk operations can be made to fail.
    init(_ configuration: Configuration, store injected: DurableQueue?) {
        config = configuration
        var startupProblems: [(Error, Int)] = []
        var queueStore = injected
        if queueStore == nil {
            let directory = configuration.directory ?? SlurpClient.defaultDirectory(for: configuration)
            queueStore = try? DurableQueue(directory: directory)
        }
        if queueStore == nil {
            // Without a writable directory events still flow, they just are not durable.
            let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("slurp-\(UUID().uuidString)")
            queueStore = try? DurableQueue(directory: fallback)
            startupProblems.append((NSError(domain: "Slurp", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not create the queue directory; events will not survive a restart"]), 0))
        }
        store = queueStore!
        uploader = Uploader(session: configuration.session, endpoint: configuration.endpoint, key: configuration.key, timeout: configuration.requestTimeout)
        let now = Date().timeIntervalSince1970
        var restored = store.loadState() ?? DurableQueue.State(anonymousId: Ids.uuidv7(), sessionId: Ids.uuidv7(), lastActivity: now)
        // A replaced key starts clean: it must not inherit the "stopped" state that the old, refused key left behind.
        let fingerprint = SlurpClient.fingerprint(configuration.key)
        if restored.keyFingerprint != fingerprint {
            if restored.stopped { restored.stopped = false; restored.attempts = 0; restored.retryAt = 0 }
            restored.keyFingerprint = fingerprint
        }
        state = restored
        store.save(state)
        if store.recoveredDropped > 0 {
            startupProblems.append((NSError(domain: "Slurp", code: 5, userInfo: [NSLocalizedDescriptionKey: "dropped \(store.recoveredDropped) damaged line(s) from the saved queue"]), store.recoveredDropped))
        }
        // The saved queue may be larger than the limits now in force.
        let trimmed = store.enforceLimits(maxEvents: configuration.maxQueue, maxBytes: configuration.maxQueueBytes)
        if trimmed > 0 {
            startupProblems.append((NSError(domain: "Slurp", code: 4, userInfo: [NSLocalizedDescriptionKey: "the saved queue was over its limits; dropped the oldest events"]), trimmed))
        }
        rejected += startupProblems.reduce(0) { $0 + $1.1 }
        for problem in startupProblems { callbackQueue.async { configuration.onError?(problem.0, problem.1) } }
        queue.async {
            // Resume whatever a previous run left behind (respecting any retry deadline).
            if self.state.stopped { return }
            if self.store.pendingCount() > 0 { self.pump() }
        }
        if configuration.flushOnBackground { observeLifecycle() }
    }

    deinit { for token in observers { NotificationCenter.default.removeObserver(token) } }

    /// A short stable fingerprint of a key (FNV-1a), so the saved state can tell that the key was replaced without storing the key.
    private static func fingerprint(_ key: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(hash, radix: 16)
    }

    /// A Slurp key names its project (`slurp_pk_<project>_<random>`), so saved state belongs to the project and survives replacing the
    /// key. A key of any other shape is its own identity.
    static func identity(of key: String) -> String {
        let parts = key.split(separator: "_", omittingEmptySubsequences: false)
        let hex = Set("0123456789abcdef")
        guard parts.count == 4, parts[0] == "slurp", parts[1] == "pk", parts[2].count == 16, parts[3].count == 48,
              parts[2].allSatisfy({ hex.contains($0) }), parts[3].allSatisfy({ hex.contains($0) }) else { return key }
        return String(parts[2])
    }

    private static func defaultDirectory(for configuration: Configuration) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        // FNV-1a: a short, stable folder name without needing CryptoKit.
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in "\(configuration.endpoint.absoluteString)|\(Self.identity(of: configuration.key))".utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return base.appendingPathComponent("Slurp", isDirectory: true).appendingPathComponent(String(hash, radix: 16), isDirectory: true)
    }

    // MARK: capture

    /// Record an event. Returns its id immediately; the event is durable once this call's work has run on the client's queue.
    @discardableResult
    public func track(_ event: String, _ properties: [String: Any] = [:]) -> String {
        capture(type: "track", event: event, data: properties, userId: nil)
    }

    /// Link the visitor to a user and record the traits. Later events carry `user_id`. Switching between known users starts a new visitor and session.
    @discardableResult
    public func identify(_ userId: String, traits: [String: Any] = [:]) -> String {
        capture(type: "identify", event: nil, data: traits, userId: userId)
    }

    /// Record that a screen was shown: an event named `screen` with `name` in its data.
    @discardableResult
    public func screen(_ name: String, _ properties: [String: Any] = [:]) -> String {
        var data = properties
        data["name"] = name
        return capture(type: "track", event: "screen", data: data, userId: nil)
    }

    private func capture(type: String, event: String?, data: [String: Any], userId: String?) -> String {
        let id = Ids.uuidv7()
        let at = Date()
        // The app's closure runs here, on the caller's thread, never inside the SDK queue where it could re-enter the client.
        let extraContext = config.context?() ?? [:]
        queue.async {
            if self.closed || self.state.stopped { return self.report(NSError(domain: "Slurp", code: 2, userInfo: [NSLocalizedDescriptionKey: "client is closed or stopped; event dropped"]), dropped: 1) }
            var next = self.state
            if let userId = userId, userId.isEmpty { return self.report(EventError.invalidData("userId must be a non-empty string"), dropped: 1) }
            if at.timeIntervalSince1970 - next.lastActivity > self.config.sessionTimeout { next.sessionId = Ids.uuidv7() }
            if let userId = userId {
                if let current = next.userId, current != userId { next.anonymousId = Ids.uuidv7(); next.sessionId = Ids.uuidv7() }
                next.userId = userId
            }
            var context = DeviceContext.make()
            for (key, value) in extraContext { context[key] = value }
            let line: String
            do {
                line = try EventEncoder.line(id: id, type: type, event: event, timestamp: at, userId: next.userId, anonymousId: next.anonymousId, sessionId: next.sessionId, data: data, context: context)
            } catch {
                return self.report(error, dropped: 1) // invalid input never changes identity
            }
            next.lastActivity = at.timeIntervalSince1970
            let identityChanged = next.anonymousId != self.state.anonymousId || next.sessionId != self.state.sessionId || next.userId != self.state.userId
            self.state = next
            if identityChanged { self.store.save(next) }
            if !self.store.append(line) { self.report(NSError(domain: "Slurp", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not write the event to disk; it is kept in memory only"]), dropped: 0) }
            let dropped = self.store.enforceLimits(maxEvents: self.config.maxQueue, maxBytes: self.config.maxQueueBytes)
            if dropped > 0 { self.report(NSError(domain: "Slurp", code: 4, userInfo: [NSLocalizedDescriptionKey: "queue full; dropped the oldest events"]), dropped: dropped) }
            if self.store.queued.count >= self.config.flushAt && self.state.retryAt <= Date().timeIntervalSince1970 { self.pump() }
            else { self.schedule(after: max(self.config.flushInterval, self.state.retryAt - Date().timeIntervalSince1970)) }
        }
        return id
    }

    /// Forget the user and start a new visitor and session.
    public func reset() {
        queue.async {
            self.state.userId = nil
            self.state.anonymousId = Ids.uuidv7()
            self.state.sessionId = Ids.uuidv7()
            self.state.lastActivity = Date().timeIntervalSince1970
            self.store.save(self.state)
        }
    }

    // MARK: delivery

    /// Send everything queued. The completion runs when it is all acknowledged, a retry has been scheduled, or the client stopped.
    public func flush(completion: ((FlushResult) -> Void)? = nil) {
        queue.async {
            if let completion = completion { self.waiters.append(Waiter(call: completion, onCallbackQueue: true)) }
            self.pump()
        }
    }

    public func flush() async -> FlushResult {
        await withCheckedContinuation { continuation in flush { continuation.resume(returning: $0) } }
    }

    /// Events waiting to be acknowledged.
    public var pending: Int { queue.sync { store.pendingCount() } }

    /// Stop timers and listeners and persist state. Call `flush()` first for a normal shutdown.
    public func close() {
        queue.sync {
            closed = true
            timer?.cancel()
            store.save(state)
            for token in observers { NotificationCenter.default.removeObserver(token) }
            observers = []
            finishWaiters()
        }
    }

    private func result() -> FlushResult {
        let now = Date().timeIntervalSince1970
        return FlushResult(accepted: accepted, rejected: rejected, pending: store.pendingCount(), retryAt: state.retryAt > now ? Date(timeIntervalSince1970: state.retryAt) : nil, stopped: closed || state.stopped)
    }

    private func finishWaiters() {
        guard !waiters.isEmpty else { return }
        let done = waiters
        waiters = []
        let outcome = result()
        for waiter in done {
            if waiter.onCallbackQueue { callbackQueue.async { waiter.call(outcome) } } else { waiter.call(outcome) }
        }
    }

    private func schedule(after delay: TimeInterval) {
        timer?.cancel()
        guard !closed, !state.stopped else { return }
        let item = DispatchWorkItem { [weak self] in self?.pump() }
        timer = item
        queue.asyncAfter(deadline: .now() + max(0, delay), execute: item)
    }

    /// Tell the app about a problem; `dropped` events count as rejected.
    private func report(_ error: Error, dropped: Int) {
        rejected += dropped
        guard let handler = config.onError else { return }
        callbackQueue.async { handler(error, dropped) }
    }

    /// Send the next batch, then the one after it, until nothing is left or a retry is due later.
    private func pump() {
        guard !sending, !closed, !state.stopped else { if state.stopped || closed { finishWaiters() }; return }
        let now = Date().timeIntervalSince1970
        if state.retryAt > now { schedule(after: state.retryAt - now); finishWaiters(); return }
        var name = store.batchNames().first
        if name == nil { name = store.freezeBatch(maxEvents: config.maxBatchEvents, maxBytes: config.maxBatchBytes) }
        guard let batch = name, let body = store.readBatch(batch) else {
            if store.queued.isEmpty { timer?.cancel() }
            finishWaiters()
            return
        }
        sending = true
        uploader.send(body) { outcome in
            self.queue.async {
                self.sending = false
                self.handle(outcome, batch: batch, count: DurableQueue.lineCount(body))
            }
        }
    }

    private func handle(_ outcome: UploadOutcome, batch: String, count: Int) {
        switch outcome {
        case .accepted:
            store.deleteBatch(batch)
            accepted += count
            state.attempts = 0
            state.retryAt = 0
            store.save(state)
            pump()
        case .tooLarge:
            switch store.splitBatch(batch) {
            case .split:
                pump()
            case .single:
                store.deleteBatch(batch)
                report(NSError(domain: "Slurp", code: 413, userInfo: [NSLocalizedDescriptionKey: "an event was too large for the Worker and was dropped"]), dropped: count)
                pump()
            case .storageFailure:
                // The halves could not be written. The batch is still whole on disk: keep it and try again later.
                scheduleRetry(after: nil, because: "could not split a batch the Worker found too large (storage error); retrying")
            }
        case .drop(let status):
            store.deleteBatch(batch)
            report(NSError(domain: "Slurp", code: status, userInfo: [NSLocalizedDescriptionKey: "the Worker rejected a batch (HTTP \(status)); \(count) events dropped"]), dropped: count)
            pump()
        case .stop(let status):
            let waiting = store.pendingCount()
            store.clear()
            state.stopped = true
            store.save(state)
            report(NSError(domain: "Slurp", code: status, userInfo: [NSLocalizedDescriptionKey: "the Worker refused the key (HTTP \(status)); sending is stopped and queued events were dropped"]), dropped: waiting)
            timer?.cancel()
            finishWaiters()
        case .retry(let after):
            scheduleRetry(after: after, because: nil)
        }
    }

    /// Back off (or wait the `Retry-After` the Worker asked for) and try the same batch again.
    private func scheduleRetry(after: TimeInterval?, because reason: String?) {
        state.attempts += 1
        let delay = after ?? Uploader.backoff(attempts: state.attempts)
        state.retryAt = Date().timeIntervalSince1970 + delay
        store.save(state)
        let message = reason ?? "could not deliver; retrying in \(Int(delay.rounded(.up))) s"
        report(NSError(domain: "Slurp", code: 0, userInfo: [NSLocalizedDescriptionKey: message]), dropped: 0)
        schedule(after: delay)
        finishWaiters()
    }

    // MARK: app lifecycle

    private func observeLifecycle() {
        let center = NotificationCenter.default
        // Named by string so this needs neither UIKit nor AppKit. They are posted on iOS, tvOS and macOS and are ignored elsewhere.
        let leaving = ["UIApplicationDidEnterBackgroundNotification", "UIApplicationWillResignActiveNotification", "UIApplicationWillTerminateNotification",
                       "NSApplicationDidResignActiveNotification", "NSApplicationWillTerminateNotification"]
        let returning = ["UIApplicationDidBecomeActiveNotification", "NSApplicationDidBecomeActiveNotification"]
        for name in leaving {
            observers.append(center.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { [weak self] _ in self?.flushBeforeSuspension() })
        }
        for name in returning {
            observers.append(center.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { [weak self] _ in self?.flush() })
        }
    }

    /// The OS can suspend (iOS) or end (macOS) the app right after this, so wait briefly for the upload to finish.
    private func flushBeforeSuspension() {
        queue.async { self.store.save(self.state) }
        let upload: () -> Void = {
            // An internal waiter, called directly: it must not queue behind an app callback that might be blocked.
            let done = DispatchSemaphore(value: 0)
            self.queue.async {
                self.waiters.append(Waiter(call: { _ in done.signal() }, onCallbackQueue: false))
                self.pump()
            }
            _ = done.wait(timeout: .now() + 8)
        }
        #if os(macOS)
        upload()
        #else
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Slurp upload") { expired in
            if !expired { upload() }
        }
        #endif
    }
}
