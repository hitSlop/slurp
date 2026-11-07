// swift-tools-version:5.9
import PackageDescription

// For developing the SDK on its own. People who use it add the repository root, whose Package.swift points at these same sources.
let package = Package(
    name: "Slurp",
    platforms: [.iOS(.v13), .macOS(.v10_15), .tvOS(.v13), .watchOS(.v6)],
    products: [.library(name: "Slurp", targets: ["Slurp"])],
    targets: [
        .target(name: "Slurp", path: "Sources/Slurp"),
        .testTarget(name: "SlurpTests", dependencies: ["Slurp"], path: "Tests/SlurpTests"),
    ]
)
