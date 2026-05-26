// swift-tools-version:5.9
// SPDX-License-Identifier: AGPL-3.0-or-later

import PackageDescription

// ClawChat is shipped as a Swift Package so the wire/connection/view-model
// layers can be `swift test`-d without an Xcode project. The actual iOS app
// target lives in ios/ClawChatApp.xcodeproj and depends on this package +
// the Pilot SwiftPM (sibling repo `sdk-swift` in the pilot-protocol org).

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
        // Pilot SwiftPM lives at `pilot-protocol/sdk-swift` (sibling repo).
        // Override locally if your checkout is elsewhere.
        .package(path: "../../../sdk-swift"),
    ],
    targets: [
        .target(
            name: "ClawChat",
            dependencies: [
                .product(name: "Pilot", package: "sdk-swift"),
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
