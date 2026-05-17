// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TeleopNative",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "TeleopUI", targets: ["TeleopUI"]),
        .executable(name: "TeleopMac", targets: ["TeleopMac"]),
    ],
    targets: [
        .target(name: "TeleopUI"),
        .executableTarget(
            name: "TeleopMac",
            dependencies: ["TeleopUI"]
        ),
    ]
)
