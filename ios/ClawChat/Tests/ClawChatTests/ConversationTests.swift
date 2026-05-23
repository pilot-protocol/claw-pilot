// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

@MainActor
final class ConversationTests: XCTestCase {

    func testInitialState() {
        let c = Conversation()
        XCTAssertEqual(c.state, .idle)
        XCTAssertTrue(c.messages.isEmpty)
        XCTAssertEqual(c.draft, "")
    }

    func testSendWhenNotReadyQueuesAsSending() {
        // Pre-iter26 behavior: send() was a no-op when not connected.
        // New behavior (iter26): the message is appended in `.sending` state
        // and drainOutbox() will pick it up when the connection becomes ready.
        // This is what makes "type while offline, send when reconnected" work.
        let c = Conversation()
        c.draft = "hello"
        c.send()
        XCTAssertEqual(c.messages.count, 1)
        XCTAssertEqual(c.messages.first?.text, "hello")
        XCTAssertEqual(c.messages.first?.delivery, .sending)
        XCTAssertEqual(c.messages.first?.sender, .me)
        XCTAssertEqual(c.draft, "") // cleared regardless of connection state
    }

    func testChatMessageEquality() {
        let a = ChatMessage(id: "id", sender: .me, text: "x", ts: Date(timeIntervalSince1970: 0))
        let b = ChatMessage(id: "id", sender: .me, text: "x", ts: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(a, b)
    }

    func testChatMessageCarriesAttachments() {
        let att = ChatAttachment(kind: .image, bytes: Data([0xFF, 0xD8, 0xFF]), filename: "x.jpg", mime: "image/jpeg")
        let msg = ChatMessage(id: "m1", sender: .claw, text: "see", attachments: [att])
        XCTAssertEqual(msg.attachments.count, 1)
        XCTAssertEqual(msg.attachments.first?.kind, .image)
        XCTAssertEqual(msg.attachments.first?.bytes.count, 3)
    }

    func testSendAttachmentWhenNotReadyIsIgnored() {
        let c = Conversation()
        c.sendAttachment(kind: .image, bytes: Data([1, 2, 3]), filename: "x.png", mime: "image/png")
        XCTAssertTrue(c.messages.isEmpty)
    }

    func testIncomingAttachmentKindMapping() {
        // Verify the conversion path stays exhaustive.
        let kinds: [IncomingAttachment.Kind] = [.image, .file, .audio]
        for k in kinds {
            let att = IncomingAttachment(kind: k, bytes: Data(), filename: nil, mime: nil)
            XCTAssertEqual(att.kind, k)
        }
    }
}
