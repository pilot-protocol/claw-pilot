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
}
