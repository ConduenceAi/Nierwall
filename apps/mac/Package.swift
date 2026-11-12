// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Guardian",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Guardian",
            path: "Sources/Guardian",
            linkerSettings: [.linkedFramework("Carbon")]
        )
    ]
)
