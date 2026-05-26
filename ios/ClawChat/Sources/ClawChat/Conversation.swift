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
    /// Human-readable status line for the UI to surface. Updated whenever the
    /// connection state or watchdog activity meaningfully changes — render
    /// this somewhere visible so users can tell what's happening when a send
    /// silently stalls. Examples:
    ///   "ready"
    ///   "reconnecting — handshake retry"
    ///   "watchdog tripped — 2 message(s) unacked for >60s, reconnecting"
    ///   "reconnected after wedge (took 2.1s)"
    @Published public private(set) var statusMessage: String?
    /// Wall-clock time the most recent ack landed. Lets the UI render
    /// "last activity Xs ago" without scanning the whole message log.
    @Published public private(set) var lastAckAt: Date?

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
                            self?.lastAckAt = Date()
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
                self.statusMessage = "ready as \(conn.selfAddress ?? "?")"
                // Drain anything that was queued while we were disconnected.
                self.drainOutbox()
                // On iOS, auto-recover from the UDP-socket close that happens
                // when the app is suspended. No-op on macOS.
                self.observeAppForeground()
                // Background watchdog: catches mid-session wedges.
                self.startWatchdog()
            } catch {
                self?.state = .error(String(describing: error))
                self?.statusMessage = "connect failed: \(String(describing: error))"
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
        stopObservingAppForeground()
        stopWatchdog()
        listenerTask?.cancel()
        listenerTask = nil
        connection?.stop()
        connection = nil
        state = .idle
        statusMessage = "disconnected"
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

    /// Recover from a wedged daemon. Tries a lightweight retryHandshake first
    /// (cheap — preserves daemon state); if that throws, escalates to a full
    /// daemon teardown + restart via `reconnect()`. Use this for the iOS
    /// "app returned to foreground after backgrounding" case where the
    /// daemon's UDP socket was silently closed by the OS, and any time the
    /// user taps a Refresh / Reconnect button.
    public func refresh() {
        guard let conn = connection else {
            // No active connection — caller should connect() first.
            return
        }
        let wasReady = conn.isReady
        if !wasReady {
            state = .connecting
        }
        statusMessage = "refreshing — retrying handshake"
        let started = Date()
        Task { [weak self] in
            do {
                try await conn.retryHandshake()
                self?.state = .ready(selfAddress: conn.selfAddress ?? "?")
                self?.statusMessage = "refreshed (handshake) — \(elapsedString(started))"
                self?.drainOutbox()
            } catch {
                // Handshake failed — daemon's likely wedged. Tear down and
                // rebuild from scratch. This is what app-restart used to do.
                await MainActor.run { [weak self] in
                    self?.state = .connecting
                    self?.statusMessage = "handshake failed — rebuilding daemon"
                }
                do {
                    try await conn.reconnect()
                    self?.state = .ready(selfAddress: conn.selfAddress ?? "?")
                    self?.statusMessage = "reconnected after wedge — \(elapsedString(started))"
                    self?.drainOutbox()
                } catch {
                    self?.state = .error(String(describing: error))
                    self?.statusMessage = "reconnect failed: \(String(describing: error))"
                }
            }
        }
    }

    /// Start the wedge-recovery watchdog. Polls every
    /// `watchdogIntervalSeconds`; if any outbound message has been stuck in
    /// `.sending` / `.sent` for longer than `watchdogStuckThresholdSeconds`,
    /// auto-fires a `refresh()` (which escalates to `reconnect()` on
    /// handshake failure). Started automatically in `connect()`; you only
    /// need to call this manually if you stopped + want to resume.
    public func startWatchdog() {
        stopWatchdog()
        watchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                let interval = await MainActor.run { self?.watchdogIntervalSeconds ?? 30 }
                try? await Task.sleep(nanoseconds: interval * 1_000_000_000)
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.runWatchdogCheck()
                }
            }
        }
    }

    public func stopWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = nil
    }

    /// One-shot wedge check. Exposed for tests; production code lets the
    /// watchdog task call this on its interval.
    public func runWatchdogCheck() {
        guard let conn = connection, conn.isReady else { return }
        let now = Date()
        let threshold = watchdogStuckThresholdSeconds
        let stuck = messages.filter { msg in
            guard msg.sender == .me else { return false }
            switch msg.delivery {
            case .sending, .sent:
                return now.timeIntervalSince(msg.ts) > threshold
            case .delivered, .failed:
                return false
            }
        }
        if !stuck.isEmpty {
            statusMessage = "watchdog tripped — \(stuck.count) message(s) unacked for >\(Int(threshold))s, reconnecting"
            refresh()
        }
    }

    #if canImport(UIKit)
    private var foregroundObserver: NSObjectProtocol?
    #endif

    private var watchdogTask: Task<Void, Never>?
    /// How often the watchdog polls for stuck outbound messages. Public so
    /// the host can dial it down for an idle screen or tighten it for an
    /// active chat — defaults are tuned for a typical foreground session.
    public var watchdogIntervalSeconds: UInt64 = 30
    /// An outbound message stuck in `.sending`/`.sent` longer than this is
    /// taken as a wedge signal. Must be greater than the agent's typical
    /// reply time (the plugin acks after dispatch).
    public var watchdogStuckThresholdSeconds: TimeInterval = 60

    /// Subscribe to iOS app-foreground notifications so a return-to-foreground
    /// automatically refreshes the connection — recovers from the silent
    /// UDP-socket close iOS performs when the app is suspended. No-op on
    /// platforms without UIKit (macOS unit tests).
    ///
    /// Safe to call multiple times; only the first call installs the observer.
    /// Call from the host scene/app once after `connect()`.
    public func observeAppForeground() {
        #if canImport(UIKit)
        guard foregroundObserver == nil else { return }
        let nc = NotificationCenter.default
        // Use the legacy UIApplication notification name as a string so this
        // compiles without an explicit `import UIKit` (which the SwiftPM
        // library target may not have configured under all schemes).
        let name = Notification.Name("UIApplicationDidBecomeActiveNotification")
        foregroundObserver = nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        }
        #endif
    }

    /// Stop listening for app-foreground notifications. Pair with disconnect().
    public func stopObservingAppForeground() {
        #if canImport(UIKit)
        if let token = foregroundObserver {
            NotificationCenter.default.removeObserver(token)
            foregroundObserver = nil
        }
        #endif
    }
}

/// Format the elapsed time since `start` as a short human string for the
/// status line ("0.4s", "2.1s", "12.7s").
private func elapsedString(_ start: Date) -> String {
    let dt = Date().timeIntervalSince(start)
    return String(format: "%.1fs", dt)
}
