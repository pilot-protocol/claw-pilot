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
    // connection has never been started (no Pilot to tear down) — it just
    // proceeds to start(). The real start() will fail in unit tests because
    // there's no daemon backing the SDK; what we're asserting here is that
    // the tearDown path doesn't blow up on a fresh connection, and that
    // failure propagates as a normal Error (not a crash or precondition).
    func testReconnectOnFreshConnectionFailsCleanly() async {
        let conn = PilotConnection(config: makeConfig())
        do {
            try await conn.reconnect(maxAttempts: 1)
            // Reaching here would mean a real Pilot daemon booted — in unit
            // tests we don't have one. The SDK call should throw.
            XCTFail("expected reconnect to throw — no real Pilot daemon in unit-test env")
        } catch {
            // Any thrown error is acceptable; we're verifying the tearDown
            // path doesn't precondition-fail and that reconnect propagates
            // failures cleanly. After failure, isReady must be false.
            XCTAssertFalse(conn.isReady)
            XCTAssertNil(conn.selfAddress)
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
                // Expected — no real daemon. Loop verifies subsequent calls
                // don't trip on residual state.
            }
        }
        XCTAssertFalse(conn.isReady)
    }
}
