// swift-tools-version:5.9
import PackageDescription

// Swift Package Manager reads the manifest at the repository root, so this one exposes the Swift SDK that lives in sdks/swift.
// Add https://github.com/hitSlop/slurp in Xcode (or as a package dependency) and `import Slurp`.
let package = Package(
    name: "Slurp",
    // FileHandle.seekToEnd() and write(contentsOf:), which the queue uses so a full disk is an error and not a crash, arrived in these OS versions.
    platforms: [.iOS("13.4"), .macOS("10.15.4"), .tvOS("13.4"), .watchOS("6.2")],
    products: [.library(name: "Slurp", targets: ["Slurp"])],
    targets: [
        .target(name: "Slurp", path: "sdks/swift/Sources/Slurp"),
        .testTarget(name: "SlurpTests", dependencies: ["Slurp"], path: "sdks/swift/Tests/SlurpTests"),
    ]
)
