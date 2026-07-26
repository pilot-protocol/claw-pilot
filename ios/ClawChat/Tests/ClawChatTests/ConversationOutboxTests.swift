// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers the iter-26 "type while offline → re-send on reconnect" flow at
// the layer that's testable without spinning up a real PilotConnection.
//
// The end-to-end "becomes ready → drains" path requires the real pilot
// daemon; this suite proves the bookkeeping invariants the drain depends on:
//   • sends while offline persist with .sending state
//   • the MessageStore wired to a Conversation survives an app-restart cycle
//   • drainOutbox is a safe no-op when there's no connection (won't crash if
//     called from an early state transition)

import XCTest
@testable import ClawChat

@MainActor
final class ConversationOutboxTests: XCTestCase {

    private var workDir: URL!

    override func setUpWithError() throws {
        workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("convo-outbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workDir)
    }

    func testOfflineSendsPersistAcrossAppRestart() {
        // Simulate session 1: type 2 messages while offline (no connection).
        let store1 = MessageStore(profileDir: workDir)
        do {
            let c = Conversation()
            c.messageStore = store1
            c.draft = "first while offline"
            c.send()
            c.draft = "second while offline"
            c.send()
            XCTAssertEqual(c.messages.count, 2)
            XCTAssertTrue(c.messages.allSatisfy { $0.delivery == .sending && $0.sender == .me })
        }

        // Simulate app restart: fresh Conversation, fresh MessageStore on the
        // same dir → loadFromStoreIfAvailable() should rehydrate them.
        let store2 = MessageStore(profileDir: workDir)
        let c2 = Conversation()
        c2.messageStore = store2
        c2.loadFromStoreIfAvailable()
        XCTAssertEqual(c2.messages.count, 2)
        XCTAssertEqual(c2.messages[0].text, "first while offline")
        XCTAssertEqual(c2.messages[1].text, "second while offline")
        // Both should still be .sending — they were never delivered.
        XCTAssertEqual(c2.messages[0].delivery, .sending)
        XCTAssertEqual(c2.messages[1].delivery, .sending)
    }

    func testLoadFromStoreIfAvailableIsIdempotentWhenAlreadyPopulated() {
        // The hook is called automatically on connect(); manual calls after
        // the chat is already populated must not duplicate anything.
        let store = MessageStore(profileDir: workDir)
        store.save([
            ChatMessage(id: "x", sender: .me, text: "x", delivery: .sent),
        ])
        let c = Conversation()
        c.messageStore = store
        c.loadFromStoreIfAvailable()
        XCTAssertEqual(c.messages.count, 1)
        c.loadFromStoreIfAvailable()
        XCTAssertEqual(c.messages.count, 1, "second call should be a no-op")
    }

    func testDrainOutboxWithoutConnectionIsSafe() {
        // Earliest moment drainOutbox could fire is right as connect() flips
        // state to .ready — but there's a path where connect() runs in a
        // Task and the connection ref hasn't been set yet. Make sure that
        // can't crash even with pending .failed messages on board.
        let c = Conversation()
        c.messageStore = MessageStore(profileDir: workDir)
        c.draft = "would have been sent"
        c.send()
        // Now force one of them to .failed via the public retry path —
        // actually we can't; updateDelivery is private. So just verify
        // drainOutbox with the connection still nil is a no-op + doesn't throw.
        c.drainOutbox()
        XCTAssertEqual(c.messages.count, 1)
        XCTAssertEqual(c.messages.first?.delivery, .sending)
    }

    func testNoStoreMeansNoPersistButSendStillQueues() {
        // Without a MessageStore wired, send() still appends to the in-memory
        // log. We don't crash, we don't lose the message — it's just not
        // persisted across an app restart.
        let c = Conversation()
        c.draft = "no store"
        c.send()
        XCTAssertEqual(c.messages.count, 1)
        XCTAssertEqual(c.messages.first?.delivery, .sending)
    }

    // MARK: - Attachments queued while offline

    func testOfflineAttachmentIsQueuedAsSending() {
        // sendAttachment with no connection must behave like send(): append
        // the message in .sending rather than discarding it.
        let c = Conversation()
        c.messageStore = MessageStore(profileDir: workDir)
        c.draft = "look at this"
        c.sendAttachment(
            kind: .image,
            bytes: Data([0xFF, 0xD8, 0xFF, 0xE0]),
            filename: "cat.jpg",
            mime: "image/jpeg"
        )
        XCTAssertEqual(c.messages.count, 1)
        let m = try? XCTUnwrap(c.messages.first)
        XCTAssertEqual(m?.delivery, .sending)
        XCTAssertEqual(m?.sender, .me)
        XCTAssertEqual(m?.text, "look at this", "caption should ride along with the attachment")
        XCTAssertEqual(m?.attachments.count, 1)
        XCTAssertEqual(m?.attachments.first?.filename, "cat.jpg")
        XCTAssertEqual(c.draft, "", "draft is consumed as the caption")
    }

    func testOfflineAttachmentSurvivesAppRestartWithBytesIntact() {
        let bytes = Data([0x01, 0x02, 0x03, 0x04, 0x05])
        do {
            let c = Conversation()
            c.messageStore = MessageStore(profileDir: workDir)
            c.sendAttachment(kind: .file, bytes: bytes, filename: "doc.bin", mime: "application/octet-stream")
            XCTAssertEqual(c.messages.count, 1)
        }

        // Fresh Conversation + store on the same dir, as after a cold launch.
        let c2 = Conversation()
        c2.messageStore = MessageStore(profileDir: workDir)
        c2.loadFromStoreIfAvailable()
        XCTAssertEqual(c2.messages.count, 1, "the queued attachment must be persisted, not dropped")
        let m = c2.messages.first
        XCTAssertEqual(m?.delivery, .sending)
        XCTAssertEqual(m?.attachments.count, 1, "attachment must survive the round-trip")
        XCTAssertEqual(m?.attachments.first?.bytes, bytes, "attachment bytes must be byte-identical")
        XCTAssertEqual(m?.attachments.first?.kind, .file)
        XCTAssertEqual(m?.attachments.first?.mime, "application/octet-stream")
    }

    func testRehydratedAttachmentIsSelectedByTheDrainQueue() {
        // drainOutbox re-sends every from-me message left in .sending/.failed.
        // A rehydrated media message must qualify, and must still carry the
        // attachment that the media send path needs.
        let c = Conversation()
        c.messageStore = MessageStore(profileDir: workDir)
        c.draft = "caption"
        c.sendAttachment(kind: .audio, bytes: Data([0x11, 0x22]), filename: "vm.m4a", mime: "audio/mp4")
        c.draft = "text only"
        c.send()

        let c2 = Conversation()
        c2.messageStore = MessageStore(profileDir: workDir)
        c2.loadFromStoreIfAvailable()

        let pending = c2.messages.filter { $0.sender == .me && $0.delivery == .sending }
        XCTAssertEqual(pending.count, 2)
        let withMedia = pending.filter { !$0.attachments.isEmpty }
        XCTAssertEqual(withMedia.count, 1, "the media message must be part of the drain set")
        XCTAssertEqual(withMedia.first?.attachments.first?.kind, .audio)
        // The drain branches on this to pick the media send path over text.
        XCTAssertEqual(withMedia.first?.attachments.first?.wireKind, .audio)
        XCTAssertEqual(withMedia.first?.text, "caption")

        // And the text-only message must still route via the text path.
        let textOnly = pending.filter { $0.attachments.isEmpty }
        XCTAssertEqual(textOnly.count, 1)
        XCTAssertEqual(textOnly.first?.text, "text only")
    }

    func testAttachmentWireKindMapping() {
        // The mapping drainOutbox uses to re-send a persisted attachment.
        XCTAssertEqual(ChatAttachment(kind: .image, bytes: Data()).wireKind, .image)
        XCTAssertEqual(ChatAttachment(kind: .audio, bytes: Data()).wireKind, .audio)
        XCTAssertEqual(ChatAttachment(kind: .file, bytes: Data()).wireKind, .file)
    }
}
