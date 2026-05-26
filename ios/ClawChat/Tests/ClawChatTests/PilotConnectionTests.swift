// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PilotConnection unit tests. We don't boot a real Pilot daemon here —
// that's the e2e harness's job — but we can verify:
//   • initial state (not started, no address)
//   • Config defaults
//   • send() rejects when not started
//   • IncomingMessage / ClawAddress value semantics

import XCTest
@testable import ClawChat

final class PilotConnectionTests: XCTestCase {

    private func makeConfig() -> PilotConnection.Config {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pilot-connection-test-\(UUID().uuidString)")
        return PilotConnection.Config(
            dataDir: dir,
            socketBasename: "p.sock",
            claw: ClawAddress(address: "1:0000.0000.AAAA", nodeId: 42),
            clawAppPort: 7777,
            trustTimeoutMs: 5_000,
            trustAutoApprove: true
        )
    }

    func testInitialState() {
        let conn = PilotConnection(config: makeConfig())
        XCTAssertFalse(conn.isReady)
        XCTAssertNil(conn.selfAddress)
        XCTAssertNil(conn.selfNodeId)
    }

    func testSendBeforeStartThrows() async {
        let conn = PilotConnection(config: makeConfig())
        do {
            _ = try await conn.send(text: "ping")
            XCTFail("expected throw")
        } catch let e as ConnectionError {
            XCTAssertEqual(String(describing: e), "pilot connection not started")
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func testConfigDefaults() {
        let cfg = PilotConnection.Config(
            dataDir: URL(fileURLWithPath: "/tmp/x"),
            claw: ClawAddress(address: "2:1111.2222.3333", nodeId: 7)
        )
        XCTAssertEqual(cfg.socketBasename, "p.sock")
        XCTAssertEqual(cfg.clawAppPort, 7777)
        XCTAssertEqual(cfg.trustTimeoutMs, 30_000)
        XCTAssertTrue(cfg.trustAutoApprove)
    }

    func testClawAddressEquality() {
        let a = ClawAddress(address: "1:0000.0000.AAAA", nodeId: 42)
        let b = ClawAddress(address: "1:0000.0000.AAAA", nodeId: 42)
        let c = ClawAddress(address: "1:0000.0000.BBBB", nodeId: 42)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    func testIncomingMessageEquality() {
        let m1 = IncomingMessage(id: "x", text: "hi", ts: 1, senderAddress: "1:0000.0000.AAAA")
        let m2 = IncomingMessage(id: "x", text: "hi", ts: 1, senderAddress: "1:0000.0000.AAAA")
        XCTAssertEqual(m1, m2)
    }

    func testConnectionErrorMessages() {
        XCTAssertTrue(String(describing: ConnectionError.notStarted).contains("not started"))
        XCTAssertTrue(String(describing: ConnectionError.trustTimeout).contains("timed out"))
        XCTAssertTrue(String(describing: ConnectionError.handshakeFailed("boom")).contains("boom"))
        XCTAssertTrue(String(describing: ConnectionError.sendFailed("boom")).contains("boom"))
    }

    // Wedge-recovery contract: reconnect() must be safe to call when the
    // connection has never been started (no Pilot to tear down). The
    // embedded SDK actually boots a real daemon in tests so selfAddress
    // may get populated, but the handshake against fake peer 42 will fail.
    // What we're asserting: the tearDown path doesn't precondition-fail,
    // the handshake error propagates as a regular Error, and `isReady`
    // ends up false so the caller knows not to send.
    func testReconnectOnFreshConnectionFailsCleanly() async {
        let conn = PilotConnection(config: makeConfig())
        do {
            try await conn.reconnect(maxAttempts: 1)
            XCTFail("expected reconnect to throw — fake peer should fail handshake")
        } catch {
            XCTAssertFalse(conn.isReady)
        }
    }

    // Calling reconnect() twice in a row must not crash even when the first
    // attempt left no Pilot instance behind. Defensive against the "user
    // hammers the Reconnect button" UX.
    func testReconnectIsIdempotentOnFailure() async {
        let conn = PilotConnection(config: makeConfig())
        for _ in 0..<3 {
            do {
                try await conn.reconnect(maxAttempts: 1)
            } catch {
                // Expected — fake peer. Loop verifies subsequent calls
                // don't trip on residual state.
            }
        }
        XCTAssertFalse(conn.isReady)
    }

    // stop() on a never-started PilotConnection must be safe — host code
    // commonly calls disconnect() from onDisappear regardless of prior
    // state. After stop(), isReady stays false and another stop is a no-op.
    func testStopOnFreshConnectionIsSafe() {
        let conn = PilotConnection(config: makeConfig())
        conn.stop()
        XCTAssertFalse(conn.isReady)
        conn.stop()
        XCTAssertFalse(conn.isReady)
    }

    // stop() after a failed reconnect() must drain whatever partial state
    // start() left behind. The tearDown is a shared codepath; we're
    // verifying it doesn't crash and that subsequent reconnect attempts
    // still throw cleanly rather than hitting a precondition.
    func testStopAfterFailedReconnectThenAnotherReconnect() async {
        let conn = PilotConnection(config: makeConfig())
        do {
            try await conn.reconnect(maxAttempts: 1)
        } catch { /* expected */ }
        conn.stop()
        XCTAssertFalse(conn.isReady)
        do {
            try await conn.reconnect(maxAttempts: 1)
            XCTFail("expected handshake to fail against fake peer 42")
        } catch {
            XCTAssertFalse(conn.isReady)
        }
    }
}
