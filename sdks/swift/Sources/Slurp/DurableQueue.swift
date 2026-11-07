import Foundation

/// Everything that must survive the app being killed: identity, retry state, events not yet batched, and frozen batches.
/// Files: `state.json`, `queue.ndjson` (append only), `batches/<id>.ndjson` (written once, then only deleted or split).
/// All methods must be called from one serial queue.
///
/// The Worker validates a request as a whole and refuses it if any line is malformed, so a bad line in the queue costs every
/// valid event batched with it. The queue therefore never keeps one: lines are validated when the file is read, and the file is
/// rewritten atomically whenever it is found, or might be, damaged.
final class DurableQueue {
    struct State: Codable {
        var version = 1
        var anonymousId: String
        var sessionId: String
        var userId: String?
        var lastActivity: Double
        var retryAt: Double = 0
        var attempts: Int = 0
        var stopped: Bool = false
        /// A fingerprint of the publishable key that was in use. A different key (after a rotation) clears `stopped`.
        var keyFingerprint: String?
    }

    /// The disk operations a test can make fail.
    enum Operation: Equatable {
        case append, rewriteQueue, writeBatch(String), saveState
    }

    enum SplitOutcome: Equatable {
        case split
        /// One event: it cannot be split further, so it is too large for the Worker.
        case single
        /// The halves could not be written. The original batch is untouched and still has to be sent.
        case storageFailure
    }

    let directory: URL
    private let queueURL: URL
    private let stateURL: URL
    private let batchesURL: URL
    private let fileManager = FileManager.default
    private(set) var queued: [String] = []
    private(set) var queuedBytes = 0
    /// Lines that were discarded when the queue file was read (a half-written last line, or anything that is not a JSON object).
    private(set) var recoveredDropped = 0
    /// True when the queue file may not match `queued` (a failed append or rewrite); the next write replaces it whole.
    private var dirty = false
    /// Test hook: return true to make that disk operation fail.
    var shouldFail: ((Operation) -> Bool)?

    init(directory: URL) throws {
        self.directory = directory
        queueURL = directory.appendingPathComponent("queue.ndjson")
        stateURL = directory.appendingPathComponent("state.json")
        batchesURL = directory.appendingPathComponent("batches", isDirectory: true)
        try fileManager.createDirectory(at: batchesURL, withIntermediateDirectories: true)
        let (lines, damaged) = DurableQueue.readQueue(queueURL)
        queued = lines
        queuedBytes = lines.reduce(0) { $0 + $1.utf8.count + 1 }
        if damaged > 0 {
            recoveredDropped = damaged
            if !rewriteQueue() { dirty = true }
        }
    }

    private static func isJSONObject(_ text: Substring) -> Bool {
        guard let data = text.data(using: .utf8) else { return false }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) != nil
    }

    /// The complete, valid lines in the file, and how many lines were thrown away.
    private static func readQueue(_ url: URL) -> (lines: [String], dropped: Int) {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return ([], 0) }
        let text = String(decoding: data, as: UTF8.self)
        var parts = text.split(separator: "\n", omittingEmptySubsequences: false)
        // Everything after the last newline is a record that was still being written when the app died.
        var dropped = 0
        if let tail = parts.popLast(), !tail.isEmpty { dropped += 1 }
        var lines: [String] = []
        for part in parts where !part.isEmpty {
            if isJSONObject(part) { lines.append(String(part)) } else { dropped += 1 }
        }
        return (lines, dropped)
    }

    // MARK: writing

    private func write(_ data: Data, to url: URL, _ operation: Operation) -> Bool {
        if shouldFail?(operation) == true { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    // MARK: state

    func loadState() -> State? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(State.self, from: data)
    }

    @discardableResult
    func save(_ state: State) -> Bool {
        guard let data = try? JSONEncoder().encode(state) else { return false }
        return write(data, to: stateURL, .saveState)
    }

    // MARK: events not yet batched

    /// Append one record. Returns false when it could not be written (it is then kept in memory only, and the next write
    /// replaces the whole file so a partly written record can never be glued to the one after it).
    @discardableResult
    func append(_ line: String) -> Bool {
        queued.append(line)
        queuedBytes += line.utf8.count + 1
        if dirty {
            if rewriteQueue() { dirty = false; return true }
            return false
        }
        guard let data = (line + "\n").data(using: .utf8) else { return false }
        if shouldFail?(.append) == true { dirty = true; return false }
        if !fileManager.fileExists(atPath: queueURL.path) {
            if fileManager.createFile(atPath: queueURL.path, contents: data) { return true }
            dirty = true
            return false
        }
        guard let handle = try? FileHandle(forWritingTo: queueURL) else { dirty = true; return false }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            return true
        } catch {
            dirty = true
            return false
        }
    }

    /// Replace the queue file with exactly the events in memory, atomically.
    @discardableResult
    private func rewriteQueue() -> Bool {
        let text = queued.isEmpty ? "" : queued.joined(separator: "\n") + "\n"
        return write(Data(text.utf8), to: queueURL, .rewriteQueue)
    }

    /// Drop the oldest events until no more than `maxEvents` are queued and queued events plus unsent batches fit `maxBytes`;
    /// if that is still not enough, drop the oldest unsent batches. Returns how many events were dropped.
    func enforceLimits(maxEvents: Int, maxBytes: Int) -> Int {
        var dropped = 0
        var changed = false
        var total = queuedBytes + batchBytes()
        while !queued.isEmpty && (queued.count > maxEvents || total > maxBytes) {
            let line = queued.removeFirst()
            queuedBytes -= line.utf8.count + 1
            total -= line.utf8.count + 1
            dropped += 1
            changed = true
        }
        if changed && !rewriteQueue() { dirty = true }
        if total > maxBytes {
            for name in batchNames() where total > maxBytes {
                guard let data = readBatch(name) else { continue }
                total -= data.count
                dropped += DurableQueue.lineCount(data)
                deleteBatch(name)
            }
        }
        return dropped
    }

    // MARK: frozen batches

    /// The batch files in send order.
    func batchNames() -> [String] {
        ((try? fileManager.contentsOfDirectory(atPath: batchesURL.path)) ?? []).filter { $0.hasSuffix(".ndjson") }.sorted()
    }

    func readBatch(_ name: String) -> Data? { try? Data(contentsOf: batchesURL.appendingPathComponent(name)) }

    func deleteBatch(_ name: String) { try? fileManager.removeItem(at: batchesURL.appendingPathComponent(name)) }

    private func batchBytes() -> Int {
        batchNames().reduce(0) { total, name in
            let size = (try? fileManager.attributesOfItem(atPath: batchesURL.appendingPathComponent(name).path)[.size] as? Int) ?? 0
            return total + size
        }
    }

    /// Move up to the limits' worth of queued events into a new batch file. The batch is written before the queue is
    /// trimmed, so a crash in between can duplicate events (same ids, which the archive deduplicates) but never lose them.
    func freezeBatch(maxEvents: Int, maxBytes: Int) -> String? {
        guard !queued.isEmpty else { return nil }
        var taken = 0
        var size = 0
        var body = ""
        for line in queued {
            let bytes = line.utf8.count + 1
            if taken > 0 && (taken >= maxEvents || size + bytes > maxBytes) { break }
            body += line + "\n"
            size += bytes
            taken += 1
        }
        let name = "\(Ids.uuidv7()).ndjson"
        guard write(Data(body.utf8), to: batchesURL.appendingPathComponent(name), .writeBatch(name)) else { return nil }
        let removed = queued[..<taken].reduce(0) { $0 + $1.utf8.count + 1 }
        queued.removeFirst(taken)
        queuedBytes -= removed
        if !rewriteQueue() { dirty = true }
        return name
    }

    /// Replace a batch with two halves (after a 413). The original is deleted only after both halves are safely written.
    func splitBatch(_ name: String) -> SplitOutcome {
        guard let data = readBatch(name) else { return .storageFailure }
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true)
        guard lines.count > 1 else { return .single }
        let middle = (lines.count + 1) / 2 // the first half is the larger one, as in the other SDKs
        // Names sort just before the original so the halves go out first and in order.
        let stem = String(name.dropLast(".ndjson".count))
        let first = "\(stem)-a.ndjson", second = "\(stem)-b.ndjson"
        let a = lines[..<middle].joined(separator: "\n") + "\n", b = lines[middle...].joined(separator: "\n") + "\n"
        guard write(Data(a.utf8), to: batchesURL.appendingPathComponent(first), .writeBatch(first)) else { return .storageFailure }
        guard write(Data(b.utf8), to: batchesURL.appendingPathComponent(second), .writeBatch(second)) else {
            deleteBatch(first)
            return .storageFailure
        }
        deleteBatch(name)
        return .split
    }

    static func lineCount(_ batch: Data) -> Int { batch.reduce(0) { $1 == 0x0a ? $0 + 1 : $0 } }

    /// Events waiting to be acknowledged: queued plus everything in batch files.
    func pendingCount() -> Int {
        queued.count + batchNames().reduce(0) { $0 + (readBatch($1).map(DurableQueue.lineCount) ?? 0) }
    }

    /// Delete everything waiting (the key was rejected for good).
    func clear() {
        queued = []
        queuedBytes = 0
        if !rewriteQueue() { dirty = true }
        for name in batchNames() { deleteBatch(name) }
    }
}
