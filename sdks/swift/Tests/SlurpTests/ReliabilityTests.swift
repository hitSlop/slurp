import XCTest
@testable import Slurp

/// Failure modes found in review: each of these lost or corrupted events, or crashed the host app, before it was fixed.
final class ReliabilityTests: XCTestCase {
    var directory: URL!
    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("slurp-reliability-\(UUID().uuidString)")
        StubProtocol.handler = nil
        StubProtocol.sent = []
    }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }

    func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// Every event still waiting on disk: in the queue file and in batches already cut from it.
    func waiting(_ store: DurableQueue) -> [String] {
        store.batchNames().flatMap { String(decoding: store.readBatch($0) ?? Data(), as: UTF8.self).split(separator: "\n").map(String.init) } + store.queued
    }

    func isJSONObject(_ line: String) -> Bool {
        ((try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]) != nil
    }

    // 1. A half-written last line must not survive on disk, or the next append is glued onto it and the whole batch is rejected.
    func testRecoveryRemovesTheFragmentFromDiskBeforeAnythingIsAppended() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("queue.ndjson")
        try Data("{\"id\":\"whole\"}\n{\"id\":\"hal".utf8).write(to: file)
        let first = try DurableQueue(directory: directory)
        XCTAssertEqual(first.queued, ["{\"id\":\"whole\"}"])
        first.append("{\"id\":\"new\"}")
        // Restart again: every line on disk is a complete JSON object.
        let second = try DurableQueue(directory: directory)
        XCTAssertEqual(second.queued, ["{\"id\":\"whole\"}", "{\"id\":\"new\"}"])
        XCTAssertTrue(second.queued.allSatisfy(isJSONObject), "\(second.queued)")
    }

    // 2. Handlers run on their own queue, so reading `pending` or closing the client from one cannot deadlock the SDK's queue.
    func testErrorHandlersMayReadPendingAndCloseTheClient() {
        StubProtocol.handler = { _ in (503, [:]) }
        let called = expectation(description: "onError ran and returned")
        var configuration = SlurpClient.Configuration(key: "slurp_pk_test", endpoint: URL(string: "https://worker.example/v1/events")!)
        configuration.session = session()
        configuration.directory = directory
        configuration.flushOnBackground = false
        configuration.flushInterval = 3600
        var client: SlurpClient!
        var fired = false
        configuration.onError = { _, _ in
            guard !fired else { return }
            fired = true
            _ = client.pending   // used to trap: dispatch_sync on the queue that is running this handler
            client.close()
            called.fulfill()
        }
        client = SlurpClient(configuration)
        client.track("a")
        client.flush()
        wait(for: [called], timeout: 5)
    }

    func client(_ customize: (inout SlurpClient.Configuration) -> Void = { _ in }, store: DurableQueue? = nil, key: String = "slurp_pk_test") -> SlurpClient {
        var configuration = SlurpClient.Configuration(key: key, endpoint: URL(string: "https://worker.example/v1/events")!)
        configuration.session = session()
        configuration.directory = directory
        configuration.flushOnBackground = false
        configuration.flushInterval = 3600
        customize(&configuration)
        return SlurpClient(configuration, store: store)
    }

    // 3. A batch the Worker found too large is replaced by two halves only after both are safely on disk.
    func testAFailedSplitKeepsTheOriginalBatch() throws {
        let store = try DurableQueue(directory: directory)
        for i in 0..<4 { store.append("{\"id\":\"e\(i)\"}") }
        let name = try XCTUnwrap(store.freezeBatch(maxEvents: 10, maxBytes: 10_000))
        store.shouldFail = { if case .writeBatch(let n) = $0 { return n.hasSuffix("-b.ndjson") } else { return false } }
        XCTAssertEqual(store.splitBatch(name), .storageFailure)
        XCTAssertEqual(store.batchNames(), [name], "the original is untouched and no half-written file is left behind")
        XCTAssertEqual(DurableQueue.lineCount(try XCTUnwrap(store.readBatch(name))), 4)
        store.shouldFail = nil
        XCTAssertEqual(store.splitBatch(name), .split)
        XCTAssertEqual(store.batchNames().count, 2)
        let single = try XCTUnwrap({ () -> String? in store.append("{\"id\":\"solo\"}"); return store.freezeBatch(maxEvents: 1, maxBytes: 10_000) }())
        XCTAssertEqual(store.splitBatch(single), .single)
    }

    func testAnEventIsNotLostWhenTheWorkerSays413AndTheSplitCannotBeStored() async throws {
        StubProtocol.handler = { sent in DurableQueue.lineCount(sent.body) > 1 ? (413, [:]) : (200, [:]) }
        let store = try DurableQueue(directory: directory)
        store.shouldFail = { if case .writeBatch(let n) = $0 { return n.hasSuffix("-b.ndjson") } else { return false } }
        let slurp = client(store: store)
        slurp.track("one"); slurp.track("two")
        let stuck = await slurp.flush()
        XCTAssertEqual(stuck.rejected, 0, "nothing is discarded because the disk failed")
        XCTAssertEqual(stuck.pending, 2); XCTAssertNotNil(stuck.retryAt)
        store.shouldFail = nil // the disk recovers
        try await Task.sleep(nanoseconds: UInt64(max(0, (stuck.retryAt ?? Date()).timeIntervalSinceNow) * 1_000_000_000) + 100_000_000)
        let done = await slurp.flush()
        XCTAssertEqual(done.accepted, 2); XCTAssertEqual(done.pending, 0); XCTAssertEqual(done.rejected, 0)
    }

    // A failed append is healed: the next write replaces the whole file instead of gluing onto a partly written record.
    func testAFailedAppendNeverLeavesAFragmentBehind() throws {
        let store = try DurableQueue(directory: directory)
        store.append("{\"id\":\"a\"}")
        store.shouldFail = { $0 == .append }
        XCTAssertFalse(store.append("{\"id\":\"b\"}"), "reported as not written")
        store.shouldFail = nil
        XCTAssertTrue(store.append("{\"id\":\"c\"}"))
        XCTAssertEqual(try DurableQueue(directory: directory).queued, ["{\"id\":\"a\"}", "{\"id\":\"b\"}", "{\"id\":\"c\"}"], "b was still in memory, so it is saved too")
    }

    // Lines that are complete but not JSON are removed on load and reported, not sent.
    func testDamagedLinesAreDroppedOnLoadAndReported() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{\"id\":\"ok\"}\nnot json at all\n[1,2]\n{\"id\":\"ok2\"}\n".utf8).write(to: directory.appendingPathComponent("queue.ndjson"))
        StubProtocol.handler = { _ in (-1, [:]) } // hold the network so nothing is delivered while we look
        let reported = expectation(description: "reported")
        let client = client({ $0.requestTimeout = 60; $0.onError = { error, dropped in if dropped == 2 { reported.fulfill() } } })
        wait(for: [reported], timeout: 5)
        XCTAssertEqual(client.pending, 2)
        XCTAssertEqual(waiting(try DurableQueue(directory: directory)).count, 2, "and the file was rewritten without them")
    }

    // 4. Events can be 1 MiB each, so the queue is limited by bytes as well as by count.
    func testTheQueueIsLimitedByBytesAndReportsWhatItDrops() async throws {
        StubProtocol.handler = { _ in (503, [:]) }
        var dropped = 0
        let lock = NSLock()
        let slurp = client({ $0.maxQueueBytes = 3_000; $0.maxBatchEvents = 2; $0.onError = { _, d in lock.lock(); dropped += d; lock.unlock() } })
        for i in 0..<10 { slurp.track("event\(i)", ["pad": String(repeating: "x", count: 500)]) }
        let result = await slurp.flush()
        let store = try DurableQueue(directory: directory)
        let bytes = store.queued.reduce(0) { $0 + $1.utf8.count + 1 } + store.batchNames().reduce(0) { $0 + (store.readBatch($1)?.count ?? 0) }
        XCTAssertLessThanOrEqual(bytes, 3_000)
        XCTAssertGreaterThan(result.rejected, 0)
        lock.lock(); XCTAssertEqual(dropped, result.rejected); lock.unlock()
        XCTAssertEqual(result.pending + result.rejected, 10, "everything is either still waiting or was reported dropped")
    }

    func testAQueueSavedUnderBiggerLimitsIsTrimmedOnLoad() throws {
        let store = try DurableQueue(directory: directory)
        for i in 0..<5 { store.append("{\"id\":\"e\(i)\"}") }
        StubProtocol.handler = { _ in (-1, [:]) }
        let client = client({ $0.maxQueue = 2; $0.requestTimeout = 60 })
        XCTAssertEqual(client.pending, 2)
        XCTAssertEqual(waiting(try DurableQueue(directory: directory)).sorted(), ["{\"id\":\"e3\"}", "{\"id\":\"e4\"}"])
    }

    // Status handling is the same as the JavaScript SDK's.
    func testARefusedKeyStopsTheClientAndReportsEverythingThatWasWaiting() async throws {
        for status in [401, 403] {
            StubProtocol.handler = { _ in (status, [:]) }
            var reportedDropped = 0
            let lock = NSLock()
            let dir = directory.appendingPathComponent("s\(status)")
            let slurp = client({ $0.directory = dir; $0.maxBatchEvents = 2; $0.onError = { _, d in lock.lock(); reportedDropped += d; lock.unlock() } })
            for i in 0..<5 { slurp.track("e\(i)") }
            let result = await slurp.flush()
            XCTAssertTrue(result.stopped, "HTTP \(status) stops the client")
            XCTAssertEqual(result.pending, 0)
            try await Task.sleep(nanoseconds: 100_000_000)
            lock.lock(); XCTAssertEqual(reportedDropped, 5, "HTTP \(status): all five were waiting, not only the batch that was sent"); lock.unlock()
        }
    }

    func testEveryTwoHundredClassStatusIsAnAcknowledgement() async {
        for status in [200, 201, 202, 204] {
            XCTAssertEqual(Uploader.classify(status: status, retryAfter: nil), .accepted)
        }
        XCTAssertEqual(Uploader.classify(status: 408, retryAfter: nil), .retry(after: nil))
    }

    // Replacing a refused key must not leave the client stopped forever.
    func testAReplacedKeyStartsSendingAgain() async throws {
        StubProtocol.handler = { _ in (401, [:]) }
        let first = client(key: "slurp_pk_old")
        first.track("a")
        let firstResult = await first.flush()
        XCTAssertTrue(firstResult.stopped)
        first.close()
        StubProtocol.handler = nil
        let second = client(key: "slurp_pk_new")
        second.track("b")
        let result = await second.flush()
        XCTAssertFalse(result.stopped); XCTAssertEqual(result.accepted, 1)
        let same = client(key: "slurp_pk_new")
        let sameResult = await same.flush()
        XCTAssertFalse(sameResult.stopped, "and it stays working across restarts")
    }

    // Saved state belongs to one key: a sender never sends events that another sender queued in the same folder.
    func testASenderNeverSendsAnotherSendersQueuedEvents() async throws {
        StubProtocol.handler = { _ in (-1, [:]) } // offline
        let widget = client({ $0.requestTimeout = 0.3 }, key: "slurp_pk_aaaaaaaaaaaaaaaa_widget")
        widget.track("from-widget")
        widget.close()
        var sentBodies: [String] = []
        let lock = NSLock()
        StubProtocol.handler = { sent in
            lock.lock(); sentBodies.append(String(decoding: sent.body, as: UTF8.self)); lock.unlock()
            return (200, [:])
        }
        let web = client(key: "slurp_pk_aaaaaaaaaaaaaaaa_web")
        web.track("from-web")
        let result = await web.flush()
        XCTAssertEqual(result.accepted, 1)
        lock.lock(); let joined = sentBodies.joined(); lock.unlock()
        XCTAssertTrue(joined.contains("from-web"))
        XCTAssertFalse(joined.contains("from-widget"), "the other sender's event is not sent under this key")
    }

    // A request that never gets an answer is cancelled and retried with the same bytes.
    func testAnUnansweredRequestIsRetriedWithTheSameBytes() async throws {
        var calls = 0
        let lock = NSLock()
        StubProtocol.handler = { _ in lock.lock(); calls += 1; let n = calls; lock.unlock(); return n == 1 ? (-1, [:]) : (200, [:]) }
        let slurp = client({ $0.requestTimeout = 0.3 })
        slurp.track("a")
        let first = await slurp.flush()
        XCTAssertEqual(first.accepted, 0); XCTAssertEqual(first.pending, 1); XCTAssertNotNil(first.retryAt)
        try await Task.sleep(nanoseconds: UInt64(max(0, (first.retryAt ?? Date()).timeIntervalSinceNow) * 1_000_000_000) + 100_000_000)
        let second = await slurp.flush()
        XCTAssertEqual(second.accepted, 1)
        XCTAssertEqual(StubProtocol.sent.count, 2)
        XCTAssertEqual(StubProtocol.sent[0].body, StubProtocol.sent[1].body)
    }

    // The app's context closure runs on the thread that records the event, so it can safely read the client.
    func testTheContextClosureMayReadPendingWithoutDeadlocking() {
        var slurp: SlurpClient!
        slurp = client({ $0.context = { ["pending": slurp.pending] } })
        slurp.track("a")
        XCTAssertEqual(slurp.pending, 1)
    }
}
