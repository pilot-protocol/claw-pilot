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

    // Watchdog never trips on an idle conversation (no connection, no
    // outbound messages). Used to be invisible; now it must be observably
    // safe to call.
    func testWatchdogCheckOnIdleConversationIsNoop() {
        let c = Conversation()
        c.runWatchdogCheck()
        XCTAssertEqual(c.state, .idle)
        XCTAssertNil(c.statusMessage)
    }

    // Status message field is the observability surface the UI renders.
    // Init state must be nil so the UI can decide whether to show anything.
    func testInitialStatusMessageIsNil() {
        let c = Conversation()
        XCTAssertNil(c.statusMessage)
        XCTAssertNil(c.lastAckAt)
    }

    // Disconnect must be safe even when the Conversation has never been
    // wired to a Pilot — the host code may call disconnect() defensively
    // from onDisappear regardless of prior state.
    func testDisconnectOnIdleIsSafe() {
        let c = Conversation()
        c.disconnect()
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.statusMessage, "disconnected")
    }

    // disconnect() must always update the user-visible status — without
    // this the UI shows a stale status after the user backs out of the chat.
    func testDisconnectSetsStatusEvenAfterRepeatedCalls() {
        let c = Conversation()
        c.disconnect()
        c.disconnect()  // idempotent
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.statusMessage, "disconnected")
    }

    // Watchdog API must be callable any number of times in either order
    // without crashing — the host UI's refresh logic should not have to
    // track whether the watchdog is currently running.
    func testWatchdogStartStopIsReentrant() {
        let c = Conversation()
        c.startWatchdog()
        c.startWatchdog()  // replaces — no double-fire
        c.stopWatchdog()
        c.stopWatchdog()   // no-op
        c.startWatchdog()
        c.stopWatchdog()
        // No assertions other than "doesn't crash"; the side effect we
        // care about is internal task cancellation, observable only via
        // the absence of leaked timers in long-running test runs.
    }

    // The wedge-recovery watchdog must early-return when there's no live
    // connection, otherwise it would spuriously call refresh() into a nil
    // PilotConnection on app launch.
    func testWatchdogCheckBeforeConnectIsNoop() {
        let c = Conversation()
        c.runWatchdogCheck()
        XCTAssertNil(c.statusMessage)  // didn't trip
        XCTAssertEqual(c.state, .idle)  // didn't try to refresh
    }

    // observeAppForeground/stopObservingAppForeground are gated by
    // canImport(UIKit) but must still be safe call sites on macOS test
    // builds. Calling each multiple times must be a no-op.
    func testForegroundObserverHooksAreSafeOnAllPlatforms() {
        let c = Conversation()
        c.observeAppForeground()
        c.observeAppForeground()         // idempotent
        c.stopObservingAppForeground()
        c.stopObservingAppForeground()   // no-op
    }

    // refresh() requires an active connection to do anything; calling it
    // before connect() must not crash or transition state.
    func testRefreshBeforeConnectIsNoop() {
        let c = Conversation()
        c.refresh()
        XCTAssertEqual(c.state, .idle)
        XCTAssertNil(c.statusMessage)
    }

    // Watchdog tuning knobs must round-trip — the settings page (Phase C)
    // will mutate them and we don't want type errors when that lands.
    func testWatchdogTuningKnobsAreMutable() {
        let c = Conversation()
        XCTAssertEqual(c.watchdogIntervalSeconds, 30)
        XCTAssertEqual(c.watchdogStuckThresholdSeconds, 60)
        c.watchdogIntervalSeconds = 10
        c.watchdogStuckThresholdSeconds = 45
        XCTAssertEqual(c.watchdogIntervalSeconds, 10)
        XCTAssertEqual(c.watchdogStuckThresholdSeconds, 45)
    }
}
