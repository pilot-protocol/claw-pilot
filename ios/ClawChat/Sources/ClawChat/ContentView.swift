// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SwiftUI surface for the chat. Single conversation, single configured claw.

#if canImport(SwiftUI)
import SwiftUI

public struct ClawChatView: View {
    @StateObject private var convo: Conversation = Conversation()
    private let clawConfig: PilotConnection.Config
    private let notificationTitle: String?

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
            }
            messageList
            composer
        }
        .onAppear {
            if convo.state == .idle {
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
        }
        .onDisappear {
            convo.disconnect()
        }
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
            VStack(alignment: .leading, spacing: 2) {
                Text("Claw").font(.headline)
                Text(clawConfig.claw.address)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
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
            }
            .onChange(of: convo.messages.count) { _ in
                if let last = convo.messages.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
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
                    attachmentView(att, alignment: m.sender == .me ? .trailing : .leading)
                }
                if !m.text.isEmpty {
                    Text(m.text)
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
    private func attachmentView(_ att: ChatAttachment, alignment: HorizontalAlignment) -> some View {
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
            fileChip(filename: att.filename ?? "file", size: att.bytes.count, system: "doc.fill")
        case .audio:
            fileChip(filename: att.filename ?? "audio", size: att.bytes.count, system: "waveform")
        }
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
