import Foundation

/// Everything that must survive the app being killed: identity, retry state, events not yet batched, and frozen batches.
/// Files: `state.json`, `queue.ndjson` (append only), `batches/<id>.ndjson` (written once, then only deleted or split).
/// All methods must be called from one serial queue.
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
    }

    let directory: URL
    private let queueURL: URL
    private let stateURL: URL
    private let batchesURL: URL
    private let fileManager = FileManager.default
    private(set) var queued: [String] = []

    init(directory: URL) throws {
        self.directory = directory
        queueURL = directory.appendingPathComponent("queue.ndjson")
        stateURL = directory.appendingPathComponent("state.json")
        batchesURL = directory.appendingPathComponent("batches", isDirectory: true)
        try fileManager.createDirectory(at: batchesURL, withIntermediateDirectories: true)
        queued = loadQueue()
    }

    // MARK: state

    func loadState() -> State? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(State.self, from: data)
    }

    @discardableResult
    func save(_ state: State) -> Bool {
        guard let data = try? JSONEncoder().encode(state) else { return false }
        return (try? data.write(to: stateURL, options: .atomic)) != nil
    }

    // MARK: events not yet batched

    private func loadQueue() -> [String] {
        guard var data = try? Data(contentsOf: queueURL), !data.isEmpty else { return [] }
        // A crash can leave a half-written last line; drop everything after the final newline.
        if let last = data.lastIndex(of: 0x0a) { data = data.prefix(through: last) } else { return [] }
        return String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    /// Append one record. Returns false when it could not be written (the caller keeps it in memory only).
    @discardableResult
    func append(_ line: String) -> Bool {
        queued.append(line)
        guard let data = (line + "\n").data(using: .utf8) else { return false }
        if !fileManager.fileExists(atPath: queueURL.path) {
            return fileManager.createFile(atPath: queueURL.path, contents: data)
        }
        guard let handle = try? FileHandle(forWritingTo: queueURL) else { return false }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            return true
        } catch { return false }
    }

    /// Drop the oldest events beyond `limit` (the app has been offline a long time).
    func trim(to limit: Int) -> Int {
        guard queued.count > limit else { return 0 }
        let dropped = queued.count - limit
        queued.removeFirst(dropped)
        rewriteQueue()
        return dropped
    }

    private func rewriteQueue() {
        let text = queued.isEmpty ? "" : queued.joined(separator: "\n") + "\n"
        try? Data(text.utf8).write(to: queueURL, options: .atomic)
    }

    // MARK: frozen batches

    /// The batch files in send order.
    func batchNames() -> [String] {
        ((try? fileManager.contentsOfDirectory(atPath: batchesURL.path)) ?? []).filter { $0.hasSuffix(".ndjson") }.sorted()
    }

    func readBatch(_ name: String) -> Data? { try? Data(contentsOf: batchesURL.appendingPathComponent(name)) }

    func deleteBatch(_ name: String) { try? fileManager.removeItem(at: batchesURL.appendingPathComponent(name)) }

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
        guard (try? Data(body.utf8).write(to: batchesURL.appendingPathComponent(name), options: .atomic)) != nil else { return nil }
        queued.removeFirst(taken)
        rewriteQueue()
        return name
    }

    /// Replace a batch with two halves (after a 413). Returns false when it is a single event and cannot be split.
    func splitBatch(_ name: String) -> Bool {
        guard let data = readBatch(name) else { return false }
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true)
        guard lines.count > 1 else { return false }
        let middle = lines.count / 2
        // Names sort just before the original so the halves go out first and in order.
        let first = "\(name.dropLast(".ndjson".count))-a.ndjson", second = "\(name.dropLast(".ndjson".count))-b.ndjson"
        let a = lines[..<middle].joined(separator: "\n") + "\n", b = lines[middle...].joined(separator: "\n") + "\n"
        guard (try? Data(a.utf8).write(to: batchesURL.appendingPathComponent(first), options: .atomic)) != nil,
              (try? Data(b.utf8).write(to: batchesURL.appendingPathComponent(second), options: .atomic)) != nil else { return false }
        deleteBatch(name)
        return true
    }

    static func lineCount(_ batch: Data) -> Int { batch.reduce(0) { $1 == 0x0a ? $0 + 1 : $0 } }

    /// Events waiting to be acknowledged: queued plus everything in batch files.
    func pendingCount() -> Int {
        queued.count + batchNames().reduce(0) { $0 + (readBatch($1).map(DurableQueue.lineCount) ?? 0) }
    }

    /// Delete everything waiting (the key was rejected for good).
    func clear() {
        queued = []
        rewriteQueue()
        for name in batchNames() { deleteBatch(name) }
    }
}
