// swift-tools-version:5.9
import PackageDescription

// Swift Package Manager reads the manifest at the repository root, so this one exposes the Swift SDK that lives in sdks/swift.
// Add https://github.com/hitSlop/slurp in Xcode (or as a package dependency) and `import Slurp`.
let package = Package(
    name: "Slurp",
    platforms: [.iOS(.v13), .macOS(.v10_15), .tvOS(.v13), .watchOS(.v6)],
    products: [.library(name: "Slurp", targets: ["Slurp"])],
    targets: [
        .target(name: "Slurp", path: "sdks/swift/Sources/Slurp"),
        .testTarget(name: "SlurpTests", dependencies: ["Slurp"], path: "sdks/swift/Tests/SlurpTests"),
    ]
)
