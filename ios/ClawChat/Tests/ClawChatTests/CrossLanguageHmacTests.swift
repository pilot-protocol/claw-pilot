// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-language HMAC compat. These fixtures are the EXACT HMACs the
// TypeScript signEnvelope produces for the same envelope+secret. If Swift
// Wire.sign emits the same base64, an iOS app's HMAC-signed envelopes are
// guaranteed to verify on the plugin side — which is the whole point of
// HMAC bypass mode (the phone keeps a stable shared secret instead of a
// stable pilot identity).
//
// To regenerate, in plugin/ on dist-built JS:
//   node -e "import('./dist/wire.js').then(async ({signEnvelope, WIRE_VERSION}) => {
//     const SECRET = 'two-daemon-test-secret-at-least-16-chars';
//     for (const [n, env] of Object.entries({
//       'user:plain': { v: WIRE_VERSION, kind: 'user', id: 'cross-1', ts: 1700000000000, text: 'hello' },
//       'user:chunk': { v: WIRE_VERSION, kind: 'user', id: 'cross-2', ts: 1700000000001, text: 'A', seq: 1, total: 3 },
//       'media:hdr':  { v: WIRE_VERSION, kind: 'media', id: 'cross-3', ts: 1700000000002, from: 'user', media: 'image', data: 'AAEC', filename: 'a.png', mime: 'image/png', totalBytes: 9, caption: 'cap', seq: 1, total: 2 },
//     })) console.log(n, await signEnvelope(env, SECRET));
//   })"

import XCTest
@testable import ClawChat

final class CrossLanguageHmacTests: XCTestCase {

    private static let secret = "two-daemon-test-secret-at-least-16-chars"

    func testUserPlainMatchesTsHmac() throws {
        let env = Wire.Envelope(
            kind: .user,
            id: "cross-1",
            ts: 1_700_000_000_000,
            text: "hello"
        )
        let mac = try Wire.sign(env, secret: Self.secret)
        XCTAssertEqual(mac, "KkOIoDCS1R2vpK+8DTRIkdAV3MmASCqYckV/lS4iVqU=")
    }

    func testUserChunkMatchesTsHmac() throws {
        let env = Wire.Envelope(
            kind: .user,
            id: "cross-2",
            ts: 1_700_000_000_001,
            text: "A",
            seq: 1,
            total: 3
        )
        let mac = try Wire.sign(env, secret: Self.secret)
        XCTAssertEqual(mac, "DBcAFJtMk/iGMWDIlKC570PF4blj2I7OGwxBMkAWvF0=")
    }

    func testMediaHeaderChunkMatchesTsHmac() throws {
        let env = Wire.Envelope(
            kind: .media,
            id: "cross-3",
            ts: 1_700_000_000_002,
            seq: 1,
            total: 2,
            from: .user,
            media: .image,
            data: "AAEC",
            filename: "a.png",
            mime: "image/png",
            totalBytes: 9,
            caption: "cap"
        )
        let mac = try Wire.sign(env, secret: Self.secret)
        XCTAssertEqual(mac, "2JcwMcdEKbkLNDb3a1CcuLP0fpYn+xOZcRyDb6L701w=")
    }

    /// Sign once, sign again — must be deterministic across runs (HMAC is a
    /// function, but this also guards against accidental nondeterminism
    /// being introduced into canonicalForHmac later).
    func testSignIsDeterministic() throws {
        let env = Wire.Envelope(kind: .user, id: "det", ts: 1_700_000_000_000, text: "x")
        let a = try Wire.sign(env, secret: Self.secret)
        let b = try Wire.sign(env, secret: Self.secret)
        XCTAssertEqual(a, b)
    }
}
