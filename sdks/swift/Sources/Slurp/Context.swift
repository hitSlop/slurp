import Foundation

/// Device, OS and app facts added to every event as `context`. Your own `context` closure is merged over these.
enum DeviceContext {
    static func make(library: [String: Any] = ["name": "slurp-swift", "version": slurpVersion]) -> [String: Any] {
        var context: [String: Any] = ["library": library]
        let v = ProcessInfo.processInfo.operatingSystemVersion
        context["os"] = ["name": osName, "version": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"]
        if let model = deviceModel() { context["device"] = ["model": model] }
        var app: [String: Any] = [:]
        let info = Bundle.main.infoDictionary ?? [:]
        if let version = info["CFBundleShortVersionString"] as? String { app["version"] = version }
        if let build = info["CFBundleVersion"] as? String { app["build"] = build }
        if let id = Bundle.main.bundleIdentifier { app["id"] = id }
        if !app.isEmpty { context["app"] = app }
        context["locale"] = Locale.current.identifier
        context["timezone"] = TimeZone.current.identifier
        return context
    }

    static var osName: String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #elseif os(tvOS)
        return "tvOS"
        #elseif os(watchOS)
        return "watchOS"
        #else
        return "unknown"
        #endif
    }

    static func deviceModel() -> String? {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        #if os(macOS)
        let name = "hw.model"
        #else
        let name = "hw.machine"
        #endif
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &bytes, &size, nil, 0) == 0 else { return nil }
        return String(cString: bytes)
    }
}
