// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wire format — mirrors plugin/src/wire.ts byte-for-byte.
//
// One JSON object per UDP datagram. Multi-chunk reassembly keyed by `id`
// with (`seq`, `total`).

import Foundation
import CryptoKit

public enum Wire {

    public static let version: Int = 1
    public static let maxEnvelopeBytes: Int = 1024

    public enum Kind: String, Codable {
        case user
        case agent
        case media
        case ack
        case error
    }

    public enum MediaKind: String, Codable, Equatable {
        case image
        case file
        case audio
    }

    public enum MediaFrom: String, Codable, Equatable {
        case user
        case agent
    }

    public struct Envelope: Codable, Equatable {
        public var v: Int
        public var kind: Kind
        public var id: String
        public var ts: Int64

        // Text fields (kind ∈ {user, agent} or media caption)
        public var text: String?
        public var seq: Int?
        public var total: Int?

        // Error fields
        public var code: String?

        // Media fields
        public var from: MediaFrom?
        public var media: MediaKind?
        public var data: String?       // base64 payload
        public var filename: String?
        public var mime: String?
        public var totalBytes: Int?
        public var caption: String?

        // HMAC-SHA256 over the canonicalized envelope (no hmac field), base64.
        public var hmac: String?

        public init(
            v: Int = Wire.version,
            kind: Kind,
            id: String,
            ts: Int64,
            text: String? = nil,
            seq: Int? = nil,
            total: Int? = nil,
            code: String? = nil,
            from: MediaFrom? = nil,
            media: MediaKind? = nil,
            data: String? = nil,
            filename: String? = nil,
            mime: String? = nil,
            totalBytes: Int? = nil,
            caption: String? = nil,
            hmac: String? = nil
        ) {
            self.v = v
            self.kind = kind
            self.id = id
            self.ts = ts
            self.text = text
            self.seq = seq
            self.total = total
            self.code = code
            self.from = from
            self.media = media
            self.data = data
            self.filename = filename
            self.mime = mime
            self.totalBytes = totalBytes
            self.caption = caption
            self.hmac = hmac
        }
    }

    // MARK: - HMAC (shared-secret authorization)

    /// Canonicalize an envelope for HMAC — strip the `hmac` field, sort keys,
    /// serialize as compact JSON. MUST match the plugin's canonicalForHmac.
    public static func canonicalForHmac(_ env: Envelope) throws -> Data {
        var dict: [String: Any] = [:]
        dict["v"] = env.v
        dict["kind"] = env.kind.rawValue
        dict["id"] = env.id
        dict["ts"] = NSNumber(value: env.ts)
        if let v = env.text { dict["text"] = v }
        if let v = env.seq { dict["seq"] = v }
        if let v = env.total { dict["total"] = v }
        if let v = env.code { dict["code"] = v }
        if let v = env.from { dict["from"] = v.rawValue }
        if let v = env.media { dict["media"] = v.rawValue }
        if let v = env.data { dict["data"] = v }
        if let v = env.filename { dict["filename"] = v }
        if let v = env.mime { dict["mime"] = v }
        if let v = env.totalBytes { dict["totalBytes"] = v }
        if let v = env.caption { dict["caption"] = v }
        // Sort keys; JSONSerialization with .sortedKeys gives us this.
        return try JSONSerialization.data(
            withJSONObject: dict,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
    }

    public static func sign(_ env: Envelope, secret: String) throws -> String {
        let canonical = try canonicalForHmac(env)
        let key = SymmetricKey(data: Data(secret.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: canonical, using: key)
        return Data(mac).base64EncodedString()
    }

    public static func verify(_ env: Envelope, secret: String) throws -> Bool {
        guard let provided = env.hmac, let providedBytes = Data(base64Encoded: provided) else {
            return false
        }
        let canonical = try canonicalForHmac(env)
        let key = SymmetricKey(data: Data(secret.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: canonical, using: key)
        return HMAC<SHA256>.isValidAuthenticationCode(
            mac,
            authenticating: canonical,
            using: key
        ) && providedBytes.elementsEqual(Data(mac))
    }

    public enum WireError: Error, CustomStringConvertible, Equatable {
        case tooLarge(bytes: Int)
        case notJSON(String)
        case schemaFailed(String)

        public var description: String {
            switch self {
            case .tooLarge(let n):       return "envelope \(n)B exceeds maxEnvelopeBytes (\(Wire.maxEnvelopeBytes))"
            case .notJSON(let m):        return "envelope not JSON: \(m)"
            case .schemaFailed(let m):   return "envelope failed schema check: \(m.prefix(200))"
            }
        }
    }

    public static func encode(_ env: Envelope) throws -> Data {
        let enc = JSONEncoder()
        // Match the JS encoder's compact / no-extra-keys output.
        enc.outputFormatting = []
        // Match TS field order: v, kind, id, ts, text, seq, total, code.
        // JSONEncoder ordering isn't guaranteed but stays stable enough for
        // small envelopes; the reassembler doesn't care about field order.
        let data = try enc.encode(env)
        if data.count > maxEnvelopeBytes {
            throw WireError.tooLarge(bytes: data.count)
        }
        return data
    }

    public static func decode(_ data: Data) throws -> Envelope {
        let dec = JSONDecoder()
        let env: Envelope
        do {
            env = try dec.decode(Envelope.self, from: data)
        } catch {
            throw WireError.notJSON(error.localizedDescription)
        }
        if env.v != version {
            throw WireError.schemaFailed("unsupported version \(env.v)")
        }
        if env.id.isEmpty {
            throw WireError.schemaFailed("missing id")
        }
        switch env.kind {
        case .user, .agent:
            if env.text == nil {
                throw WireError.schemaFailed("\(env.kind.rawValue) requires text")
            }
        case .media:
            if env.data == nil || env.seq == nil || env.total == nil
                || env.from == nil || env.media == nil {
                throw WireError.schemaFailed("media requires data + seq + total + from + media")
            }
        case .ack:
            break
        case .error:
            if env.code == nil || env.text == nil {
                throw WireError.schemaFailed("error requires code + text")
            }
        }
        return env
    }

    /// 24-char base36 id matching newId() in wire.ts.
    public static func newId() -> String {
        let t = String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36)
            .padding(toLength: 9, withPad: "0", startingAt: 0)
        var rand = UInt64.random(in: 0..<UInt64(pow(Double(36), 12)))
        var chars: [Character] = []
        for _ in 0..<12 {
            let digit = Int(rand % 36)
            rand /= 36
            chars.append(base36(digit))
        }
        return t + String(chars.reversed())
    }

    private static func base36(_ d: Int) -> Character {
        if d < 10 { return Character(String(d)) }
        return Character(UnicodeScalar(97 + d - 10)!) // 'a'..'z'
    }

    /// Split a long text into N envelopes that each fit `maxEnvelopeBytes`.
    public static func chunk(
        text: String,
        kind: Kind,
        id: String = newId(),
        ts: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> [Envelope] {
        precondition(kind == .user || kind == .agent, "chunk only supports user/agent")
        let unsplit = Envelope(kind: kind, id: id, ts: ts, text: text)
        if let single = try? encode(unsplit), single.count <= maxEnvelopeBytes {
            return [unsplit]
        }

        // Estimate per-envelope overhead (with seq/total fields).
        let header = Envelope(kind: kind, id: id, ts: ts, text: "", seq: 1, total: 99)
        let overhead = (try? encode(header).count) ?? 200
        let room = max(64, maxEnvelopeBytes - overhead - 8)

        var pieces: [String] = []
        var idx = text.startIndex
        while idx < text.endIndex {
            // Binary search a piece length (in characters) that fits in `room` UTF-8 bytes.
            var lo = 1
            var hi = text.distance(from: idx, to: text.endIndex)
            var best = 1
            while lo <= hi {
                let mid = (lo + hi) / 2
                let end = text.index(idx, offsetBy: mid)
                let piece = String(text[idx..<end])
                if piece.utf8.count <= room {
                    best = mid
                    lo = mid + 1
                } else {
                    hi = mid - 1
                }
            }
            let endIdx = text.index(idx, offsetBy: best)
            pieces.append(String(text[idx..<endIdx]))
            idx = endIdx
        }

        return pieces.enumerated().map { (i, piece) in
            Envelope(
                kind: kind,
                id: id,
                ts: ts,
                text: piece,
                seq: i + 1,
                total: pieces.count
            )
        }
    }

    /// In-memory reassembler. Drop reassembly state for `id`s older than `maxAgeMs`.
    public final class Reassembler {
        private struct State {
            var received: [Int: Envelope]
            var total: Int
            var firstTs: Int64
        }
        private var parts: [String: State] = [:]
        private let kind: Kind

        public init(kind: Kind) {
            precondition(kind == .user || kind == .agent)
            self.kind = kind
        }

        public func gc(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000), maxAgeMs: Int64 = 60_000) {
            for (id, state) in parts where now - state.firstTs > maxAgeMs {
                parts.removeValue(forKey: id)
            }
        }

        /// Feed one envelope. Returns the fully reassembled envelope if complete, else nil.
        public func push(_ env: Envelope) -> Envelope? {
            guard env.kind == kind else { return nil }
            guard let total = env.total, total > 1 else {
                // Single-chunk or unchunked → return as-is.
                if env.total == 1 || env.total == nil {
                    return env
                }
                return nil
            }
            guard let seq = env.seq, seq >= 1, seq <= total else { return nil }
            var st = parts[env.id] ?? State(received: [:], total: total, firstTs: env.ts)
            if st.total != total { return nil }
            st.received[seq] = env
            parts[env.id] = st
            if st.received.count < total { return nil }
            var combined = ""
            for i in 1...total {
                guard let part = st.received[i]?.text else { return nil }
                combined += part
            }
            parts.removeValue(forKey: env.id)
            return Envelope(kind: env.kind, id: env.id, ts: env.ts, text: combined)
        }
    }

    // MARK: - Media

    public struct MediaChunkInput {
        public let from: MediaFrom
        public let media: MediaKind
        public let bytes: Data
        public var filename: String?
        public var mime: String?
        public var caption: String?
        public var id: String?
        public var ts: Int64?

        public init(
            from: MediaFrom,
            media: MediaKind,
            bytes: Data,
            filename: String? = nil,
            mime: String? = nil,
            caption: String? = nil,
            id: String? = nil,
            ts: Int64? = nil
        ) {
            self.from = from
            self.media = media
            self.bytes = bytes
            self.filename = filename
            self.mime = mime
            self.caption = caption
            self.id = id
            self.ts = ts
        }
    }

    public struct ReassembledMedia: Equatable {
        public let id: String
        public let ts: Int64
        public let from: MediaFrom
        public let media: MediaKind
        public let bytes: Data
        public let filename: String?
        public let mime: String?
        public let caption: String?
    }

    /// Split a binary payload into media envelopes that fit MAX_ENVELOPE_BYTES.
    public static func chunkMedia(_ input: MediaChunkInput) -> [Envelope] {
        let id = input.id ?? newId()
        let ts = input.ts ?? Int64(Date().timeIntervalSince1970 * 1000)
        let totalBytes = input.bytes.count

        // Overhead estimates with/without metadata.
        let firstSample = Envelope(
            kind: .media,
            id: id,
            ts: ts,
            seq: 1,
            total: 999,
            from: input.from,
            media: input.media,
            data: "",
            filename: input.filename,
            mime: input.mime,
            totalBytes: totalBytes,
            caption: input.caption
        )
        let restSample = Envelope(
            kind: .media,
            id: id,
            ts: ts,
            seq: 999,
            total: 999,
            from: input.from,
            media: input.media,
            data: ""
        )
        // The encoded `restSample` has an empty `data: ""`. Once we put real
        // base64 in, the total envelope size = overhead + base64Length(N) -
        // 0 (we already counted the empty string + quotes). Conservative
        // safety margin to account for differences in JSON key ordering /
        // escaping across encoders.
        let firstOverhead = (try? encode(firstSample).count) ?? 300
        let restOverhead = (try? encode(restSample).count) ?? 200
        let firstDataRoom = max(64, maxEnvelopeBytes - firstOverhead - 32)
        let restDataRoom = max(64, maxEnvelopeBytes - restOverhead - 32)
        let firstSrcBytes = max(3, (firstDataRoom / 4) * 3)
        let restSrcBytes = max(3, (restDataRoom / 4) * 3)

        var chunks: [Data] = []
        var offset = 0
        let first = input.bytes.subdata(in: 0..<min(firstSrcBytes, totalBytes))
        chunks.append(first)
        offset += first.count
        while offset < totalBytes {
            let end = min(offset + restSrcBytes, totalBytes)
            chunks.append(input.bytes.subdata(in: offset..<end))
            offset = end
        }

        let total = chunks.count
        return chunks.enumerated().map { (idx, chunk) in
            var env = Envelope(
                kind: .media,
                id: id,
                ts: ts,
                seq: idx + 1,
                total: total,
                from: input.from,
                media: input.media,
                data: chunk.base64EncodedString()
            )
            if idx == 0 {
                env.filename = input.filename
                env.mime = input.mime
                env.totalBytes = totalBytes
                env.caption = input.caption
            }
            return env
        }
    }

    /// Reassembler for media envelopes — collects binary chunks into Data.
    public final class MediaReassembler {
        private struct Header {
            let from: MediaFrom
            let media: MediaKind
            let filename: String?
            let mime: String?
            let caption: String?
            let totalBytes: Int?
        }
        private struct State {
            var received: [Int: Envelope]
            var total: Int
            var firstTs: Int64
            var header: Header?
        }
        private var parts: [String: State] = [:]

        public init() {}

        public func gc(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000), maxAgeMs: Int64 = 60_000) {
            for (id, st) in parts where now - st.firstTs > maxAgeMs {
                parts.removeValue(forKey: id)
            }
        }

        public func push(_ env: Envelope) -> ReassembledMedia? {
            guard env.kind == .media,
                  let total = env.total,
                  let seq = env.seq,
                  let from = env.from,
                  let media = env.media,
                  let data = env.data,
                  seq >= 1, seq <= total
            else { return nil }

            var st = parts[env.id] ?? State(received: [:], total: total, firstTs: env.ts, header: nil)
            if st.total != total { return nil }
            st.received[seq] = env
            if seq == 1 {
                st.header = Header(
                    from: from,
                    media: media,
                    filename: env.filename,
                    mime: env.mime,
                    caption: env.caption,
                    totalBytes: env.totalBytes
                )
            }
            parts[env.id] = st
            _ = data // silence unused warning

            if st.received.count < total { return nil }
            guard let header = st.header else { return nil }

            var combined = Data()
            for i in 1...total {
                guard let part = st.received[i],
                      let chunkB64 = part.data,
                      let chunkBytes = Data(base64Encoded: chunkB64)
                else { return nil }
                combined.append(chunkBytes)
            }
            if let expected = header.totalBytes, combined.count != expected {
                parts.removeValue(forKey: env.id)
                return nil
            }
            parts.removeValue(forKey: env.id)
            return ReassembledMedia(
                id: env.id,
                ts: env.ts,
                from: header.from,
                media: header.media,
                bytes: combined,
                filename: header.filename,
                mime: header.mime,
                caption: header.caption
            )
        }
    }
}
