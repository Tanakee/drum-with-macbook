// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "drum-bridge",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "drum-bridge", targets: ["drum-bridge"])],
    targets: [.executableTarget(name: "drum-bridge")],
    swiftLanguageVersions: [.v5]
)
