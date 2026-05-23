// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NotificationCoordinator is OS-bound (UNUserNotificationCenter + UIKit
// state), so most of its surface can only be tested on device. The one
// piece that's pure logic and worth a unit test is the preview clamp —
// keeps us from accidentally regressing the truncation behavior the next
// time someone touches the notification body shape.

import XCTest
@testable import ClawChat

final class NotificationCoordinatorTests: XCTestCase {

    func testShortPreviewPassesThrough() {
        let c = NotificationCoordinator.shared
        XCTAssertEqual(c.previewClamp(""), "")
        XCTAssertEqual(c.previewClamp("hi"), "hi")
        XCTAssertEqual(c.previewClamp(String(repeating: "a", count: 200)),
                       String(repeating: "a", count: 200))
    }

    func testPreviewClampedAt200CharsWithEllipsis() {
        let c = NotificationCoordinator.shared
        let long = String(repeating: "x", count: 500)
        let clamped = c.previewClamp(long)
        XCTAssertEqual(clamped.count, 200) // 199 chars + ellipsis
        XCTAssertTrue(clamped.hasSuffix("…"))
        XCTAssertTrue(clamped.dropLast().allSatisfy { $0 == "x" })
    }

    func testPreviewClampPreservesUnicode() {
        let c = NotificationCoordinator.shared
        // Mix of single + multi-byte glyphs; .count is grapheme count which
        // is what the user actually sees.
        let s = String(repeating: "🦞", count: 201) // each emoji counts as 1 grapheme
        let clamped = c.previewClamp(s)
        XCTAssertEqual(clamped.count, 200)
        XCTAssertTrue(clamped.hasSuffix("…"))
    }
}
