// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lightweight wrappers around UIDocumentPicker + PHPickerViewController so
// the chat composer can attach files and photos.

#if canImport(SwiftUI)
import SwiftUI
import UniformTypeIdentifiers

#if canImport(UIKit)
import UIKit
import PhotosUI

struct FilePickerSheet: UIViewControllerRepresentable {
    let onPicked: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(
            forOpeningContentTypes: [.item],
            asCopy: true
        )
        picker.allowsMultipleSelection = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_: UIDocumentPickerViewController, context _: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPicked: (URL) -> Void
        init(onPicked: @escaping (URL) -> Void) { self.onPicked = onPicked }
        func documentPicker(_: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { onPicked(url) }
        }
    }
}

struct PhotoPickerSheet: UIViewControllerRepresentable {
    let onPicked: (Data?, String?, String?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_: PHPickerViewController, context _: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPicked: (Data?, String?, String?) -> Void
        init(onPicked: @escaping (Data?, String?, String?) -> Void) {
            self.onPicked = onPicked
        }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard let provider = results.first?.itemProvider else {
                onPicked(nil, nil, nil)
                return
            }
            let onPicked = self.onPicked
            // Prefer the original file representation so we keep EXIF and avoid
            // the OS recompressing to JPEG behind our back.
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    let mime: String? = data.flatMap(sniffImageMime(_:))
                    let filename = provider.suggestedName.map { "\($0).\(extForMime(mime ?? "image/jpeg"))" }
                    DispatchQueue.main.async {
                        onPicked(data, filename, mime ?? "image/jpeg")
                    }
                }
            } else {
                onPicked(nil, nil, nil)
            }
        }
    }
}

private func sniffImageMime(_ data: Data) -> String? {
    guard data.count >= 12 else { return nil }
    let b = [UInt8](data.prefix(12))
    // PNG
    if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
    // JPEG (FF D8 FF)
    if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    // GIF87a / GIF89a
    if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
    // WEBP: RIFF....WEBP
    if b.count >= 12 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46
        && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50 {
        return "image/webp"
    }
    return nil
}

private func extForMime(_ mime: String) -> String {
    switch mime {
    case "image/png":  return "png"
    case "image/jpeg": return "jpg"
    case "image/gif":  return "gif"
    case "image/webp": return "webp"
    case "image/heic": return "heic"
    default:           return "img"
    }
}

#else

// macOS stubs so the package still builds; macOS isn't the primary target.
struct FilePickerSheet: View {
    let onPicked: (URL) -> Void
    var body: some View {
        Text("File picker is iOS-only in v0").padding()
    }
}

#endif
#endif
