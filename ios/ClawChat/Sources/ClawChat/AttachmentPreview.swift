// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SwiftUI wrappers + helpers for previewing chat attachments via iOS's
// native viewers. QuickLook handles images, PDFs, audio, video, RTF, MS
// Office, iWork, USDZ, and `.pkpass` previews. PassKit's
// PKAddPassesViewController is the dedicated path for actually installing
// a wallet pass; we offer it when the mime/extension says pkpass.
//
// All the helpers below (sanitizing, mime → extension, isWalletPass) are
// pure-Swift and safe to call on macOS test runs. The SwiftUI/UIKit
// wrappers are gated behind `canImport(UIKit)`.

import Foundation

/// True when the attachment looks like an Apple Wallet pass — checked via
/// mime first (authoritative), then falling back to the filename extension.
public func isWalletPass(_ att: ChatAttachment) -> Bool {
    if att.mime == "application/vnd.apple.pkpass" { return true }
    if let f = att.filename?.lowercased(), f.hasSuffix(".pkpass") { return true }
    return false
}

/// Replace path-traversal separators in a filename so it's safe to write
/// under our temp dir. `..` inside a single path component is harmless
/// once `/` and `\` are stripped — the FS won't traverse it. We don't
/// fight Unicode; just stop directory navigation.
public func sanitizeAttachmentFilename(_ raw: String) -> String {
    raw.replacingOccurrences(of: "/", with: "_")
       .replacingOccurrences(of: "\\", with: "_")
}

/// Choose a file extension for an attachment when none is in the filename.
/// QuickLook needs the right extension to pick the right viewer (a PDF
/// without `.pdf` opens as raw bytes; a PNG without `.png` falls back to
/// text preview).
public func extensionForAttachment(_ att: ChatAttachment) -> String {
    // Prefer the filename's own extension if it already has one.
    if let name = att.filename {
        let dotIdx = name.lastIndex(of: ".")
        if let i = dotIdx, i < name.index(before: name.endIndex) {
            let ext = String(name[name.index(after: i)...])
            if !ext.isEmpty { return ext.lowercased() }
        }
    }
    if let m = att.mime {
        switch m {
        case "image/png":  return "png"
        case "image/jpeg": return "jpg"
        case "image/gif":  return "gif"
        case "image/webp": return "webp"
        case "image/heic": return "heic"
        case "application/pdf": return "pdf"
        case "application/vnd.apple.pkpass": return "pkpass"
        case "audio/mpeg": return "mp3"
        case "audio/mp4":  return "m4a"
        case "audio/wav":  return "wav"
        case "video/mp4":  return "mp4"
        case "video/quicktime": return "mov"
        case "text/plain": return "txt"
        case "text/markdown": return "md"
        case "application/json": return "json"
        default: break
        }
    }
    // Kind-based last-resort. Empty string = leave the filename alone.
    switch att.kind {
    case .image: return "jpg"
    case .audio: return "m4a"
    case .file:  return ""
    }
}

/// Build the final on-disk filename for an attachment under the temp
/// preview dir, ensuring the chosen extension is present. Pure — doesn't
/// touch the filesystem.
public func previewFilename(for att: ChatAttachment, messageId: String) -> String {
    let base = sanitizeAttachmentFilename(att.filename ?? defaultBaseName(for: att))
    let ext = extensionForAttachment(att)
    let needsExt = !ext.isEmpty && !base.lowercased().hasSuffix(".\(ext)")
    let withExt = needsExt ? "\(base).\(ext)" : base
    return "\(messageId)-\(withExt)"
}

private func defaultBaseName(for att: ChatAttachment) -> String {
    switch att.kind {
    case .image: return "image"
    case .audio: return "audio"
    case .file:  return "file"
    }
}

#if canImport(UIKit)
import PassKit
import QuickLook
import SwiftUI
import UIKit

/// Write the attachment bytes to a deterministic temp path and return the
/// URL. The same (messageId, attachment) yields the same path across taps
/// so repeated previews reuse the file.
public func writeAttachmentToPreviewTemp(
    _ att: ChatAttachment,
    messageId: String,
) throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("claw-pilot-preview", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let name = previewFilename(for: att, messageId: messageId)
    let url = dir.appendingPathComponent(name)
    try att.bytes.write(to: url, options: .atomic)
    return url
}

/// SwiftUI wrapper around `QLPreviewController`. Present from a `.sheet`
/// with a non-nil URL binding. The controller is wrapped in a navigation
/// controller so the system Done button is available.
public struct QuickLookSheet: UIViewControllerRepresentable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    public func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        return UINavigationController(rootViewController: preview)
    }

    public func updateUIViewController(_ controller: UINavigationController, context: Context) {
        context.coordinator.url = url
        if let preview = controller.viewControllers.first as? QLPreviewController {
            preview.reloadData()
        }
    }

    public final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        public func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        public func previewController(
            _ controller: QLPreviewController,
            previewItemAt index: Int,
        ) -> QLPreviewItem {
            url as QLPreviewItem
        }
    }
}

/// SwiftUI wrapper around `PKAddPassesViewController` — the system sheet
/// that previews a wallet pass and offers the user "Add" / "Cancel".
/// Present from a `.sheet` with a non-nil pass-data binding.
public struct WalletPassSheet: UIViewControllerRepresentable {
    public let passData: Data
    public let onFinished: () -> Void

    public init(passData: Data, onFinished: @escaping () -> Void) {
        self.passData = passData
        self.onFinished = onFinished
    }

    public func makeCoordinator() -> Coordinator { Coordinator(onFinished: onFinished) }

    public func makeUIViewController(context: Context) -> UIViewController {
        // PKPass(data:) throws if the .pkpass is malformed; fall back to a
        // plain alert view so we degrade gracefully rather than crashing
        // the chat surface.
        guard
            let pass = try? PKPass(data: passData),
            let controller = PKAddPassesViewController(pass: pass)
        else {
            let host = UIViewController()
            host.view.backgroundColor = .systemBackground
            // Defer alert presentation until the host is on-screen.
            DispatchQueue.main.async { [weak host] in
                let alert = UIAlertController(
                    title: "Couldn't open pass",
                    message: "The pass is malformed or the platform refused it.",
                    preferredStyle: .alert,
                )
                alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                    context.coordinator.onFinished()
                })
                host?.present(alert, animated: true)
            }
            return host
        }
        controller.delegate = context.coordinator
        return controller
    }

    public func updateUIViewController(_ controller: UIViewController, context: Context) {}

    public final class Coordinator: NSObject, PKAddPassesViewControllerDelegate {
        let onFinished: () -> Void
        init(onFinished: @escaping () -> Void) { self.onFinished = onFinished }
        public func addPassesViewControllerDidFinish(
            _ controller: PKAddPassesViewController,
        ) {
            onFinished()
        }
    }
}
#endif
