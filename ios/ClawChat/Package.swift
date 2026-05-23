// swift-tools-version:5.9
// SPDX-License-Identifier: AGPL-3.0-or-later

import PackageDescription

// ClawChat is shipped as a Swift Package so the wire/connection/view-model
// layers can be `swift test`-d without an Xcode project. The actual iOS app
// target lives in ios/ClawChatApp.xcodeproj and depends on this package +
// the Pilot SwiftPM (from the web4 repo).

let package = Package(
    name: "ClawChat",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "ClawChat", targets: ["ClawChat"]),
    ],
    dependencies: [
        // Pilot SDK comes from the web4 monorepo sibling. When you embed
        // this package into an Xcode project, set the local path to your
        // actual Development/web4/sdk/swift checkout.
        .package(path: "../../../web4/sdk/swift"),
    ],
    targets: [
        .target(
            name: "ClawChat",
            dependencies: [
                .product(name: "Pilot", package: "swift"),
            ],
            path: "Sources/ClawChat"
        ),
        .testTarget(
            name: "ClawChatTests",
            dependencies: ["ClawChat"],
            path: "Tests/ClawChatTests"
        ),
    ]
)
