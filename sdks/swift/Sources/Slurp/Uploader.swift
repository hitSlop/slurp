import Foundation

/// What the Worker's answer means for the batch that was sent.
enum UploadOutcome: Equatable {
    case accepted
    case tooLarge                      // 413: split the batch (a single event is dropped)
    case retry(after: TimeInterval?)   // 429, 503, 408, other 5xx, or no network
    case drop(status: Int)             // a permanent rejection of this batch (400 and friends)
    case stop(status: Int)             // 401/403: the key is wrong or revoked; stop for good
}

struct Uploader {
    let session: URLSession
    let endpoint: URL
    let key: String

    static func classify(status: Int, retryAfter: String?, now: Date = Date()) -> UploadOutcome {
        switch status {
        case 200..<300: return .accepted
        case 413: return .tooLarge
        case 401, 403: return .stop(status: status)
        case 429, 503: return .retry(after: parseRetryAfter(retryAfter, now: now))
        case 408, 500..<600: return .retry(after: nil)
        default: return .drop(status: status)
        }
    }

    /// Seconds or an HTTP date, as `Retry-After` allows. Nil when absent or unreadable.
    static func parseRetryAfter(_ value: String?, now: Date) -> TimeInterval? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if let seconds = TimeInterval(value) { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: value) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    /// Exponential backoff with jitter: 250-500 ms after the first failure, doubling to 30-60 s.
    static func backoff(attempts: Int) -> TimeInterval {
        let base = min(0.5 * pow(2, Double(max(0, min(attempts - 1, 7)))), 60)
        return base * Double.random(in: 0.5...1.0)
    }

    /// Send the exact bytes of a batch. The same bytes are resent on retry so the Worker can recognise a request it already stored.
    func send(_ body: Data, completion: @escaping (UploadOutcome) -> Void) {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 30
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: request) { _, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else { return completion(.retry(after: nil)) }
            completion(Uploader.classify(status: http.statusCode, retryAfter: http.value(forHTTPHeaderField: "Retry-After")))
        }.resume()
    }
}
