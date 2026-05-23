// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation view-model. Holds the in-memory message log, drives
// PilotConnection, and exposes an @MainActor-isolated state for SwiftUI.

import Foundation

#if canImport(SwiftUI)
import SwiftUI
#endif

public enum ChatMessageSender: Equatable, Sendable {
    case me
    case claw
}

public struct ChatAttachment: Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable {
        case image
        case file
        case audio
    }
    public let kind: Kind
    public let bytes: Data
    public let filename: String?
    public let mime: String?

    public init(kind: Kind, bytes: Data, filename: String? = nil, mime: String? = nil) {
        self.kind = kind
        self.bytes = bytes
        self.filename = filename
        self.mime = mime
    }
}

public enum ChatDeliveryState: Equatable, Sendable {
    case sending
    case sent
    case delivered
    case failed(String)
}

public struct ChatMessage: Identifiable, Equatable, Sendable {
    public let id: String
    public let sender: ChatMessageSender
    public let text: String
    public let ts: Date
    public let attachments: [ChatAttachment]
    public var delivery: ChatDeliveryState

    public init(
        id: String = UUID().uuidString,
        sender: ChatMessageSender,
        text: String,
        ts: Date = Date(),
        attachments: [ChatAttachment] = [],
        delivery: ChatDeliveryState = .sent
    ) {
        self.id = id
        self.sender = sender
        self.text = text
        self.ts = ts
        self.attachments = attachments
        self.delivery = delivery
    }
}

@MainActor
public final class Conversation: ObservableObject {

    public enum ConnectionState: Equatable {
        case idle
        case connecting
        case ready(selfAddress: String)
        case error(String)
    }

    @Published public private(set) var messages: [ChatMessage] = []
    @Published public private(set) var state: ConnectionState = .idle
    @Published public var draft: String = ""

    public private(set) var connection: PilotConnection?
    private var listenerTask: Task<Void, Never>?

    /// Optional callback for arriving (claw → me) messages. The host view
    /// supplies this to fire local notifications when the app is backgrounded.
    /// Kept here as a callback rather than coupling Conversation to a
    /// specific notifier so it stays platform-portable for testing.
    public var onIncoming: ((IncomingMessage) -> Void)?

    /// Optional store for chat history + the iOS-side outbox. When set,
    /// messages are loaded on connect and persisted on every change; any
    /// `.sending` or `.failed` outbound messages get re-tried as soon as the
    /// PilotConnection becomes ready. The host sets this with the profile's
    /// data dir so each profile has its own history file.
    public var messageStore: MessageStore?

    public init() {}

    /// Rehydrate from the message store. Call once before connect() to
    /// populate the chat with prior history. Idempotent — safe to call again.
    public func loadFromStoreIfAvailable() {
        guard let store = messageStore, messages.isEmpty else { return }
        messages = store.load()
    }

    private func saveToStore() {
        messageStore?.save(messages)
    }

    public func connect(config: PilotConnection.Config) {
        guard state == .idle else { return }
        state = .connecting
        loadFromStoreIfAvailable()

        let conn = PilotConnection(config: config)
        self.connection = conn
        let stream = conn.messages
        let ackStream = conn.acks
        let errorStream = conn.errors

        listenerTask = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                group.addTask { [weak self] in
                    for await id in ackStream {
                        await MainActor.run { [weak self] in
                            self?.updateDelivery(id: id, to: .delivered)
                        }
                    }
                }
                group.addTask { [weak self] in
                    for await err in errorStream {
                        await MainActor.run { [weak self] in
                            self?.updateDelivery(
                                id: err.messageId,
                                to: .failed("\(err.code): \(err.text)")
                            )
                        }
                    }
                }
                group.addTask { [weak self] in
                    for await msg in stream {
                        await MainActor.run { [weak self] in
                            self?.appendIncoming(msg)
                        }
                    }
                }
            }
        }

        Task { [weak self] in
            do {
                try await conn.start()
                guard let self else { return }
                self.state = .ready(selfAddress: conn.selfAddress ?? "?")
                // Drain anything that was queued while we were disconnected.
                self.drainOutbox()
            } catch {
                self?.state = .error(String(describing: error))
            }
        }
    }

    public func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        let messageId = Wire.newId()
        // Append to history immediately so the user sees feedback; persist so
        // it survives an app restart while still in .sending state.
        messages.append(ChatMessage(id: messageId, sender: .me, text: text, delivery: .sending))
        saveToStore()
        // If we're not connected, leave it as .sending — drainOutbox() will
        // pick it up the moment the connection becomes ready.
        guard let conn = connection, conn.isReady else { return }
        Task { [weak self] in
            do {
                _ = try await conn.send(text: text, messageId: messageId)
                self?.updateDelivery(id: messageId, to: .sent)
            } catch {
                self?.updateDelivery(id: messageId, to: .failed(String(describing: error)))
            }
        }
    }

    /// Resend any from-me messages that are stuck in `.sending` or `.failed`.
    /// Triggered automatically when the PilotConnection becomes ready; safe
    /// to call manually (e.g. from a "Retry all" UI control).
    public func drainOutbox() {
        guard let conn = connection, conn.isReady else { return }
        // Snapshot the queue so we don't fight UI updates mid-iteration.
        let pending = messages.filter { m in
            guard m.sender == .me else { return false }
            switch m.delivery {
            case .sending, .failed: return true
            case .sent, .delivered: return false
            }
        }
        for m in pending {
            // Reset to .sending so the UI shows progress; bypass updateDelivery's
            // never-downgrade guard (which would block .failed → .sending).
            if let idx = messages.firstIndex(where: { $0.id == m.id }) {
                var msg = messages[idx]
                msg.delivery = .sending
                messages[idx] = msg
                saveToStore()
            }
            Task { [weak self] in
                do {
                    _ = try await conn.send(text: m.text, messageId: m.id)
                    self?.updateDelivery(id: m.id, to: .sent)
                } catch {
                    self?.updateDelivery(id: m.id, to: .failed(String(describing: error)))
                }
            }
        }
    }

    private func updateDelivery(id: String, to state: ChatDeliveryState) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        var msg = messages[idx]
        // `failed` is a terminal state from the peer (error envelope) and always
        // wins over any progress state. Otherwise, never downgrade — a delivered
        // bubble must not flip back to `sent` if a duplicate sent-ack arrives.
        let rank: (ChatDeliveryState) -> Int = { s in
            switch s {
            case .sending:   return 1
            case .sent:      return 2
            case .delivered: return 3
            case .failed:    return 4
            }
        }
        if rank(state) >= rank(msg.delivery) {
            msg.delivery = state
            messages[idx] = msg
            saveToStore()
        }
    }

    private func appendIncoming(_ msg: IncomingMessage) {
        let attachments = msg.attachments.map { att -> ChatAttachment in
            let kind: ChatAttachment.Kind
            switch att.kind {
            case .image: kind = .image
            case .audio: kind = .audio
            case .file: kind = .file
            }
            return ChatAttachment(kind: kind, bytes: att.bytes, filename: att.filename, mime: att.mime)
        }
        let chat = ChatMessage(
            id: msg.id,
            sender: .claw,
            text: msg.text,
            ts: Date(timeIntervalSince1970: TimeInterval(msg.ts) / 1000),
            attachments: attachments,
            delivery: .delivered
        )
        messages.append(chat)
        saveToStore()
        onIncoming?(msg)
    }

    /// Send an attachment (image / file / audio) with optional caption.
    public func sendAttachment(
        kind: ChatAttachment.Kind,
        bytes: Data,
        filename: String? = nil,
        mime: String? = nil
    ) {
        guard let conn = connection, conn.isReady else { return }
        let caption = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        let messageId = Wire.newId()
        let chat = ChatMessage(
            id: messageId,
            sender: .me,
            text: caption,
            attachments: [ChatAttachment(kind: kind, bytes: bytes, filename: filename, mime: mime)],
            delivery: .sending
        )
        messages.append(chat)
        let wireKind: Wire.MediaKind
        switch kind {
        case .image: wireKind = .image
        case .audio: wireKind = .audio
        case .file:  wireKind = .file
        }
        Task { [weak self] in
            do {
                _ = try await conn.send(
                    media: wireKind,
                    bytes: bytes,
                    filename: filename,
                    mime: mime,
                    caption: caption.isEmpty ? nil : caption,
                    messageId: messageId
                )
                self?.updateDelivery(id: messageId, to: .sent)
            } catch {
                self?.updateDelivery(id: messageId, to: .failed(String(describing: error)))
            }
        }
    }

    public func disconnect() {
        listenerTask?.cancel()
        listenerTask = nil
        connection?.stop()
        connection = nil
        state = .idle
    }

    /// Send a one-shot diagnostic message — the claw plugin emits a
    /// "first delivery succeeded" log on receipt, and an ACK envelope back.
    /// The chat bubble's delivery state will move through sending → sent
    /// (envelope dispatched) → delivered (ack received).
    public func testConnection() {
        guard let conn = connection, conn.isReady else { return }
        let id = Wire.newId()
        messages.append(ChatMessage(
            id: id,
            sender: .me,
            text: "🔌 connection test",
            delivery: .sending
        ))
        Task { [weak self] in
            do {
                _ = try await conn.send(text: "claw-chat-ping", messageId: id)
                self?.updateDelivery(id: id, to: .sent)
            } catch {
                self?.updateDelivery(id: id, to: .failed(String(describing: error)))
            }
        }
    }

    /// Re-run the trust handshake against the configured claw. If we're not
    /// connected yet, behaves like a full connect; if we are, re-handshakes
    /// without tearing down the Pilot daemon.
    public func refresh() {
        guard let conn = connection else {
            // No active connection — caller should connect() first.
            return
        }
        let wasReady = conn.isReady
        if !wasReady {
            state = .connecting
        }
        Task { [weak self] in
            do {
                try await conn.retryHandshake()
                self?.state = .ready(selfAddress: conn.selfAddress ?? "?")
            } catch {
                self?.state = .error(String(describing: error))
            }
        }
    }
}
