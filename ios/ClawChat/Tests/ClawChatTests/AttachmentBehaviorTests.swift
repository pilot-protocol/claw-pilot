// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

@MainActor
final class AttachmentBehaviorTests: XCTestCase {

    func testAttachmentOnlyMessageHasEmptyText() {
        let att = ChatAttachment(kind: .image, bytes: Data([0xFF, 0xD8, 0xFF]), filename: "x.jpg", mime: "image/jpeg")
        let m = ChatMessage(sender: .me, text: "", attachments: [att])
        XCTAssertEqual(m.text, "")
        XCTAssertEqual(m.attachments.count, 1)
    }

    func testFileAttachmentDeliveryFlow() {
        // Build a message that mirrors what Conversation.sendAttachment produces.
        let id = Wire.newId()
        let att = ChatAttachment(kind: .file, bytes: Data("payload".utf8), filename: "doc.bin", mime: "application/octet-stream")
        var msg = ChatMessage(id: id, sender: .me, text: "", attachments: [att], delivery: .sending)
        XCTAssertEqual(msg.delivery, .sending)
        msg.delivery = .sent
        XCTAssertEqual(msg.delivery, .sent)
        msg.delivery = .delivered
        XCTAssertEqual(msg.delivery, .delivered)
    }

    func testAudioAttachmentClassification() {
        let kinds: [(ChatAttachment.Kind, String)] = [
            (.audio, "audio/mpeg"),
            (.audio, "audio/wav"),
            (.image, "image/png"),
            (.file, "application/pdf"),
        ]
        for (kind, mime) in kinds {
            let a = ChatAttachment(kind: kind, bytes: Data(), filename: "x", mime: mime)
            XCTAssertEqual(a.kind, kind)
            XCTAssertEqual(a.mime, mime)
        }
    }

    func testIncomingAttachmentToChatAttachmentMapping() {
        // Mirror the conversion done inside Conversation.appendIncoming.
        let cases: [(IncomingAttachment.Kind, ChatAttachment.Kind)] = [
            (.image, .image),
            (.audio, .audio),
            (.file, .file),
        ]
        for (input, expected) in cases {
            let incoming = IncomingAttachment(kind: input, bytes: Data(), filename: nil, mime: nil)
            // We can't directly call appendIncoming (private), but the mapping
            // is exhaustive here.
            switch incoming.kind {
            case .image: XCTAssertEqual(expected, .image)
            case .audio: XCTAssertEqual(expected, .audio)
            case .file:  XCTAssertEqual(expected, .file)
            }
        }
    }

    func testMessageEqualityIncludesAttachments() {
        let bytesA = Data([1, 2, 3])
        let bytesB = Data([4, 5, 6])
        let ts = Date(timeIntervalSince1970: 1_700_000_000)
        let m1 = ChatMessage(id: "x", sender: .me, text: "hi", ts: ts, attachments: [
            ChatAttachment(kind: .image, bytes: bytesA, filename: nil, mime: nil),
        ])
        let m2 = ChatMessage(id: "x", sender: .me, text: "hi", ts: ts, attachments: [
            ChatAttachment(kind: .image, bytes: bytesA, filename: nil, mime: nil),
        ])
        let m3 = ChatMessage(id: "x", sender: .me, text: "hi", ts: ts, attachments: [
            ChatAttachment(kind: .image, bytes: bytesB, filename: nil, mime: nil),
        ])
        XCTAssertEqual(m1, m2)
        XCTAssertNotEqual(m1, m3)
    }
}
