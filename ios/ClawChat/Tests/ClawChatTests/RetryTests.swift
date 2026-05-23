// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

final class RetryTests: XCTestCase {

    func testConfigMatchesExpectedShape() {
        let cfg = PilotConnection.Config(
            dataDir: URL(fileURLWithPath: "/tmp/claw-pilot-retry-tests"),
            claw: ClawAddress(address: "1:0000.0000.AAAA", nodeId: 42)
        )
        // Sanity check that the network-9 stance is hardcoded.
        XCTAssertFalse(cfg.joinsPublicDirectory)
    }

    func testTrustTimeoutErrorDescription() {
        let e = ConnectionError.trustTimeout
        XCTAssertTrue(String(describing: e).contains("trust"))
    }

    func testHandshakeFailedRetainsCause() {
        let e = ConnectionError.handshakeFailed("registry: node not found")
        let s = String(describing: e)
        XCTAssertTrue(s.contains("registry"), "got: \(s)")
    }

    /// Black-box test of the public backoff schedule via observation of
    /// retryHandshake when the underlying Pilot daemon isn't started — we can
    /// validate the early-return-on-notStarted path without booting Pilot.
    func testRetryHandshakeRequiresStartFirst() async {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ret-\(UUID().uuidString)")
        let conn = PilotConnection(config: .init(
            dataDir: dir,
            claw: ClawAddress(address: "1:0000.0000.AAAA", nodeId: 42)
        ))
        do {
            try await conn.retryHandshake(maxAttempts: 1)
            XCTFail("expected notStarted error")
        } catch let e as ConnectionError {
            XCTAssertTrue(String(describing: e).contains("not started"))
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }
}

@MainActor
final class ConversationRefreshTests: XCTestCase {

    func testRefreshOnIdleNoOps() {
        let c = Conversation()
        // No connection yet; refresh should be a safe no-op.
        c.refresh()
        XCTAssertEqual(c.state, .idle)
    }

    func testTestConnectionWhenNotReadyNoOps() {
        let c = Conversation()
        c.testConnection()
        XCTAssertTrue(c.messages.isEmpty)
    }
}
