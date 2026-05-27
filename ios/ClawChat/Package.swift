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
        // Pilot SwiftPM is published with URL-based binary distribution at
        // pilot-protocol/sdk-swift v0.2.0+. SwiftPM downloads + checksums
        // the xcframework — no local clone or manual build step required.
        // For dev iteration on the SDK itself, point this at a local path
        // with `.package(path: "../../../sdk-swift")` and `swift package edit`.
        .package(url: "https://github.com/pilot-protocol/sdk-swift.git", from: "0.2.0"),
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
