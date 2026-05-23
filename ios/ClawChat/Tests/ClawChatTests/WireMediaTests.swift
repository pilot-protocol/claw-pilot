// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

final class WireMediaTests: XCTestCase {

    private func randomBytes(_ n: Int, seed: UInt32 = 1) -> Data {
        var state = seed
        var bytes = [UInt8](repeating: 0, count: n)
        for i in 0..<n {
            state ^= state << 13
            state ^= state >> 17
            state ^= state << 5
            bytes[i] = UInt8(state & 0xff)
        }
        return Data(bytes)
    }

    func testChunkMediaSingleEnvelope() throws {
        let parts = Wire.chunkMedia(.init(
            from: .user,
            media: .image,
            bytes: Data([1, 2, 3, 4]),
            filename: "tiny.bin",
            mime: "application/octet-stream"
        ))
        XCTAssertEqual(parts.count, 1)
        XCTAssertEqual(parts[0].seq, 1)
        XCTAssertEqual(parts[0].total, 1)
        XCTAssertEqual(parts[0].filename, "tiny.bin")
        XCTAssertEqual(parts[0].totalBytes, 4)
    }

    func testChunkMediaEachFitsBudget() throws {
        let src = randomBytes(12_000)
        let parts = Wire.chunkMedia(.init(
            from: .user,
            media: .image,
            bytes: src,
            filename: "cat.jpg",
            mime: "image/jpeg",
            caption: "look at this cat"
        ))
        XCTAssertGreaterThan(parts.count, 1)
        for p in parts {
            let enc = try Wire.encode(p)
            XCTAssertLessThanOrEqual(enc.count, Wire.maxEnvelopeBytes)
        }
    }

    func testMediaReassemblerByteForByte() throws {
        let src = randomBytes(20_000, seed: 42)
        let parts = Wire.chunkMedia(.init(
            from: .agent,
            media: .image,
            bytes: src,
            filename: "shot.png",
            mime: "image/png"
        ))
        let r = Wire.MediaReassembler()
        var out: Wire.ReassembledMedia? = nil
        for p in parts {
            if let result = r.push(p) {
                out = result
            }
        }
        XCTAssertNotNil(out)
        XCTAssertEqual(out!.bytes, src)
        XCTAssertEqual(out!.filename, "shot.png")
        XCTAssertEqual(out!.media, .image)
        XCTAssertEqual(out!.from, .agent)
    }

    func testReassembleOutOfOrder() throws {
        let src = randomBytes(5_000, seed: 7)
        let parts = Wire.chunkMedia(.init(
            from: .user,
            media: .file,
            bytes: src,
            filename: "blob.bin"
        ))
        let r = Wire.MediaReassembler()
        var out: Wire.ReassembledMedia? = nil
        for p in parts.reversed() {
            if let result = r.push(p) { out = result }
        }
        XCTAssertNotNil(out)
        XCTAssertEqual(out!.bytes, src)
    }

    func testDecodeAcceptsValidMediaEnvelope() throws {
        let env = Wire.Envelope(
            kind: .media,
            id: "abc",
            ts: 1,
            seq: 1,
            total: 1,
            from: .user,
            media: .image,
            data: "aGVsbG8=",
            filename: "a.png",
            mime: "image/png",
            totalBytes: 5
        )
        let buf = try Wire.encode(env)
        let back = try Wire.decode(buf)
        XCTAssertEqual(back.kind, .media)
        XCTAssertEqual(back.data, "aGVsbG8=")
        XCTAssertEqual(back.from, .user)
        XCTAssertEqual(back.media, .image)
    }

    func testDecodeRejectsMediaMissingFields() {
        // Missing `from` and `media`
        let bad = "{\"v\":1,\"kind\":\"media\",\"id\":\"x\",\"ts\":1,\"data\":\"AA==\",\"seq\":1,\"total\":1}".data(using: .utf8)!
        XCTAssertThrowsError(try Wire.decode(bad)) { err in
            guard case .some(Wire.WireError.schemaFailed) = err as? Wire.WireError else {
                return XCTFail("wrong error: \(err)")
            }
        }
    }

    func testCrossLanguageImageFixture() throws {
        // Bytes produced by the TypeScript encoder for a 4-byte image PNG chunk.
        // Wire format: { v, kind:"media", from:"user", media:"image", id, ts, data, seq, total, filename, mime, totalBytes, caption }
        let fixture = """
        {"v":1,"kind":"media","from":"user","media":"image","id":"img1","ts":1700000000000,"data":"AQID","seq":1,"total":1,"filename":"a.png","mime":"image/png","totalBytes":3,"caption":"hi"}
        """
        let env = try Wire.decode(fixture.data(using: .utf8)!)
        XCTAssertEqual(env.kind, .media)
        XCTAssertEqual(env.from, .user)
        XCTAssertEqual(env.media, .image)
        XCTAssertEqual(env.filename, "a.png")
        XCTAssertEqual(env.caption, "hi")

        let r = Wire.MediaReassembler()
        let out = r.push(env)
        XCTAssertEqual(out?.bytes, Data([0x01, 0x02, 0x03]))
        XCTAssertEqual(out?.filename, "a.png")
    }
}
