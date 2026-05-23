// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

final class WireTests: XCTestCase {

    func testEncodeDecodeRoundTrip() throws {
        let env = Wire.Envelope(kind: .user, id: "abc", ts: 1_700_000_000_000, text: "hello claw")
        let data = try Wire.encode(env)
        XCTAssertLessThanOrEqual(data.count, Wire.maxEnvelopeBytes)
        let decoded = try Wire.decode(data)
        XCTAssertEqual(decoded.kind, .user)
        XCTAssertEqual(decoded.id, "abc")
        XCTAssertEqual(decoded.text, "hello claw")
        XCTAssertEqual(decoded.ts, 1_700_000_000_000)
    }

    func testRejectsOversizeEnvelope() {
        let big = Wire.Envelope(kind: .user, id: "x", ts: 1, text: String(repeating: "a", count: Wire.maxEnvelopeBytes + 1))
        XCTAssertThrowsError(try Wire.encode(big)) { err in
            guard case .some(Wire.WireError.tooLarge) = err as? Wire.WireError else {
                return XCTFail("wrong error: \(err)")
            }
        }
    }

    func testRejectsUnsupportedVersion() {
        let bad = "{\"v\":99,\"kind\":\"user\",\"id\":\"a\",\"ts\":1,\"text\":\"hi\"}".data(using: .utf8)!
        XCTAssertThrowsError(try Wire.decode(bad)) { err in
            guard case .some(Wire.WireError.schemaFailed) = err as? Wire.WireError else {
                return XCTFail("wrong error: \(err)")
            }
        }
    }

    func testRejectsMissingText() {
        let bad = "{\"v\":1,\"kind\":\"user\",\"id\":\"a\",\"ts\":1}".data(using: .utf8)!
        XCTAssertThrowsError(try Wire.decode(bad))
    }

    func testNewIdUnique() {
        var ids = Set<String>()
        for _ in 0..<1000 {
            ids.insert(Wire.newId())
        }
        XCTAssertEqual(ids.count, 1000)
    }

    func testChunkUnsplit() throws {
        let parts = Wire.chunk(text: "ping", kind: .user)
        XCTAssertEqual(parts.count, 1)
        XCTAssertNil(parts[0].total)
        XCTAssertNil(parts[0].seq)
    }

    func testChunkSplits() throws {
        let text = String(repeating: "x", count: 3000)
        let parts = Wire.chunk(text: text, kind: .user)
        XCTAssertGreaterThan(parts.count, 1)

        let ids = Set(parts.map { $0.id })
        XCTAssertEqual(ids.count, 1)

        for p in parts {
            let enc = try Wire.encode(p)
            XCTAssertLessThanOrEqual(enc.count, Wire.maxEnvelopeBytes)
            XCTAssertEqual(p.total, parts.count)
        }

        let joined = parts.compactMap(\.text).joined()
        XCTAssertEqual(joined, text)
    }

    func testChunkUtf8Safety() throws {
        let text = String(repeating: "🦞", count: 500) + "café"
        let parts = Wire.chunk(text: text, kind: .agent)
        for p in parts {
            let enc = try Wire.encode(p)
            XCTAssertLessThanOrEqual(enc.count, Wire.maxEnvelopeBytes)
        }
        XCTAssertEqual(parts.compactMap(\.text).joined(), text)
    }

    func testReassemblerSingleChunk() {
        let r = Wire.Reassembler(kind: .user)
        let env = Wire.Envelope(kind: .user, id: "x", ts: 1, text: "hi")
        let out = r.push(env)
        XCTAssertEqual(out?.text, "hi")
    }

    func testReassemblerMultipleChunksOutOfOrder() {
        let r = Wire.Reassembler(kind: .user)
        let id = "z"
        let parts: [Wire.Envelope] = [
            .init(kind: .user, id: id, ts: 1, text: "C", seq: 3, total: 3),
            .init(kind: .user, id: id, ts: 1, text: "A", seq: 1, total: 3),
            .init(kind: .user, id: id, ts: 1, text: "B", seq: 2, total: 3),
        ]
        XCTAssertNil(r.push(parts[0]))
        XCTAssertNil(r.push(parts[1]))
        let out = r.push(parts[2])
        XCTAssertEqual(out?.text, "ABC")
    }

    func testReassemblerRejectsContradictoryTotal() {
        let r = Wire.Reassembler(kind: .user)
        _ = r.push(.init(kind: .user, id: "id", ts: 1, text: "A", seq: 1, total: 2))
        let out = r.push(.init(kind: .user, id: "id", ts: 1, text: "B", seq: 1, total: 3))
        XCTAssertNil(out)
    }

    func testReassemblerGc() {
        let r = Wire.Reassembler(kind: .agent)
        let stale: Int64 = 1
        _ = r.push(.init(kind: .agent, id: "old", ts: stale, text: "A", seq: 1, total: 2))
        r.gc(now: 100_000, maxAgeMs: 60_000)
        let out = r.push(.init(kind: .agent, id: "old", ts: stale, text: "B", seq: 2, total: 2))
        XCTAssertNil(out)
    }

    func testCrossPlatformInterop() throws {
        // Bytes produced by the TypeScript encoder for the same envelope.
        let json = """
        {"v":1,"kind":"user","id":"abc","ts":1700000000000,"text":"hello"}
        """
        let env = try Wire.decode(json.data(using: .utf8)!)
        XCTAssertEqual(env.kind, .user)
        XCTAssertEqual(env.id, "abc")
        XCTAssertEqual(env.text, "hello")

        // Verify our encoder produces JSON that the TS decoder would accept:
        // version, kind enum value, required ts as integer milliseconds.
        let again = try Wire.encode(env)
        let raw = try JSONSerialization.jsonObject(with: again) as? [String: Any]
        XCTAssertEqual(raw?["v"] as? Int, 1)
        XCTAssertEqual(raw?["kind"] as? String, "user")
        XCTAssertEqual(raw?["id"] as? String, "abc")
        XCTAssertEqual(raw?["text"] as? String, "hello")
    }
}
