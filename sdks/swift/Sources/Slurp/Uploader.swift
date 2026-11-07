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
    /// A request that gets no answer within this many seconds is cancelled and retried with the same bytes.
    var timeout: TimeInterval = 30

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
    /// The completion runs exactly once: with the Worker's answer, or `.retry` if the request fails or times out.
    func send(_ body: Data, completion: @escaping (UploadOutcome) -> Void) {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = timeout
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let once = Once(completion)
        let task = session.dataTask(with: request) { _, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else { once.call(.retry(after: nil)); return }
            once.call(Uploader.classify(status: http.statusCode, retryAfter: http.value(forHTTPHeaderField: "Retry-After")))
        }
        // URLSession's own timeout does not cover every transport (or a custom URLProtocol), so enforce the deadline here too.
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            if once.call(.retry(after: nil)) { task.cancel() }
        }
        task.resume()
    }
}

/// Runs a completion at most once, from any thread.
private final class Once {
    private let lock = NSLock()
    private var completion: ((UploadOutcome) -> Void)?
    init(_ completion: @escaping (UploadOutcome) -> Void) { self.completion = completion }
    /// True if this call was the one that ran the completion.
    @discardableResult
    func call(_ outcome: UploadOutcome) -> Bool {
        lock.lock()
        let run = completion
        completion = nil
        lock.unlock()
        run?(outcome)
        return run != nil
    }
}
