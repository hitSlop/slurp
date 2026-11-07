import Foundation

/// The SDK's version, written into every event as `context.library.version`.
public let slurpVersion = "0.1.0"

enum Ids {
    /// A UUIDv7: time ordered, so ids sort by creation time.
    static func uuidv7(now: Date = Date()) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 6..<16 { bytes[i] = UInt8.random(in: 0...255) }
        var millis = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        for i in stride(from: 5, through: 0, by: -1) {
            bytes[i] = UInt8(millis & 0xff)
            millis >>= 8
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x70
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let chars = Array(hex)
        func part(_ a: Int, _ b: Int) -> String { String(chars[a..<b]) }
        return "\(part(0, 8))-\(part(8, 12))-\(part(12, 16))-\(part(16, 20))-\(part(20, 32))"
    }
}

enum EventError: Error, CustomStringConvertible {
    case invalidEventName
    case invalidData(String)
    case tooLarge
    case reservedContext

    var description: String {
        switch self {
        case .invalidEventName: return "event must be a non-empty string of at most 200 characters"
        case .invalidData(let why): return "data must be a JSON object: \(why)"
        case .tooLarge: return "event exceeds 1 MiB"
        case .reservedContext: return "context.geo is reserved for server enrichment"
        }
    }
}

enum EventEncoder {
    static let maxBytes = 1024 * 1024

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func check(_ object: [String: Any], label: String) throws {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw EventError.invalidData("\(label) must contain only strings, numbers, booleans, null, arrays and dictionaries (no dates, NaN or infinity)")
        }
    }

    /// One record as a single JSON line (no trailing newline).
    static func line(
        id: String, type: String, event: String?, timestamp: Date,
        userId: String?, anonymousId: String, sessionId: String,
        data: [String: Any], context: [String: Any]
    ) throws -> String {
        if type == "track" {
            guard let event = event, !event.isEmpty, event.count <= 200 else { throw EventError.invalidEventName }
        }
        try check(data, label: "data")
        try check(context, label: "context")
        if context["geo"] != nil { throw EventError.reservedContext }
        var record: [String: Any] = [
            "id": id, "type": type, "timestamp": EventEncoder.timestamp(timestamp),
            "anonymous_id": anonymousId, "session_id": sessionId, "data": data, "context": context,
        ]
        if let event = event { record["event"] = event }
        if let userId = userId { record["user_id"] = userId }
        let bytes = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= maxBytes else { throw EventError.tooLarge }
        guard let text = String(data: bytes, encoding: .utf8) else { throw EventError.invalidData("not UTF-8") }
        return text
    }
}
