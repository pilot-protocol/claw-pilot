// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SwiftUI surface for the chat. Single conversation, single configured claw.

#if canImport(SwiftUI)
import SwiftUI

public struct ClawChatView: View {
    @StateObject private var convo: Conversation = Conversation()
    @Environment(\.scenePhase) private var scenePhase
    private let clawConfig: PilotConnection.Config
    private let notificationTitle: String?
    /// Transient toast text that appears when the user taps an inline pilot
    /// address (handled by handlePeerLink). Auto-clears after a short delay.
    @State private var peerLinkToast: String?
    /// Non-nil while a QuickLook preview sheet is open. Set by tapping any
    /// non-pkpass attachment; the sheet renders images, PDFs, audio, video,
    /// MS Office, iWork, USDZ, RTF — anything QL knows how to handle.
    @State private var previewURL: URL?
    /// Non-nil while a PassKit Add-to-Wallet sheet is open. Set by tapping
    /// a `.pkpass` attachment; PKAddPassesViewController previews the pass
    /// and offers install.
    @State private var walletPassData: Data?

    public init(clawConfig: PilotConnection.Config, notificationTitle: String? = nil) {
        self.clawConfig = clawConfig
        self.notificationTitle = notificationTitle
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if case .error(let message) = convo.state {
                errorBanner(message)
                Divider()
            } else if let status = convo.statusMessage, shouldShowStatusBanner(status) {
                statusBanner(status)
                Divider()
            }
            messageList
            composer
        }
        // Pilot addresses inside messages are rendered as clawchat://peer/<addr>
        // links. Catch them before the system tries to open an unknown scheme.
        .environment(\.openURL, OpenURLAction { url in
            if let addr = ChatLinkScheme.peerAddress(from: url) {
                handlePeerLink(addr)
                return .handled
            }
            return .systemAction
        })
        .overlay(alignment: .bottom) {
            if let t = peerLinkToast {
                Text(t)
                    .font(.caption)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 80)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        // QuickLook preview for non-pkpass attachments. Bound to previewURL
        // so the sheet auto-dismisses when set to nil from the close button.
        .sheet(isPresented: Binding(
            get: { previewURL != nil },
            set: { if !$0 { previewURL = nil } },
        )) {
            #if canImport(UIKit)
            if let url = previewURL {
                QuickLookSheet(url: url)
                    .ignoresSafeArea()
            }
            #endif
        }
        // Apple Wallet pass install sheet, dedicated path for .pkpass.
        .sheet(isPresented: Binding(
            get: { walletPassData != nil },
            set: { if !$0 { walletPassData = nil } },
        )) {
            #if canImport(UIKit)
            if let data = walletPassData {
                WalletPassSheet(passData: data) {
                    walletPassData = nil
                }
            }
            #endif
        }
        .onAppear { ensureConnected() }
        .onDisappear {
            convo.disconnect()
        }
        // Energy: when the OS moves us to .background, tear the daemon down
        // entirely rather than letting iOS half-suspend our UDP socket.
        // The existing wedge-recovery (cycled socket basename + grace period)
        // makes the reconnect on return-to-foreground reliable. Pairs with
        // observeAppForeground for the brief .inactive ↔ .active flicker
        // case (Control Center, app switcher peek) where we stay alive.
        .onChange(of: scenePhase) { newPhase in
            switch newPhase {
            case .background:
                if convo.state != .idle {
                    convo.disconnect()
                }
            case .active:
                ensureConnected()
            case .inactive:
                // Transient state (app switcher peek, incoming notification
                // banner, etc.) — don't churn the connection.
                break
            @unknown default:
                break
            }
        }
    }

    /// Boot the connection if it isn't already running. Idempotent — safe
    /// to call from both `.onAppear` (first-launch) and the scenePhase
    /// `.active` handler (return-from-background, after we proactively
    /// disconnected on `.background`).
    private func ensureConnected() {
        guard convo.state == .idle else { return }
        // Wire local notifications for claw → me messages that arrive
        // while the user isn't actively looking at the chat. No-op on
        // platforms without UserNotifications.
        NotificationCoordinator.shared.requestAuthorizationIfNeeded()
        let title = notificationTitle ?? "Claw"
        convo.onIncoming = { msg in
            let preview = msg.text.isEmpty
                ? (msg.attachments.first.map { "[\($0.kind.rawValue)]" } ?? "(attachment)")
                : msg.text
            NotificationCoordinator.shared.postIncoming(
                title: title,
                body: preview,
                threadId: title,
            )
        }
        // Persist chat history per profile + arm the auto-retry outbox
        // so messages typed while offline drain when we reconnect.
        convo.messageStore = MessageStore(profileDir: clawConfig.dataDir)
        convo.connect(config: clawConfig)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Couldn't reach the claw")
                    .font(.subheadline.bold())
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Button("Retry") { convo.refresh() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color.orange.opacity(0.08))
    }

    private var header: some View {
        HStack(spacing: 8) {
            statePip
            VStack(alignment: .leading, spacing: 2) {
                Text("Claw").font(.headline)
                Text(clawConfig.claw.address)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                lastActivityLine
            }
            Spacer()
            statusBadge
            Menu {
                Button {
                    convo.refresh()
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }
                .disabled(refreshDisabled)
                Button {
                    convo.testConnection()
                } label: {
                    Label("Test connection", systemImage: "bolt.heart")
                }
                .disabled(!isReady)
                Divider()
                // Manual escape hatch when auto-recovery loses. Bumps the
                // socket basename, waits longer for the Go runtime to
                // release sockets, then re-starts. Labelled distinctly so
                // it doesn't get confused with the cheap Reconnect path.
                Button(role: .destructive) {
                    convo.forceReset()
                } label: {
                    Label("Force restart daemon", systemImage: "exclamationmark.arrow.circlepath")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .imageScale(.large)
            }
            .accessibilityLabel("Connection actions")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.thinMaterial)
    }

    /// Always-visible colored dot in the header. Color follows the connection
    /// state — at-a-glance signal that scales independently of label text.
    private var statePip: some View {
        Circle()
            .fill(statePipColor)
            .frame(width: 10, height: 10)
            .overlay(
                Circle()
                    .stroke(.black.opacity(0.08), lineWidth: 0.5)
            )
            .accessibilityHidden(true)
    }

    private var statePipColor: Color {
        switch convo.state {
        case .idle:        return .gray
        case .connecting:  return .yellow
        case .ready:       return .green
        case .error:       return .red
        }
    }

    /// "last activity Xs ago" — refreshed every 30s instead of every 5s for
    /// energy reasons. The granularity of the displayed string (`Xs` /
    /// `Xm` / `Xh`) means sub-30s precision wasn't visible anyway above the
    /// "Xs" bucket, and the `lastAckAt` change itself triggers a re-render
    /// the instant a new ack lands. Hidden when no ack has ever arrived so
    /// first-load doesn't briefly flash "0s ago".
    @ViewBuilder
    private var lastActivityLine: some View {
        if let last = convo.lastAckAt {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let elapsed = max(0, context.date.timeIntervalSince(last))
                Text("last ack \(formatElapsed(elapsed)) ago")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func formatElapsed(_ seconds: TimeInterval) -> String {
        if seconds < 60 { return "\(Int(seconds))s" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        return "\(Int(seconds / 3600))h"
    }

    /// Suppress the status banner for noisy steady-state messages so the
    /// banner only flashes when something interesting happens (refreshes,
    /// watchdog activity, errors). The "ready as <addr>" line on first
    /// connect is fine to omit — the state pip already covers it.
    private func shouldShowStatusBanner(_ msg: String) -> Bool {
        if msg.hasPrefix("ready as ") { return false }
        return true
    }

    /// Thin info banner under the header. Surfaces watchdog activity,
    /// reconnection progress, and other Conversation-level events that the
    /// user otherwise wouldn't see ("watchdog tripped — 2 message(s) unacked
    /// for >60s, reconnecting" and similar).
    private func statusBanner(_ message: String) -> some View {
        let palette = statusBannerPalette(message)
        return HStack(spacing: 10) {
            Image(systemName: palette.icon)
                .foregroundStyle(palette.tint)
            Text(message)
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(2)
            Spacer(minLength: 0)
            // Surface a one-tap escape hatch when the banner is signalling
            // an actual failure (not just "refreshing…"). Equivalent to the
            // Force restart menu item but doesn't require diving through
            // the Connection actions menu.
            if shouldOfferForceRestart(message) {
                Button("Force restart") {
                    convo.forceReset()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(palette.tint.opacity(0.08))
    }

    /// Banner messages that warrant a prominent reset button. Watchdog-tripped
    /// and outright failures qualify; informational "refreshing…" /
    /// "reconnecting…" messages don't (action would race with what's already
    /// in flight).
    private func shouldOfferForceRestart(_ msg: String) -> Bool {
        if msg.localizedCaseInsensitiveContains("FAILED") { return true }
        if msg.localizedCaseInsensitiveContains("watchdog") { return true }
        if msg.localizedCaseInsensitiveContains("wedge") { return true }
        return false
    }

    private func statusBannerPalette(_ msg: String) -> (icon: String, tint: Color) {
        if msg.localizedCaseInsensitiveContains("fail")
            || msg.localizedCaseInsensitiveContains("error")
            || msg.localizedCaseInsensitiveContains("wedge") {
            return ("exclamationmark.triangle.fill", .orange)
        }
        if msg.localizedCaseInsensitiveContains("reconnect")
            || msg.localizedCaseInsensitiveContains("refresh")
            || msg.localizedCaseInsensitiveContains("watchdog") {
            return ("arrow.clockwise", .yellow)
        }
        if msg.localizedCaseInsensitiveContains("disconnect") {
            return ("powersleep", .gray)
        }
        return ("info.circle", .blue)
    }

    private var refreshDisabled: Bool {
        if case .connecting = convo.state { return true }
        return false
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch convo.state {
        case .idle:
            Label("idle", systemImage: "moon.fill").foregroundStyle(.secondary)
        case .connecting:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("connecting…").font(.caption)
            }
        case .ready(let addr):
            Label("online", systemImage: "circle.fill")
                .labelStyle(.iconOnly)
                .font(.caption)
                .foregroundStyle(.green)
                .help("your pilot addr: \(addr)")
        case .error(let m):
            Label(m, systemImage: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
                .lineLimit(2)
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(convo.messages) { m in
                        bubble(m)
                            .id(m.id)
                    }
                }
                .padding(16)
                // Make the empty space between/around bubbles tappable so a
                // tap anywhere in the chat area dismisses the keyboard.
                // textSelection on bubbles still captures their own taps —
                // this only fires on the surrounding gap.
                .contentShape(Rectangle())
                .onTapGesture {
                    dismissKeyboard()
                }
            }
            // Drag-down-to-dismiss while scrolling (iOS 16+).
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: convo.messages.count) { _ in
                if let last = convo.messages.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    /// Dismiss the soft keyboard regardless of which TextField currently has
    /// focus. Walks the responder chain via UIApplication so we don't have
    /// to thread @FocusState through every composer-adjacent view.
    private func dismissKeyboard() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil,
        )
        #endif
    }

    /// Handle a tap on an inline pilot-address pill: copy the address to the
    /// system clipboard and surface a brief confirmation toast. Convenient
    /// for "the agent mentioned a peer; copy it into the address book."
    private func handlePeerLink(_ address: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = address
        #endif
        withAnimation(.easeInOut(duration: 0.2)) {
            peerLinkToast = "copied \(address)"
        }
        // Auto-clear after a short window so the toast doesn't linger.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            withAnimation(.easeInOut(duration: 0.2)) {
                peerLinkToast = nil
            }
        }
    }

    @State private var showFilePicker = false
    @State private var showPhotoPicker = false

    private func bubble(_ m: ChatMessage) -> some View {
        HStack {
            if m.sender == .me { Spacer(minLength: 40) }
            VStack(alignment: m.sender == .me ? .trailing : .leading, spacing: 6) {
                ForEach(Array(m.attachments.enumerated()), id: \.offset) { _, att in
                    attachmentView(att, messageId: m.id, alignment: m.sender == .me ? .trailing : .leading)
                }
                if !m.text.isEmpty {
                    Text(renderChatText(m.text))
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            m.sender == .me
                                ? Color.accentColor.opacity(0.18)
                                : Color.secondary.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                        )
                }
                if m.sender == .me {
                    deliveryIndicator(m.delivery, connected: isConnected)
                }
            }
            if m.sender == .claw { Spacer(minLength: 40) }
        }
    }

    @ViewBuilder
    private func deliveryIndicator(_ state: ChatDeliveryState, connected: Bool) -> some View {
        switch state {
        case .sending:
            if connected {
                Label("sending", systemImage: "clock")
                    .labelStyle(.iconOnly)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                // Offline-queued: distinguish visually so the user understands
                // the message is waiting on the connection to come back, not
                // mid-flight. drainOutbox() will fire it the moment we reconnect.
                Label("queued (offline)", systemImage: "tray.fill")
                    .labelStyle(.iconOnly)
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        case .sent:
            Label("sent", systemImage: "checkmark")
                .labelStyle(.iconOnly)
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .delivered:
            Label("delivered", systemImage: "checkmark.circle.fill")
                .labelStyle(.iconOnly)
                .font(.caption2)
                .foregroundStyle(.green)
        case .failed:
            Label("failed", systemImage: "exclamationmark.triangle.fill")
                .labelStyle(.iconOnly)
                .font(.caption2)
                .foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private func attachmentView(
        _ att: ChatAttachment,
        messageId: String,
        alignment: HorizontalAlignment,
    ) -> some View {
        Group {
            switch att.kind {
            case .image:
                #if canImport(UIKit)
                if let uiImage = UIImage(data: att.bytes) {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    fileChip(filename: att.filename ?? "image", size: att.bytes.count, system: "photo.fill")
                }
                #else
                if let nsImage = NSImage(data: att.bytes) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    fileChip(filename: att.filename ?? "image", size: att.bytes.count, system: "photo.fill")
                }
                #endif
            case .file:
                // Special-case Wallet passes — distinct icon + label so users
                // recognise it before tap.
                if isWalletPass(att) {
                    fileChip(
                        filename: att.filename ?? "pass.pkpass",
                        size: att.bytes.count,
                        system: "wallet.pass.fill",
                    )
                } else {
                    fileChip(
                        filename: att.filename ?? "file",
                        size: att.bytes.count,
                        system: iconForFileMime(att.mime, filename: att.filename),
                    )
                }
            case .audio:
                fileChip(filename: att.filename ?? "audio", size: att.bytes.count, system: "waveform")
            }
        }
        // Tap → QuickLook (or PassKit for .pkpass). Native iOS viewers
        // handle images, PDFs, audio, video, RTF, MS Office, iWork, USDZ,
        // and pkpass previews; PKAddPassesViewController is the dedicated
        // path for actually installing a wallet pass.
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onTapGesture {
            handleAttachmentTap(att, messageId: messageId)
        }
        .accessibilityHint("Double-tap to preview")
    }

    /// Icon to use in the file chip based on the attachment mime/filename
    /// — gives the user a hint about what they're about to open without
    /// reading the filename.
    private func iconForFileMime(_ mime: String?, filename: String?) -> String {
        let ext = filename?.lowercased().split(separator: ".").last.map(String.init) ?? ""
        if mime == "application/pdf" || ext == "pdf" { return "doc.richtext.fill" }
        if mime?.hasPrefix("image/") == true { return "photo.fill" }
        if mime?.hasPrefix("video/") == true { return "play.rectangle.fill" }
        if mime?.hasPrefix("audio/") == true { return "waveform" }
        if mime == "application/json" || ext == "json" { return "curlybraces" }
        if mime == "text/plain" || mime == "text/markdown" || ext == "txt" || ext == "md" {
            return "doc.text.fill"
        }
        return "doc.fill"
    }

    /// Route an attachment tap to the right native iOS viewer. Wallet
    /// passes go through PassKit; everything else through QuickLook.
    /// Bytes are written to a temp file on first tap (cheap; QL needs a
    /// URL not raw Data).
    private func handleAttachmentTap(_ att: ChatAttachment, messageId: String) {
        #if canImport(UIKit)
        if isWalletPass(att) {
            walletPassData = att.bytes
            return
        }
        do {
            previewURL = try writeAttachmentToPreviewTemp(att, messageId: messageId)
        } catch {
            // Last-ditch: we'd rather silently swallow than crash; user
            // taps again or restarts. The attachment bubble still shows.
            return
        }
        #endif
    }

    private func fileChip(filename: String, size: Int, system: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: system)
                .imageScale(.large)
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(filename).font(.subheadline).lineLimit(1)
                Text(formatBytes(size))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            Color.secondary.opacity(0.12),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("attachment \(filename), \(formatBytes(size))")
    }

    private func formatBytes(_ n: Int) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: Int64(n))
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Menu {
                Button {
                    showPhotoPicker = true
                } label: {
                    Label("Photo", systemImage: "photo")
                }
                Button {
                    showFilePicker = true
                } label: {
                    Label("File", systemImage: "doc")
                }
            } label: {
                Image(systemName: "plus.circle.fill")
                    .imageScale(.large)
            }
            .disabled(!isReady)
            TextField("message…", text: $convo.draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit { convo.send() }
            Button(action: convo.send) {
                Image(systemName: "paperplane.fill")
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSend)
        }
        .padding(12)
        .background(.thinMaterial)
        .sheet(isPresented: $showFilePicker) {
            FilePickerSheet { url in
                handlePickedFile(url)
            }
        }
        #if canImport(UIKit)
        .sheet(isPresented: $showPhotoPicker) {
            PhotoPickerSheet { data, filename, mime in
                if let data {
                    convo.sendAttachment(kind: .image, bytes: data, filename: filename, mime: mime)
                }
            }
        }
        #endif
    }

    private var isReady: Bool {
        if case .ready = convo.state { return true }
        return false
    }

    /// True when the iOS daemon is fully handshaked with the claw — proxy
    /// for "if you send now, it goes out immediately". Drives the visual
    /// distinction between live-sending and offline-queued message bubbles.
    private var isConnected: Bool { isReady }

    private func handlePickedFile(_ url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        let filename = url.lastPathComponent
        let mime = mimeForExtension(url.pathExtension.lowercased())
        let kind: ChatAttachment.Kind = mime.starts(with: "image/")
            ? .image
            : mime.starts(with: "audio/") ? .audio : .file
        convo.sendAttachment(kind: kind, bytes: data, filename: filename, mime: mime)
    }

    private func mimeForExtension(_ ext: String) -> String {
        switch ext {
        case "png":  return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif":  return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "mp3":  return "audio/mpeg"
        case "m4a":  return "audio/mp4"
        case "wav":  return "audio/wav"
        case "pdf":  return "application/pdf"
        case "txt":  return "text/plain"
        case "json": return "application/json"
        default:     return "application/octet-stream"
        }
    }

    private var canSend: Bool {
        if case .ready = convo.state {
            return !convo.draft.trimmingCharacters(in: .whitespaces).isEmpty
        }
        return false
    }
}
#endif
