// swift-tools-version:5.9
// The real Segment iOS/macOS SDK (analytics-swift), pinned, driven against a local Worker by backend/test/compat-swift.test.ts.
// The version is exact; Package.resolved also pins its two dependencies (sovran-swift, jsonsafeencoding-swift).
import PackageDescription

let package = Package(
    name: "slurp-compat-swift",
    platforms: [.macOS("13.0")],
    dependencies: [
        .package(url: "https://github.com/segmentio/analytics-swift", exact: "1.10.4"),
    ],
    targets: [
        .executableTarget(
            name: "slurp-compat-swift",
            dependencies: [.product(name: "Segment", package: "analytics-swift")]
        ),
    ]
)
