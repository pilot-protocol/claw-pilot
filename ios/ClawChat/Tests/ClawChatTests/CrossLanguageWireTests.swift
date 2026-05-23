// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-language wire compat tests. These fixtures are the EXACT bytes the
// TypeScript encoder produces for the same envelopes — if Swift can decode
// them, an iOS app can read messages from the OpenClaw pilot plugin (which
// uses the TS encoder on the wire).
//
// To regenerate fixtures:
//   cd plugin && node -e "import('./dist/wire.js').then(({encodeEnvelope, WIRE_VERSION}) => {...})"
// (see plugin/scripts/dump-fixtures.js once it lands).

import XCTest
@testable import ClawChat

final class CrossLanguageWireTests: XCTestCase {

    private static let tsBytes: [String: [UInt8]] = [
        "user:abc": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,117,115,101,114,34,
            44,34,105,100,34,58,34,97,98,99,34,44,34,116,115,34,58,49,55,48,48,48,
            48,48,48,48,48,48,48,48,44,34,116,101,120,116,34,58,34,104,101,108,108,
            111,34,125,
        ],
        "user:utf8": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,117,115,101,114,34,
            44,34,105,100,34,58,34,117,116,102,56,34,44,34,116,115,34,58,49,55,48,
            48,48,48,48,48,48,48,48,48,49,44,34,116,101,120,116,34,58,34,99,97,102,
            195,169,32,240,159,166,158,34,125,
        ],
        "agent:multi:1": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,97,103,101,110,116,
            34,44,34,105,100,34,58,34,109,117,108,116,105,34,44,34,116,115,34,58,
            49,55,48,48,48,48,48,48,48,48,48,48,50,44,34,116,101,120,116,34,58,
            34,65,34,44,34,115,101,113,34,58,49,44,34,116,111,116,97,108,34,58,51,
            125,
        ],
        "agent:multi:2": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,97,103,101,110,116,
            34,44,34,105,100,34,58,34,109,117,108,116,105,34,44,34,116,115,34,58,
            49,55,48,48,48,48,48,48,48,48,48,48,50,44,34,116,101,120,116,34,58,
            34,66,34,44,34,115,101,113,34,58,50,44,34,116,111,116,97,108,34,58,51,
            125,
        ],
        "agent:multi:3": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,97,103,101,110,116,
            34,44,34,105,100,34,58,34,109,117,108,116,105,34,44,34,116,115,34,58,
            49,55,48,48,48,48,48,48,48,48,48,48,50,44,34,116,101,120,116,34,58,
            34,67,34,44,34,115,101,113,34,58,51,44,34,116,111,116,97,108,34,58,51,
            125,
        ],
        "ack:a-1": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,97,99,107,34,44,34,
            105,100,34,58,34,97,45,49,34,44,34,116,115,34,58,49,55,48,48,48,48,48,
            48,48,48,48,48,51,125,
        ],
        "error:e-1": [
            123,34,118,34,58,49,44,34,107,105,110,100,34,58,34,101,114,114,111,114,
            34,44,34,105,100,34,58,34,101,45,49,34,44,34,116,115,34,58,49,55,48,
            48,48,48,48,48,48,48,48,48,52,44,34,99,111,100,101,34,58,34,66,65,68,
            34,44,34,116,101,120,116,34,58,34,109,97,108,102,111,114,109,101,100,
            34,125,
        ],
    ]

    private func data(_ name: String) -> Data {
        guard let b = Self.tsBytes[name] else {
            XCTFail("missing fixture \(name)")
            return Data()
        }
        return Data(b)
    }

    func testDecodeUserBasic() throws {
        let env = try Wire.decode(data("user:abc"))
        XCTAssertEqual(env.kind, .user)
        XCTAssertEqual(env.id, "abc")
        XCTAssertEqual(env.ts, 1_700_000_000_000)
        XCTAssertEqual(env.text, "hello")
        XCTAssertNil(env.seq)
        XCTAssertNil(env.total)
    }

    func testDecodeUserUtf8() throws {
        let env = try Wire.decode(data("user:utf8"))
        XCTAssertEqual(env.text, "café 🦞")
    }

    func testDecodeAgentMultiChunkReassembles() throws {
        let r = Wire.Reassembler(kind: .agent)
        XCTAssertNil(r.push(try Wire.decode(data("agent:multi:1"))))
        XCTAssertNil(r.push(try Wire.decode(data("agent:multi:2"))))
        let out = r.push(try Wire.decode(data("agent:multi:3")))
        XCTAssertEqual(out?.text, "ABC")
        XCTAssertEqual(out?.id, "multi")
    }

    func testDecodeAck() throws {
        let env = try Wire.decode(data("ack:a-1"))
        XCTAssertEqual(env.kind, .ack)
        XCTAssertEqual(env.id, "a-1")
        XCTAssertNil(env.text)
    }

    func testDecodeError() throws {
        let env = try Wire.decode(data("error:e-1"))
        XCTAssertEqual(env.kind, .error)
        XCTAssertEqual(env.code, "BAD")
        XCTAssertEqual(env.text, "malformed")
    }

    func testEncodedByteSizeMatchesTsForSameEnvelope() throws {
        // Same envelope encoded by Swift should produce semantically equivalent
        // JSON (key order is not guaranteed, but byte size should be within a
        // few bytes). We assert via re-decode rather than byte equality.
        let env = Wire.Envelope(kind: .user, id: "abc", ts: 1_700_000_000_000, text: "hello")
        let swiftBytes = try Wire.encode(env)
        let tsBytes = data("user:abc")
        // Tolerate slight whitespace / key-order differences but require the
        // round-trip object equality:
        let swiftRoundtrip = try Wire.decode(swiftBytes)
        let tsRoundtrip = try Wire.decode(tsBytes)
        XCTAssertEqual(swiftRoundtrip, tsRoundtrip)
    }
}
