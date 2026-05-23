// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

final class MessageStoreTests: XCTestCase {

    private var workDir: URL!

    override func setUpWithError() throws {
        workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("messagestore-test-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workDir)
    }

    func testLoadFromEmptyDirReturnsEmpty() {
        let store = MessageStore(profileDir: workDir)
        XCTAssertEqual(store.load(), [])
    }

    func testRoundTripPreservesAllStates() {
        let store = MessageStore(profileDir: workDir)
        let saved: [ChatMessage] = [
            ChatMessage(id: "a", sender: .me, text: "hello", delivery: .sending),
            ChatMessage(id: "b", sender: .me, text: "world", delivery: .sent),
            ChatMessage(id: "c", sender: .claw, text: "hi", delivery: .delivered),
            ChatMessage(id: "d", sender: .me, text: "oops", delivery: .failed("net down")),
        ]
        store.save(saved)
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 4)
        XCTAssertEqual(loaded[0].id, "a")
        XCTAssertEqual(loaded[0].delivery, .sending)
        XCTAssertEqual(loaded[3].delivery, .failed("net down"))
        XCTAssertEqual(loaded[2].sender, .claw)
    }

    func testCorruptFileRecoversToEmpty() throws {
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        let path = workDir.appendingPathComponent("messages.json")
        try "not json".data(using: .utf8)!.write(to: path)
        let store = MessageStore(profileDir: workDir)
        XCTAssertEqual(store.load(), [])
    }

    func testSaveIsAtomic_NoCorruptOnRepeatedSaves() {
        // Multiple saves in quick succession must always leave a parseable file.
        let store = MessageStore(profileDir: workDir)
        for i in 0..<10 {
            store.save([
                ChatMessage(id: "msg-\(i)", sender: .me, text: "msg \(i)", delivery: .sent),
            ])
        }
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].text, "msg 9")
    }

    func testUnknownSchemaVersionFallsBackToEmpty() throws {
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        let path = workDir.appendingPathComponent("messages.json")
        let bad = #"{"version": 999, "messages": []}"#
        try bad.data(using: .utf8)!.write(to: path)
        let store = MessageStore(profileDir: workDir)
        XCTAssertEqual(store.load(), [])
    }

    // MARK: - Attachments (iter 30)

    func testAttachmentBytesRoundTripViaSidecar() {
        let store = MessageStore(profileDir: workDir)
        // 16-byte PNG-ish payload — enough to verify byte-equality on rehydrate.
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                          0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52])
        let att = ChatAttachment(kind: .image, bytes: bytes, filename: "x.png", mime: "image/png")
        let msg = ChatMessage(id: "m1", sender: .claw, text: "see attached",
                              attachments: [att], delivery: .delivered)
        store.save([msg])

        // Sidecar file should exist + match.
        let sidecar = store.attachmentsDir.appendingPathComponent("m1-0.png")
        XCTAssertTrue(FileManager.default.fileExists(atPath: sidecar.path),
                      "expected sidecar at \(sidecar.path)")
        let onDisk = try? Data(contentsOf: sidecar)
        XCTAssertEqual(onDisk, bytes)

        // Rehydrated message must carry the exact same bytes back.
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].attachments.count, 1)
        XCTAssertEqual(loaded[0].attachments[0].bytes, bytes)
        XCTAssertEqual(loaded[0].attachments[0].filename, "x.png")
        XCTAssertEqual(loaded[0].attachments[0].mime, "image/png")
        XCTAssertEqual(loaded[0].attachments[0].kind, .image)
    }

    func testAttachmentExtensionFromMimeFallback() {
        // When filename has no extension, picker uses MIME → ext mapping.
        let store = MessageStore(profileDir: workDir)
        let att = ChatAttachment(kind: .audio, bytes: Data([1, 2, 3]), filename: "voice", mime: "audio/mp4")
        let msg = ChatMessage(id: "snd", sender: .me, text: "", attachments: [att], delivery: .sent)
        store.save([msg])
        let sidecar = store.attachmentsDir.appendingPathComponent("snd-0.m4a")
        XCTAssertTrue(FileManager.default.fileExists(atPath: sidecar.path))
    }

    func testAttachmentDirectoryTraversalSanitized() {
        // Malicious message id with "/" or ".." must not escape attachments/.
        let store = MessageStore(profileDir: workDir)
        let att = ChatAttachment(kind: .file, bytes: Data([0x42]), filename: "doc.txt", mime: "text/plain")
        let msg = ChatMessage(id: "../../evil", sender: .claw, text: "",
                              attachments: [att], delivery: .delivered)
        store.save([msg])
        // We don't care about the exact sanitized name, just that nothing
        // landed outside attachmentsDir.
        let escaped = workDir.deletingLastPathComponent().appendingPathComponent("evil")
        XCTAssertFalse(FileManager.default.fileExists(atPath: escaped.path),
                       "escaped attachment dir!")
        // And that load() still returns the message with bytes intact.
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].attachments[0].bytes, Data([0x42]))
    }

    func testMissingSidecarDropsAttachmentButKeepsMessage() {
        let store = MessageStore(profileDir: workDir)
        let bytes = Data([1, 2, 3, 4])
        let att = ChatAttachment(kind: .image, bytes: bytes, filename: "x.jpg", mime: "image/jpeg")
        let msg = ChatMessage(id: "m1", sender: .claw, text: "hi", attachments: [att], delivery: .delivered)
        store.save([msg])
        // Remove the sidecar by hand to simulate corrupt / lost file.
        let sidecar = store.attachmentsDir.appendingPathComponent("m1-0.jpg")
        try? FileManager.default.removeItem(at: sidecar)
        let loaded = store.load()
        // Message survives, attachment dropped (partial > nothing).
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].text, "hi")
        XCTAssertEqual(loaded[0].attachments.count, 0)
    }
}
