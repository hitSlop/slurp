// swift-tools-version:5.9
import PackageDescription

// For developing the SDK on its own. People who use it add the repository root, whose Package.swift points at these same sources.
let package = Package(
    name: "Slurp",
    // FileHandle.seekToEnd() and write(contentsOf:), which the queue uses so a full disk is an error and not a crash, arrived in these OS versions.
    platforms: [.iOS("13.4"), .macOS("10.15.4"), .tvOS("13.4"), .watchOS("6.2")],
    products: [.library(name: "Slurp", targets: ["Slurp"])],
    targets: [
        .target(name: "Slurp", path: "Sources/Slurp"),
        .testTarget(name: "SlurpTests", dependencies: ["Slurp"], path: "Tests/SlurpTests"),
    ]
)
