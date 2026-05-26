// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PilotConnection wraps the Pilot SwiftPM into an actor-friendly API tailored
// for a chat app:
//   1. boot the embedded Pilot daemon
//   2. handshake the claw's pilot address (the user's claw, not the phone)
//   3. wait for trust
//   4. provide async send() / message stream

import Foundation
import os
import Pilot

private let pcLog = Logger(subsystem: "io.vulturelabs.clawchat", category: "PilotConnection")

public struct ClawAddress: Equatable, Sendable {
    public let address: String   // e.g. "1:0000.0000.AAAA"
    public let nodeId: UInt32

    public init(address: String, nodeId: UInt32) {
        self.address = address
        self.nodeId = nodeId
    }
}

public enum ConnectionError: Error, CustomStringConvertible {
    case notStarted
    case handshakeFailed(String)
    case trustTimeout
    case sendFailed(String)
    case encodeFailed(String)

    public var description: String {
        switch self {
        case .notStarted:               return "pilot connection not started"
        case .handshakeFailed(let m):   return "handshake failed: \(m)"
        case .trustTimeout:             return "trust handshake timed out"
        case .sendFailed(let m):        return "send failed: \(m)"
        case .encodeFailed(let m):      return "encode failed: \(m)"
        }
    }
}

public struct IncomingAttachment: Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable {
        case image
        case file
        case audio
    }
    public let kind: Kind
    public let bytes: Data
    public let filename: String?
    public let mime: String?
}

public struct IncomingMessage: Equatable, Sendable {
    public let id: String
    public let text: String
    public let ts: Int64
    public let senderAddress: String
    public let attachments: [IncomingAttachment]

    public init(
        id: String,
        text: String,
        ts: Int64,
        senderAddress: String,
        attachments: [IncomingAttachment] = []
    ) {
        self.id = id
        self.text = text
        self.ts = ts
        self.senderAddress = senderAddress
        self.attachments = attachments
    }
}

/// Error envelope received from the claw — usually a delivery rejection for
/// a previously-sent message id (e.g. media exceeded the size cap).
public struct IncomingError: Equatable, Sendable {
    /// id of the message this error refers to.
    public let messageId: String
    /// Short machine-readable code from the claw.
    public let code: String
    /// Human-readable detail.
    public let text: String
}

/// Thin wrapper that boots Pilot, handshakes the claw, and provides a
/// streaming message API. Single-conversation MVP — one claw peer.
public final class PilotConnection {

    public struct Config {
        public var dataDir: URL
        public var socketBasename: String
        public var claw: ClawAddress
        public var clawAppPort: UInt16
        public var trustTimeoutMs: UInt32
        public var trustAutoApprove: Bool
        /// Optional HMAC shared secret. When non-empty, every outgoing envelope
        /// is signed; the claw plugin verifies and bypasses its allowlist on
        /// success. Used to avoid pinning the phone's pilot identity (which
        /// may change on each launch).
        public var sharedSecret: String
        /// How often the daemon emits NAT keepalives. The original SDK default
        /// is 30s — appropriate for direct NAT-traversed peers. We almost
        /// always tunnel via the rendezvous relay (visible as `relay=true`
        /// in daemon logs), so the keepalive only needs to be fast enough to
        /// keep the registry-side relay session warm. 120s halves radio
        /// wake-ups versus the default with no observable hit to delivery.
        public var keepaliveSeconds: Int

        public init(
            dataDir: URL,
            socketBasename: String = "p.sock",
            claw: ClawAddress,
            clawAppPort: UInt16 = 7777,
            trustTimeoutMs: UInt32 = 30_000,
            trustAutoApprove: Bool = true,
            sharedSecret: String = "",
            keepaliveSeconds: Int = 120
        ) {
            self.dataDir = dataDir
            self.socketBasename = socketBasename
            self.claw = claw
            self.clawAppPort = clawAppPort
            self.trustTimeoutMs = trustTimeoutMs
            self.trustAutoApprove = trustAutoApprove
            self.sharedSecret = sharedSecret
            self.keepaliveSeconds = keepaliveSeconds
        }

        /// We never opt into Network 9 / the public directory. The Pilot daemon
        /// joins Network 9 only when its identity email is a real address
        /// (via `pilotctl set-email`). We never call that, so the synthetic
        /// `<hash>@nodes.pilotprotocol.network` form is what gets registered,
        /// which is explicitly excluded from public directory listings.
        public var joinsPublicDirectory: Bool { false }
    }

    private let cfg: Config
    private var pilot: Pilot?
    private var recvTask: Task<Void, Never>?
    /// Bumped on every restart so each fresh daemon gets a unique IPC socket
    /// basename. Pilot.stop() tears down the global Go runtime asynchronously
    /// — if the old unix socket file is still held when start() retries with
    /// the original basename, the new daemon either races on bind() or
    /// silently inherits a wedged socket. A fresh basename dodges both.
    private var restartGeneration: Int = 0
    private let reassembler = Wire.Reassembler(kind: .agent)
    private let mediaReassembler = Wire.MediaReassembler()
    private var seenIds: Set<String> = []
    private let recvContinuation: AsyncStream<IncomingMessage>.Continuation
    private let ackContinuation: AsyncStream<String>.Continuation
    private let errorContinuation: AsyncStream<IncomingError>.Continuation
    public let messages: AsyncStream<IncomingMessage>
    /// Stream of delivery-ack message ids — fires each time the claw confirms
    /// it received one of our envelopes.
    public let acks: AsyncStream<String>
    /// Stream of error envelopes — usually rejections by the claw.
    public let errors: AsyncStream<IncomingError>
    public private(set) var selfAddress: String?
    public private(set) var selfNodeId: UInt32?
    public private(set) var isReady = false

    public init(config: Config) {
        self.cfg = config
        var msgContinuation: AsyncStream<IncomingMessage>.Continuation!
        self.messages = AsyncStream { msgContinuation = $0 }
        self.recvContinuation = msgContinuation
        var ackC: AsyncStream<String>.Continuation!
        self.acks = AsyncStream { ackC = $0 }
        self.ackContinuation = ackC
        var errC: AsyncStream<IncomingError>.Continuation!
        self.errors = AsyncStream { errC = $0 }
        self.errorContinuation = errC
    }

    deinit {
        recvTask?.cancel()
        try? pilot?.stop()
        recvContinuation.finish()
        ackContinuation.finish()
        errorContinuation.finish()
    }

    /// Boots Pilot, fires a trust handshake against the configured claw, and
    /// starts the recv loop. Returns once the peer is trusted.
    ///
    /// If `maxAttempts > 1`, retries the handshake when it times out (with
    /// exponential backoff capped at 30s). The Pilot daemon is started once;
    /// only the handshake/waitForTrust pair is retried.
    public func start(maxAttempts: Int = 4) async throws {
        // Cycle the socket basename each restart so we never collide with
        // a stale unix-socket file held by the previous (slow-to-die) Go
        // runtime. The Pilot identity lives in dataDir, not socketPath, so
        // the daemon's overlay address stays stable across restarts.
        let socketName = restartGeneration == 0
            ? cfg.socketBasename
            : "\(cfg.socketBasename).\(restartGeneration)"
        let p = try Pilot.start(.init(
            dataDir: cfg.dataDir,
            socketPath: socketName,
            trustAutoApprove: cfg.trustAutoApprove,
            keepaliveSeconds: cfg.keepaliveSeconds
        ))
        self.pilot = p
        self.selfAddress = p.start.address
        self.selfNodeId = p.start.nodeID

        var lastError: Error?
        for attempt in 1...max(1, maxAttempts) {
            do {
                try p.handshake(peerID: cfg.claw.nodeId, justification: "claw-chat")
            } catch {
                lastError = ConnectionError.handshakeFailed(String(describing: error))
                if attempt < maxAttempts {
                    try? await Task.sleep(nanoseconds: UInt64(backoffMs(attempt)) * 1_000_000)
                    continue
                }
                throw lastError!
            }
            let trusted: Bool
            do {
                trusted = try p.waitForTrust(peerID: cfg.claw.nodeId, timeoutMs: cfg.trustTimeoutMs)
            } catch {
                lastError = ConnectionError.handshakeFailed(String(describing: error))
                if attempt < maxAttempts {
                    try? await Task.sleep(nanoseconds: UInt64(backoffMs(attempt)) * 1_000_000)
                    continue
                }
                throw lastError!
            }
            if trusted {
                self.isReady = true
                startRecvLoop(pilot: p)
                return
            }
            // Soft-fail: timeout on this attempt, backoff and try again.
            if attempt < maxAttempts {
                try? await Task.sleep(nanoseconds: UInt64(backoffMs(attempt)) * 1_000_000)
            }
        }
        throw lastError ?? ConnectionError.trustTimeout
    }

    private func backoffMs(_ attempt: Int) -> Int {
        // 500ms, 1s, 2s, 4s, … capped at 30s.
        let exp = min(attempt - 1, 6)
        return min(30_000, 500 * (1 << exp))
    }

    /// Retry the trust handshake without tearing down the Pilot daemon.
    /// Useful when the user taps a "Refresh" button after a network blip.
    public func retryHandshake(maxAttempts: Int = 4) async throws {
        guard let p = pilot else { throw ConnectionError.notStarted }
        isReady = false
        var lastError: Error?
        for attempt in 1...max(1, maxAttempts) {
            do {
                try p.handshake(peerID: cfg.claw.nodeId, justification: "claw-chat-retry")
                let trusted = try p.waitForTrust(peerID: cfg.claw.nodeId, timeoutMs: cfg.trustTimeoutMs)
                if trusted {
                    self.isReady = true
                    return
                }
            } catch {
                lastError = ConnectionError.handshakeFailed(String(describing: error))
            }
            if attempt < maxAttempts {
                try? await Task.sleep(nanoseconds: UInt64(backoffMs(attempt)) * 1_000_000)
            }
        }
        throw lastError ?? ConnectionError.trustTimeout
    }

    private func startRecvLoop(pilot p: Pilot) {
        self.recvTask = Task.detached(priority: .utility) { [weak self] in
            while !Task.isCancelled {
                let dg: Pilot.Datagram
                do {
                    dg = try p.receive()
                } catch {
                    // Pilot.receive throws on stop(); break out cleanly.
                    return
                }
                self?.handleDatagram(dg)
            }
        }
    }

    private func handleDatagram(_ dg: Pilot.Datagram) {
        let env: Wire.Envelope
        do {
            env = try Wire.decode(dg.data)
        } catch {
            return // silently drop malformed packets
        }
        switch env.kind {
        case .agent:
            handleAgentText(env, srcAddr: dg.srcAddr)
        case .media:
            handleMedia(env, srcAddr: dg.srcAddr)
        case .ack:
            ackContinuation.yield(env.id)
        case .error:
            if let code = env.code, let text = env.text {
                errorContinuation.yield(
                    IncomingError(messageId: env.id, code: code, text: text)
                )
            }
        default:
            return
        }
    }

    private func handleAgentText(_ env: Wire.Envelope, srcAddr: String) {
        guard let reassembled = reassembler.push(env),
              let text = reassembled.text else { return }
        guard !seenIds.contains(reassembled.id) else { return }
        markSeen(reassembled.id)
        let msg = IncomingMessage(
            id: reassembled.id,
            text: text,
            ts: reassembled.ts,
            senderAddress: srcAddr
        )
        recvContinuation.yield(msg)
    }

    private func handleMedia(_ env: Wire.Envelope, srcAddr: String) {
        guard let out = mediaReassembler.push(env) else { return }
        guard !seenIds.contains(out.id) else { return }
        markSeen(out.id)
        let kind: IncomingAttachment.Kind
        switch out.media {
        case .image: kind = .image
        case .audio: kind = .audio
        case .file:  kind = .file
        }
        let attachment = IncomingAttachment(
            kind: kind,
            bytes: out.bytes,
            filename: out.filename,
            mime: out.mime
        )
        let msg = IncomingMessage(
            id: out.id,
            text: out.caption ?? "",
            ts: out.ts,
            senderAddress: srcAddr,
            attachments: [attachment]
        )
        recvContinuation.yield(msg)
    }

    private func markSeen(_ id: String) {
        seenIds.insert(id)
        if seenIds.count > 512 {
            seenIds = Set(seenIds.shuffled().prefix(256))
        }
    }

    /// Send user text to the claw. Splits into chunks if needed.
    public func send(text: String, messageId: String? = nil) async throws -> String {
        guard let p = pilot, isReady else {
            pcLog.error("send(text): not started")
            throw ConnectionError.notStarted
        }
        let id = messageId ?? Wire.newId()
        let envelopes = Wire.chunk(text: text, kind: .user, id: id)
        pcLog.info("send(text) id=\(id, privacy: .public) chunks=\(envelopes.count, privacy: .public) bytes=\(text.utf8.count, privacy: .public) → \(self.cfg.claw.address, privacy: .public):\(self.cfg.clawAppPort, privacy: .public) hmac=\(self.cfg.sharedSecret.isEmpty ? "off" : "on", privacy: .public)")
        do {
            for env in envelopes {
                try sendEnvelope(env, via: p)
            }
            pcLog.info("send(text) ok id=\(id, privacy: .public)")
        } catch {
            pcLog.error("send(text) FAILED id=\(id, privacy: .public) err=\(String(describing: error), privacy: .public)")
            throw error
        }
        return id
    }

    /// Send a media attachment (image / file / audio) to the claw.
    public func send(
        media: Wire.MediaKind,
        bytes: Data,
        filename: String? = nil,
        mime: String? = nil,
        caption: String? = nil,
        messageId: String? = nil
    ) async throws -> String {
        guard let p = pilot, isReady else {
            pcLog.error("send(media): not started")
            throw ConnectionError.notStarted
        }
        let id = messageId ?? Wire.newId()
        let envelopes = Wire.chunkMedia(.init(
            from: .user,
            media: media,
            bytes: bytes,
            filename: filename,
            mime: mime,
            caption: caption,
            id: id
        ))
        pcLog.info("send(media) id=\(id, privacy: .public) kind=\(media.rawValue, privacy: .public) chunks=\(envelopes.count, privacy: .public) bytes=\(bytes.count, privacy: .public) → \(self.cfg.claw.address, privacy: .public):\(self.cfg.clawAppPort, privacy: .public) hmac=\(self.cfg.sharedSecret.isEmpty ? "off" : "on", privacy: .public)")
        do {
            for env in envelopes {
                try sendEnvelope(env, via: p)
            }
            pcLog.info("send(media) ok id=\(id, privacy: .public)")
        } catch {
            pcLog.error("send(media) FAILED id=\(id, privacy: .public) err=\(String(describing: error), privacy: .public)")
            throw error
        }
        return id
    }

    private func sendEnvelope(_ env: Wire.Envelope, via p: Pilot) throws {
        var signed = env
        if !cfg.sharedSecret.isEmpty {
            do {
                signed.hmac = try Wire.sign(env, secret: cfg.sharedSecret)
            } catch {
                throw ConnectionError.encodeFailed("hmac sign: \(error)")
            }
        }
        let data: Data
        do {
            data = try Wire.encode(signed)
        } catch {
            throw ConnectionError.encodeFailed(String(describing: error))
        }
        do {
            try p.send(to: cfg.claw.address, port: cfg.clawAppPort, data: data)
        } catch {
            throw ConnectionError.sendFailed(String(describing: error))
        }
    }

    public func stop() {
        tearDownDaemon()
        recvContinuation.finish()
        ackContinuation.finish()
        errorContinuation.finish()
    }

    /// Tear down the embedded Pilot daemon and rebuild it from scratch.
    /// Same effect as `stop()` + `start()` but **keeps the AsyncStream
    /// continuations alive** so existing subscribers (Conversation,
    /// notification observers) keep receiving messages without resubscribing.
    ///
    /// The wedge fix: iOS suspends the app's UDP socket when the app is
    /// backgrounded for any meaningful duration. The Pilot daemon stays alive
    /// in-process but its socket is dead; subsequent `send()` calls either
    /// throw or silently no-op into the void. The only reliable recovery is
    /// a full daemon rebuild — that's what app-restart used to be the workaround
    /// for. Call this on app return-to-foreground, or after a stretch of
    /// unacknowledged sends, to recover without forcing the user to restart.
    ///
    /// `gracePeriodMs` is the pause between teardown and re-start. Pilot.stop()
    /// returns synchronously, but the underlying Go runtime tears down its
    /// goroutines and releases the unix socket asynchronously — slamming
    /// start() immediately after stop() can race the socket release. 500ms
    /// is enough for the common case; the forceReconnect() path uses more.
    public func reconnect(maxAttempts: Int = 4, gracePeriodMs: UInt64 = 500) async throws {
        tearDownDaemon()
        if gracePeriodMs > 0 {
            try? await Task.sleep(nanoseconds: gracePeriodMs * 1_000_000)
        }
        restartGeneration += 1
        try await start(maxAttempts: maxAttempts)
    }

    /// Most aggressive recovery path — for when `reconnect()` already failed
    /// and the user is staring at a frozen chat. Longer grace, more
    /// retry attempts, and unconditionally cycles the socket basename.
    /// Surface this through a UI button labelled "Force restart daemon" so
    /// the user has explicit agency when auto-recovery loses.
    public func forceReconnect() async throws {
        try await reconnect(maxAttempts: 6, gracePeriodMs: 1_500)
    }

    private func tearDownDaemon() {
        recvTask?.cancel()
        recvTask = nil
        do {
            try pilot?.stop()
        } catch {
            // Visibility for the wedge case — historically swallowed with
            // `try?`, which hid the very signal we needed to diagnose
            // reconnect failures.
            pcLog.warning("pilot.stop() threw during teardown: \(String(describing: error), privacy: .public)")
        }
        pilot = nil
        isReady = false
        selfAddress = nil
        selfNodeId = nil
    }
}
