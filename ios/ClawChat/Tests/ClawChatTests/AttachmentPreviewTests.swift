// SPDX-License-Identifier: AGPL-3.0-or-later

import Foundation
import XCTest
@testable import ClawChat

final class AttachmentPreviewTests: XCTestCase {

    private func att(
        kind: ChatAttachment.Kind = .file,
        bytes: Data = Data([0x00]),
        filename: String? = nil,
        mime: String? = nil,
    ) -> ChatAttachment {
        ChatAttachment(kind: kind, bytes: bytes, filename: filename, mime: mime)
    }

    // MARK: isWalletPass

    func testIsWalletPassByMime() {
        XCTAssertTrue(isWalletPass(att(mime: "application/vnd.apple.pkpass")))
    }

    func testIsWalletPassByFilenameExtension() {
        XCTAssertTrue(isWalletPass(att(filename: "boarding.pkpass")))
        XCTAssertTrue(isWalletPass(att(filename: "BOARDING.PKPASS"))) // case-insensitive
    }

    func testIsWalletPassRejectsOtherFiles() {
        XCTAssertFalse(isWalletPass(att(filename: "doc.pdf", mime: "application/pdf")))
        XCTAssertFalse(isWalletPass(att(filename: "image.jpg", mime: "image/jpeg")))
        XCTAssertFalse(isWalletPass(att()))
    }

    // MARK: sanitizeAttachmentFilename

    func testSanitizeStripsPathTraversal() {
        // `..` inside a single path component is harmless once `/` is
        // stripped; we only need to break the navigation separators.
        XCTAssertEqual(sanitizeAttachmentFilename("../../etc/passwd"), ".._.._etc_passwd")
        XCTAssertEqual(sanitizeAttachmentFilename("foo/bar.png"), "foo_bar.png")
        XCTAssertEqual(sanitizeAttachmentFilename(#"foo\bar.png"#), "foo_bar.png")
    }

    func testSanitizePreservesNormalNames() {
        XCTAssertEqual(sanitizeAttachmentFilename("photo.png"), "photo.png")
        XCTAssertEqual(sanitizeAttachmentFilename("résumé.pdf"), "résumé.pdf")
    }

    // MARK: extensionForAttachment

    func testExtensionFromFilenameWins() {
        let a = att(filename: "boarding.pkpass", mime: "application/octet-stream")
        XCTAssertEqual(extensionForAttachment(a), "pkpass")
    }

    func testExtensionFromMimeAsFallback() {
        XCTAssertEqual(extensionForAttachment(att(mime: "image/png")), "png")
        XCTAssertEqual(extensionForAttachment(att(mime: "image/jpeg")), "jpg")
        XCTAssertEqual(extensionForAttachment(att(mime: "application/pdf")), "pdf")
        XCTAssertEqual(extensionForAttachment(att(mime: "application/vnd.apple.pkpass")), "pkpass")
        XCTAssertEqual(extensionForAttachment(att(mime: "video/mp4")), "mp4")
        XCTAssertEqual(extensionForAttachment(att(mime: "audio/mpeg")), "mp3")
        XCTAssertEqual(extensionForAttachment(att(mime: "text/markdown")), "md")
    }

    func testExtensionKindBasedLastResort() {
        XCTAssertEqual(extensionForAttachment(att(kind: .image)), "jpg")
        XCTAssertEqual(extensionForAttachment(att(kind: .audio)), "m4a")
        XCTAssertEqual(extensionForAttachment(att(kind: .file)), "")
    }

    func testExtensionLowercases() {
        // QuickLook's MIME table is case-sensitive on the extension lookup.
        let a = att(filename: "Boarding.PKPASS")
        XCTAssertEqual(extensionForAttachment(a), "pkpass")
    }

    // MARK: previewFilename

    func testPreviewFilenamePreservesExistingExtension() {
        let a = att(filename: "doc.pdf")
        XCTAssertEqual(previewFilename(for: a, messageId: "m1"), "m1-doc.pdf")
    }

    func testPreviewFilenameAddsMissingExtension() {
        let a = att(kind: .image, filename: "noext", mime: "image/png")
        XCTAssertEqual(previewFilename(for: a, messageId: "m1"), "m1-noext.png")
    }

    func testPreviewFilenameDoesNotDoubleExtension() {
        let a = att(filename: "photo.png", mime: "image/png")
        XCTAssertEqual(previewFilename(for: a, messageId: "m1"), "m1-photo.png")
    }

    func testPreviewFilenameWhenNoFilenameProvided() {
        let a = att(kind: .image, mime: "image/jpeg")
        XCTAssertEqual(previewFilename(for: a, messageId: "abc"), "abc-image.jpg")
    }

    func testPreviewFilenamePassesThroughForPkpass() {
        let a = att(filename: "boarding.pkpass", mime: "application/vnd.apple.pkpass")
        XCTAssertEqual(previewFilename(for: a, messageId: "m1"), "m1-boarding.pkpass")
    }

    func testPreviewFilenameSanitizesTraversal() {
        let a = att(filename: "../boom.pdf")
        XCTAssertEqual(previewFilename(for: a, messageId: "m1"), "m1-.._boom.pdf")
    }

    // MARK: writeAttachmentToPreviewTemp (UIKit-only)

    #if canImport(UIKit)
    func testWritePreviewTempReturnsURLContainingTheBytes() throws {
        let a = att(
            kind: .image,
            bytes: Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            filename: "header.png",
            mime: "image/png",
        )
        let url = try writeAttachmentToPreviewTemp(a, messageId: "msg-xyz")
        defer { try? FileManager.default.removeItem(at: url) }

        XCTAssertTrue(url.pathExtension == "png")
        XCTAssertTrue(url.lastPathComponent.contains("msg-xyz"))
        let written = try Data(contentsOf: url)
        XCTAssertEqual(written, a.bytes)
    }

    func testWritePreviewTempForPkpassUsesPkpassExtension() throws {
        let a = att(
            kind: .file,
            bytes: Data([0x50, 0x4b, 0x03, 0x04]), // ZIP-like (pkpass is signed zip)
            filename: "boarding.pkpass",
            mime: "application/vnd.apple.pkpass",
        )
        let url = try writeAttachmentToPreviewTemp(a, messageId: "msg-pass")
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertEqual(url.pathExtension, "pkpass")
    }
    #endif
}
