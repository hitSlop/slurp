import XCTest
@testable import Slurp

/// Runs sdks/conformance/delivery.json, the scenarios every Slurp SDK must pass (the JavaScript and React Native SDKs run the same file).
final class ConformanceTests: XCTestCase {
    struct Suite: Decodable { var scenarios: [Scenario] }
    struct Scenario: Decodable {
        struct Response: Decodable { var status: Int; var retryAfter: String? }
        struct Options: Decodable { var maxBatchEvents: Int? }
        struct Expect: Decodable { var requests: [[String]]; var identicalRetries: Bool?; var accepted: Int; var rejected: Int; var stopped: Bool; var pending: Int }
        var name: String
        var options: Options?
        var events: [String]
        var responses: [Response]
        var expect: Expect
    }

    func loadSuite() throws -> Suite {
        // #filePath is .../sdks/swift/Tests/SlurpTests/ConformanceTests.swift
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/delivery.json")
        return try JSONDecoder().decode(Suite.self, from: Data(contentsOf: url))
    }

    func testEveryScenario() async throws {
        for scenario in try loadSuite().scenarios {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("slurp-conformance-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: directory) }
            StubProtocol.sent = []
            let lock = NSLock()
            var script = scenario.responses
            StubProtocol.handler = { _ in
                lock.lock(); defer { lock.unlock() }
                guard !script.isEmpty else { return (200, [:]) }
                let next = script.removeFirst()
                return (next.status, next.retryAfter.map { ["Retry-After": $0] } ?? [:])
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [StubProtocol.self]
            var config = SlurpClient.Configuration(key: "slurp_pk_test", endpoint: URL(string: "https://worker.example/v1/events")!)
            config.session = URLSession(configuration: configuration)
            config.directory = directory
            config.flushOnBackground = false
            config.flushInterval = 3600
            if let maxBatchEvents = scenario.options?.maxBatchEvents { config.maxBatchEvents = maxBatchEvents }
            let client = SlurpClient(config)
            for event in scenario.events { client.track(event) }
            var result = await client.flush()
            var rounds = 0
            while result.pending > 0 && !result.stopped && rounds < 8 {
                try await Task.sleep(nanoseconds: UInt64((max(0, (result.retryAt ?? Date()).timeIntervalSinceNow) + 0.03) * 1_000_000_000))
                result = await client.flush()
                rounds += 1
            }
            let sent = StubProtocol.sent.map { request -> [String] in
                String(decoding: request.body, as: UTF8.self).split(separator: "\n").compactMap {
                    (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["event"] as? String
                }
            }
            let name = scenario.name
            XCTAssertEqual(sent, scenario.expect.requests, "\(name): requests")
            if scenario.expect.identicalRetries == true {
                XCTAssertTrue(StubProtocol.sent.allSatisfy { $0.body == StubProtocol.sent[0].body }, "\(name): a retry carries exactly the bytes of the request it retries")
            }
            XCTAssertEqual(result.accepted, scenario.expect.accepted, "\(name): accepted")
            XCTAssertEqual(result.rejected, scenario.expect.rejected, "\(name): rejected")
            XCTAssertEqual(result.stopped, scenario.expect.stopped, "\(name): stopped")
            XCTAssertEqual(result.pending, scenario.expect.pending, "\(name): pending")
            client.close()
        }
    }
}
