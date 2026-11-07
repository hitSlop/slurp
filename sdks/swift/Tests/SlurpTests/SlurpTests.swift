import XCTest
@testable import Slurp

/// Answers every request from a closure and records what was sent.
final class StubProtocol: URLProtocol {
    struct Sent { var body: Data; var headers: [String: String] }
    nonisolated(unsafe) static var handler: ((Sent) -> (status: Int, headers: [String: String]))?
    nonisolated(unsafe) static var sent: [Sent] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        } else if let data = request.httpBody { body = data }
        let sent = Sent(body: body, headers: request.allHTTPHeaderFields ?? [:])
        StubProtocol.lock.lock(); StubProtocol.sent.append(sent); StubProtocol.lock.unlock()
        let reply: (status: Int, headers: [String: String]) = StubProtocol.handler?(sent) ?? (status: 200, headers: [:])
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class SlurpTests: XCTestCase {
    var directory: URL!
    var errors: [(Error, Int)] = []

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("slurp-test-\(UUID().uuidString)")
        StubProtocol.handler = nil
        StubProtocol.sent = []
        errors = []
    }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }

    func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    func client(_ customize: (inout SlurpClient.Configuration) -> Void = { _ in }) -> SlurpClient {
        var configuration = SlurpClient.Configuration(key: "slurp_pk_test", endpoint: URL(string: "https://worker.example/v1/events")!, sourceId: "src_test")
        configuration.session = session()
        configuration.directory = directory
        configuration.flushInterval = 3600
        configuration.flushOnBackground = false
        configuration.onError = { [unowned self] error, dropped in self.errors.append((error, dropped)) }
        customize(&configuration)
        return SlurpClient(configuration)
    }

    func records(_ data: Data) throws -> [[String: Any]] {
        try String(decoding: data, as: UTF8.self).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }

    // MARK: encoding

    func testIdsAreUUIDv7AndSortByTime() {
        let a = Ids.uuidv7(now: Date(timeIntervalSince1970: 1_700_000_000))
        let b = Ids.uuidv7(now: Date(timeIntervalSince1970: 1_700_000_001))
        XCTAssertNotNil(a.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#, options: .regularExpression))
        XCTAssertLessThan(a, b)
    }

    func testRecordShapeMatchesTheContract() throws {
        let line = try EventEncoder.line(id: "id1", type: "track", event: "signed_up", timestamp: Date(timeIntervalSince1970: 1_700_000_000.123), userId: "u1", anonymousId: "anon", sessionId: "sess", data: ["plan": "pro", "n": 3, "url": "https://x.test/a"], context: ["library": ["name": "slurp-swift"]])
        XCTAssertFalse(line.contains("\n"))
        XCTAssertTrue(line.contains("https://x.test/a"), "slashes are not escaped")
        let record = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        XCTAssertEqual(record["id"] as? String, "id1"); XCTAssertEqual(record["type"] as? String, "track"); XCTAssertEqual(record["event"] as? String, "signed_up")
        XCTAssertEqual(record["timestamp"] as? String, "2023-11-14T22:13:20.123Z")
        XCTAssertEqual(record["user_id"] as? String, "u1"); XCTAssertEqual(record["anonymous_id"] as? String, "anon"); XCTAssertEqual(record["session_id"] as? String, "sess")
        XCTAssertEqual((record["data"] as? [String: Any])?["plan"] as? String, "pro")
    }

    func testInvalidEventsAreRefused() {
        func encode(event: String?, data: [String: Any] = [:], context: [String: Any] = [:]) throws -> String {
            try EventEncoder.line(id: "i", type: "track", event: event, timestamp: Date(), userId: nil, anonymousId: "a", sessionId: "s", data: data, context: context)
        }
        XCTAssertThrowsError(try encode(event: ""))
        XCTAssertThrowsError(try encode(event: String(repeating: "x", count: 201)))
        XCTAssertThrowsError(try encode(event: "e", data: ["when": Date()]))
        XCTAssertThrowsError(try encode(event: "e", data: ["bad": Double.nan]))
        XCTAssertThrowsError(try encode(event: "e", context: ["geo": ["country": "CA"]]))
        XCTAssertThrowsError(try encode(event: "e", data: ["blob": String(repeating: "x", count: 1024 * 1024 + 1)]))
        XCTAssertNoThrow(try encode(event: "e", data: ["blob": String(repeating: "x", count: 900_000)]), "big events are fine up to 1 MiB")
    }

    // MARK: delivery

    func testFlushSendsOneBatchWithAuthAndContext() async throws {
        let slurp = client()
        slurp.track("purchase", ["total": 49])
        slurp.screen("Home", ["tab": "feed"])
        slurp.identify("user-1", traits: ["plan": "pro"])
        let result = await slurp.flush()
        XCTAssertEqual(result.accepted, 3); XCTAssertEqual(result.pending, 0); XCTAssertFalse(result.stopped)
        XCTAssertEqual(StubProtocol.sent.count, 1)
        let sent = StubProtocol.sent[0]
        XCTAssertEqual(sent.headers["Authorization"], "Bearer slurp_pk_test"); XCTAssertEqual(sent.headers["Content-Type"], "application/x-ndjson")
        XCTAssertTrue(String(decoding: sent.body, as: UTF8.self).hasSuffix("\n"))
        let rows = try records(sent.body)
        XCTAssertEqual(rows.map { $0["type"] as? String }, ["track", "track", "identify"])
        XCTAssertEqual((rows[1]["data"] as? [String: Any])?["name"] as? String, "Home")
        let context = rows[0]["context"] as! [String: Any]
        XCTAssertEqual((context["library"] as? [String: Any])?["name"] as? String, "slurp-swift")
        XCTAssertNotNil(context["os"]); XCTAssertNotNil(context["timezone"])
        XCTAssertEqual(rows[0]["anonymous_id"] as? String, rows[2]["anonymous_id"] as? String)
        XCTAssertNil(rows[0]["user_id"], "no user until identified"); XCTAssertEqual(rows[2]["user_id"] as? String, "user-1")
    }

    func testIdentitySessionAndUserSwitching() async throws {
        let slurp = client { $0.sessionTimeout = 0.3 }
        slurp.track("a")
        slurp.identify("alice")
        slurp.track("b")
        slurp.identify("bob") // a different known user: a new visitor and session
        slurp.track("c")
        try await Task.sleep(nanoseconds: 450_000_000)
        slurp.track("d") // after the inactivity timeout: a new session, same visitor
        _ = await slurp.flush()
        let rows = try records(StubProtocol.sent[0].body)
        func value(_ i: Int, _ key: String) -> String? { rows[i][key] as? String }
        XCTAssertEqual(value(0, "anonymous_id"), value(2, "anonymous_id"), "first identification keeps the visitor")
        XCTAssertEqual(value(0, "session_id"), value(2, "session_id"))
        XCTAssertNotEqual(value(2, "anonymous_id"), value(3, "anonymous_id"), "switching users rotates the visitor")
        XCTAssertEqual(value(4, "user_id"), "bob")
        XCTAssertEqual(value(4, "anonymous_id"), value(5, "anonymous_id")); XCTAssertNotEqual(value(4, "session_id"), value(5, "session_id"))
    }

    func testEventsSurviveARestartAndRetryResendsIdenticalBytes() async throws {
        StubProtocol.handler = { _ in (503, [:]) }
        let first = client()
        let id = first.track("checkout_started", ["cart": 3])
        first.identify("user-5")
        let down = await first.flush()
        XCTAssertEqual(down.pending, 2); XCTAssertNotNil(down.retryAt)
        first.close() // the process dies here
        StubProtocol.handler = nil
        let second = client()
        XCTAssertEqual(second.pending, 2, "the queue was read back from disk")
        let wait = max(0, (down.retryAt ?? Date()).timeIntervalSinceNow) + 0.1
        try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        let result = await second.flush()
        XCTAssertEqual(result.accepted, 2); XCTAssertEqual(result.pending, 0)
        XCTAssertEqual(StubProtocol.sent.count, 2)
        XCTAssertEqual(StubProtocol.sent[0].body, StubProtocol.sent[1].body, "the retry is byte for byte what was first sent")
        let rows = try records(StubProtocol.sent[1].body)
        XCTAssertEqual(rows[0]["id"] as? String, id)
        second.track("after_relaunch")
        _ = await second.flush()
        let last = try records(StubProtocol.sent.last!.body).last!
        XCTAssertEqual(last["user_id"] as? String, "user-5", "identity persisted"); XCTAssertEqual(last["anonymous_id"] as? String, rows[0]["anonymous_id"] as? String)
    }

    func testAHalfWrittenLastLineAfterACrashIsDropped() throws {
        let store = try DurableQueue(directory: directory)
        store.append(#"{"id":"whole"}"#)
        let handle = try FileHandle(forWritingTo: directory.appendingPathComponent("queue.ndjson"))
        try handle.seekToEnd(); try handle.write(contentsOf: Data(#"{"id":"half"#.utf8)); try handle.close()
        XCTAssertEqual(try DurableQueue(directory: directory).queued, [#"{"id":"whole"}"#])
    }

    func testTooLargeBatchesAreSplitUntilTheyFit() async throws {
        StubProtocol.handler = { sent in DurableQueue.lineCount(sent.body) > 1 ? (413, [:]) : (200, [:]) }
        let slurp = client()
        for i in 0..<5 { slurp.track("e\(i)") }
        let result = await slurp.flush()
        XCTAssertEqual(result.accepted, 5); XCTAssertEqual(result.rejected, 0)
        let delivered = try StubProtocol.sent.filter { DurableQueue.lineCount($0.body) == 1 }.flatMap { try records($0.body) }.compactMap { $0["event"] as? String }
        XCTAssertEqual(delivered, ["e0", "e1", "e2", "e3", "e4"], "every event delivered once, in order")
    }

    func testPermanentRejectionsDropAndBadKeysStop() async throws {
        StubProtocol.handler = { _ in (400, [:]) }
        let a = client()
        a.track("x")
        let dropped = await a.flush()
        XCTAssertEqual(dropped.rejected, 1); XCTAssertEqual(dropped.pending, 0); XCTAssertFalse(dropped.stopped)
        StubProtocol.handler = { _ in (401, [:]) }
        a.track("y")
        let stopped = await a.flush()
        XCTAssertTrue(stopped.stopped); XCTAssertEqual(stopped.pending, 0)
        a.track("z")
        XCTAssertEqual(a.pending, 0, "a stopped client keeps nothing")
        let again = client() // the stop survives a restart
        again.track("after")
        let afterRestart = await again.flush()
        XCTAssertTrue(afterRestart.stopped)
    }

    func testRetryAfterAndStatusClassification() {
        XCTAssertEqual(Uploader.classify(status: 200, retryAfter: nil), .accepted)
        XCTAssertEqual(Uploader.classify(status: 413, retryAfter: nil), .tooLarge)
        XCTAssertEqual(Uploader.classify(status: 429, retryAfter: "7"), .retry(after: 7))
        XCTAssertEqual(Uploader.classify(status: 503, retryAfter: nil), .retry(after: nil))
        XCTAssertEqual(Uploader.classify(status: 500, retryAfter: nil), .retry(after: nil))
        XCTAssertEqual(Uploader.classify(status: 403, retryAfter: nil), .stop(status: 403))
        XCTAssertEqual(Uploader.classify(status: 400, retryAfter: nil), .drop(status: 400))
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(Uploader.parseRetryAfter("Tue, 14 Nov 2023 22:14:20 GMT", now: now), 60)
        XCTAssertNil(Uploader.parseRetryAfter("soon", now: now))
        for attempts in 1...12 { let d = Uploader.backoff(attempts: attempts); XCTAssertGreaterThanOrEqual(d, 0.25); XCTAssertLessThanOrEqual(d, 60) }
    }

    func testQueueLimitDropsTheOldestAndReportsIt() async throws {
        let slurp = client { $0.maxQueue = 3 }
        for i in 0..<5 { slurp.track("e\(i)") }
        _ = await slurp.flush()
        let events = try records(StubProtocol.sent[0].body).compactMap { $0["event"] as? String }
        XCTAssertEqual(events, ["e2", "e3", "e4"])
        XCTAssertEqual(errors.map { $0.1 }.reduce(0, +), 2)
    }

    func testOversizeAndInvalidEventsAreReportedWithoutChangingIdentity() async throws {
        let slurp = client()
        slurp.track("")
        slurp.track("big", ["blob": String(repeating: "x", count: 1024 * 1024 + 10)])
        slurp.track("ok")
        let result = await slurp.flush()
        XCTAssertEqual(result.accepted, 1); XCTAssertEqual(result.rejected, 2); XCTAssertEqual(errors.count, 2)
    }

    // MARK: a real Worker (set SLURP_TEST_ENDPOINT and SLURP_TEST_KEY to run)

    func testDeliversToARealWorker() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["SLURP_TEST_ENDPOINT"], let key = env["SLURP_TEST_KEY"] else { throw XCTSkip("set SLURP_TEST_ENDPOINT and SLURP_TEST_KEY to send to a Worker") }
        var configuration = SlurpClient.Configuration(key: key, endpoint: URL(string: endpoint)!)
        configuration.directory = directory
        configuration.flushOnBackground = false
        configuration.onError = { error, _ in XCTFail("\(error)") }
        let slurp = SlurpClient(configuration)
        slurp.track("swift_sdk_check", ["n": 1, "tags": ["a", "b"], "nested": ["ok": true]])
        slurp.identify("swift-user", traits: ["plan": "pro"])
        slurp.screen("Settings")
        let result = await slurp.flush()
        XCTAssertEqual(result.accepted, 3); XCTAssertEqual(result.pending, 0)
    }
}
