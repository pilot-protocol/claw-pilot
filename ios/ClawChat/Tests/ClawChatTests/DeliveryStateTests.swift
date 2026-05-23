// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

@MainActor
final class DeliveryStateTests: XCTestCase {

    func testDefaultDeliveryIsSent() {
        let m = ChatMessage(sender: .me, text: "hi")
        XCTAssertEqual(m.delivery, .sent)
    }

    func testFailedEquality() {
        let a: ChatDeliveryState = .failed("boom")
        let b: ChatDeliveryState = .failed("boom")
        let c: ChatDeliveryState = .failed("other")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    func testMessageMutatesDelivery() {
        var m = ChatMessage(id: "x", sender: .me, text: "hi", delivery: .sending)
        m.delivery = .delivered
        XCTAssertEqual(m.delivery, .delivered)
    }

    func testAckEnvelopeDecode() throws {
        // TS-encoded ack envelope: { v:1, kind:"ack", id:"a", ts:1 }
        let bytes = "{\"v\":1,\"kind\":\"ack\",\"id\":\"a\",\"ts\":1}".data(using: .utf8)!
        let env = try Wire.decode(bytes)
        XCTAssertEqual(env.kind, .ack)
        XCTAssertEqual(env.id, "a")
        XCTAssertNil(env.text)
    }

    func testAckEnvelopeEncode() throws {
        let env = Wire.Envelope(kind: .ack, id: "abc", ts: 100)
        let bytes = try Wire.encode(env)
        let back = try Wire.decode(bytes)
        XCTAssertEqual(back.kind, .ack)
        XCTAssertEqual(back.id, "abc")
    }
}
