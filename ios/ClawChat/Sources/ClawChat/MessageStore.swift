// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-profile persistence for chat messages — survives app restart so the
// user doesn't lose history, and gives us the substrate for auto-retry of
// messages that were queued/failed before a disconnect.
//
// Stored at `<profileDir>/messages.json` (same per-profile dir that holds
// the Pilot identity). Attachment bytes go to `<profileDir>/attachments/`
// as separate files (referenced by relative path in the JSON) so we don't
// bloat the manifest for chats with images. Format is versioned in case
// we evolve ChatMessage later; on a version mismatch we silently start
// fresh rather than crash.

import Foundation

public struct MessageStore {

    public let messagesFile: URL
    public let attachmentsDir: URL

    public init(profileDir: URL) {
        self.messagesFile = profileDir.appendingPathComponent("messages.json")
        self.attachmentsDir = profileDir.appendingPathComponent("attachments")
        try? FileManager.default.createDirectory(at: profileDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: attachmentsDir, withIntermediateDirectories: true)
    }

    /// Load the saved messages. Returns an empty array if no file exists,
    /// the file is corrupt, or the schema is unknown. Never throws — chat
    /// history is best-effort.
    public func load() -> [ChatMessage] {
        guard let data = try? Data(contentsOf: messagesFile) else { return [] }
        guard let stored = try? JSONDecoder().decode(StoredFormat.self, from: data) else {
            // Corrupt / unknown version. We'd rather rehydrate empty than crash.
            return []
        }
        if stored.version != 1 { return [] }
        return stored.messages.compactMap { runtimeMessage(from: $0) }
    }

    /// Persist the given messages array. Atomic via .tmp + rename so a crash
    /// mid-write doesn't corrupt the file. Attachment bytes go to sidecar
    /// files under `attachments/`; the JSON manifest carries only their paths.
    public func save(_ messages: [ChatMessage]) {
        // Write attachments first so the manifest can never reference missing
        // files. If a write fails we'll drop that attachment from the manifest
        // (rather than refusing to persist the whole message).
        for m in messages {
            for (idx, a) in m.attachments.enumerated() {
                let rel = StoredMessage.attachmentRelPath(messageId: m.id, index: idx, filename: a.filename, mime: a.mime)
                let path = attachmentsDir.appendingPathComponent(rel)
                // Don't rewrite if already present + same size; saves disk churn on every UI tick.
                if let existing = (try? FileManager.default.attributesOfItem(atPath: path.path))?[.size] as? Int,
                   existing == a.bytes.count {
                    continue
                }
                try? a.bytes.write(to: path, options: [.atomic])
            }
        }
        let stored = StoredFormat(version: 1, messages: messages.map { StoredMessage(from: $0) })
        guard let data = try? JSONEncoder().encode(stored) else { return }
        let tmp = messagesFile.appendingPathExtension("tmp")
        do {
            try data.write(to: tmp, options: [.atomic])
            _ = try FileManager.default.replaceItemAt(messagesFile, withItemAt: tmp)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
        }
    }

    // MARK: - On-disk shape

    private struct StoredFormat: Codable {
        var version: Int
        var messages: [StoredMessage]
    }

    /// Mirrors ChatMessage but in a Codable-friendly shape. Attachment bytes
    /// are sidecar files under `<profileDir>/attachments/` referenced by
    /// relative path; the JSON manifest stays small even with image-heavy
    /// chats.
    fileprivate struct StoredMessage: Codable {
        var id: String
        var sender: String  // "me" | "claw"
        var text: String
        var tsMs: Int64
        var deliveryRaw: String
        var deliveryDetail: String?
        var attachments: [StoredAttachment]?

        init(from m: ChatMessage) {
            self.id = m.id
            self.sender = m.sender == .me ? "me" : "claw"
            self.text = m.text
            self.tsMs = Int64(m.ts.timeIntervalSince1970 * 1000)
            switch m.delivery {
            case .sending:        deliveryRaw = "sending"; deliveryDetail = nil
            case .sent:           deliveryRaw = "sent";    deliveryDetail = nil
            case .delivered:      deliveryRaw = "delivered"; deliveryDetail = nil
            case .failed(let d):  deliveryRaw = "failed";  deliveryDetail = d
            }
            self.attachments = m.attachments.isEmpty
                ? nil
                : m.attachments.enumerated().map { idx, a in
                    StoredAttachment(
                        kind: a.kind.rawValue,
                        filename: a.filename,
                        mime: a.mime,
                        relPath: StoredMessage.attachmentRelPath(messageId: m.id, index: idx, filename: a.filename, mime: a.mime),
                        sizeBytes: a.bytes.count
                    )
                }
        }

        /// Build a path under `attachments/` that's unique per (msgId, idx)
        /// and carries a hint at the extension. Sanitized to keep us out of
        /// directory-traversal territory.
        static func attachmentRelPath(messageId: String, index: Int, filename: String?, mime: String?) -> String {
            let safeId = messageId.replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "..", with: "_")
            let ext: String = {
                if let filename, let dot = filename.lastIndex(of: ".") {
                    let candidate = String(filename[dot...])
                    if candidate.count <= 8 && candidate.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." }) {
                        return candidate
                    }
                }
                if let mime {
                    switch mime {
                    case "image/png":  return ".png"
                    case "image/jpeg": return ".jpg"
                    case "image/gif":  return ".gif"
                    case "image/webp": return ".webp"
                    case "audio/mpeg": return ".mp3"
                    case "audio/mp4":  return ".m4a"
                    case "audio/wav":  return ".wav"
                    case "application/pdf":  return ".pdf"
                    default: break
                    }
                }
                return ".bin"
            }()
            return "\(safeId)-\(index)\(ext)"
        }
    }

    fileprivate struct StoredAttachment: Codable {
        var kind: String   // "image" | "file" | "audio"
        var filename: String?
        var mime: String?
        var relPath: String
        var sizeBytes: Int
    }
}

private extension MessageStore {
    /// Convert StoredMessage + sidecar attachment files back to a ChatMessage.
    /// Missing/unreadable attachment files are silently dropped rather than
    /// crashing — partial chat history beats no chat history.
    func runtimeMessage(from s: StoredMessage) -> ChatMessage? {
        let sender: ChatMessageSender = s.sender == "me" ? .me : .claw
        let delivery: ChatDeliveryState
        switch s.deliveryRaw {
        case "sending":   delivery = .sending
        case "sent":      delivery = .sent
        case "delivered": delivery = .delivered
        case "failed":    delivery = .failed(s.deliveryDetail ?? "unknown")
        default: return nil
        }
        let attachments: [ChatAttachment] = (s.attachments ?? []).compactMap { a in
            let kind: ChatAttachment.Kind
            switch a.kind {
            case "image": kind = .image
            case "audio": kind = .audio
            case "file":  kind = .file
            default: return nil
            }
            let path = attachmentsDir.appendingPathComponent(a.relPath)
            guard let bytes = try? Data(contentsOf: path) else { return nil }
            return ChatAttachment(kind: kind, bytes: bytes, filename: a.filename, mime: a.mime)
        }
        return ChatMessage(
            id: s.id,
            sender: sender,
            text: s.text,
            ts: Date(timeIntervalSince1970: TimeInterval(s.tsMs) / 1000),
            attachments: attachments,
            delivery: delivery
        )
    }
}
