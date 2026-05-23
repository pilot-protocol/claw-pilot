// SPDX-License-Identifier: AGPL-3.0-or-later

import XCTest
@testable import ClawChat

@MainActor
final class ProfileTests: XCTestCase {

    private func freshStore() -> (ProfileStore, UserDefaults) {
        let suite = "test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        let store = ProfileStore(defaults: defaults, dataRoot: dir)
        return (store, defaults)
    }

    func testEmptyOnInit() {
        let (store, _) = freshStore()
        XCTAssertTrue(store.profiles.isEmpty)
        XCTAssertNil(store.selectedProfileId)
    }

    func testAddSelectsFirstProfile() {
        let (store, _) = freshStore()
        let p = store.add(.init(name: "home", address: "1:0000.0000.AAAA", nodeId: 42))
        XCTAssertEqual(store.profiles.count, 1)
        XCTAssertEqual(store.selectedProfileId, p.id)
    }

    func testAddSecondDoesNotChangeSelection() {
        let (store, _) = freshStore()
        let a = store.add(.init(name: "home", address: "1:0000.0000.AAAA", nodeId: 1))
        store.add(.init(name: "office", address: "1:0000.0000.BBBB", nodeId: 2))
        XCTAssertEqual(store.selectedProfileId, a.id)
    }

    func testSwitchProfile() {
        let (store, _) = freshStore()
        let a = store.add(.init(name: "home", address: "1:0000.0000.AAAA", nodeId: 1))
        let b = store.add(.init(name: "office", address: "1:0000.0000.BBBB", nodeId: 2))
        store.select(id: b.id)
        XCTAssertEqual(store.selectedProfileId, b.id)
        XCTAssertEqual(store.selectedProfile?.name, "office")
        store.select(id: a.id)
        XCTAssertEqual(store.selectedProfile?.name, "home")
    }

    func testUpdateProfile() {
        let (store, _) = freshStore()
        var p = store.add(.init(name: "home", address: "1:0000.0000.AAAA", nodeId: 1))
        p.name = "Home Claw"
        store.update(p)
        XCTAssertEqual(store.profiles.first?.name, "Home Claw")
    }

    func testRemoveProfileResetsSelection() {
        let (store, _) = freshStore()
        let a = store.add(.init(name: "home", address: "1:0000.0000.AAAA", nodeId: 1))
        let b = store.add(.init(name: "office", address: "1:0000.0000.BBBB", nodeId: 2))
        store.select(id: b.id)
        store.remove(id: b.id)
        XCTAssertEqual(store.profiles.count, 1)
        XCTAssertEqual(store.selectedProfileId, a.id)
    }

    func testPersistAndRehydrate() {
        let suite = "test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(suite)

        let store1 = ProfileStore(defaults: defaults, dataRoot: dir)
        let p = store1.add(.init(name: "home", address: "1:0000.0000.AAAA", nodeId: 42))
        store1.add(.init(name: "office", address: "2:1111.2222.3333", nodeId: 7))
        store1.select(id: p.id)

        let store2 = ProfileStore(defaults: defaults, dataRoot: dir)
        XCTAssertEqual(store2.profiles.count, 2)
        XCTAssertEqual(store2.selectedProfileId, p.id)
        XCTAssertEqual(store2.profiles.first?.name, "home")
    }

    func testProfileMakesValidPilotConfig() {
        let p = ClawProfile(name: "home", address: "1:0000.0000.AAAA", nodeId: 211518, appPort: 7777)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("profile-test")
        let cfg = p.makeConfig(dataRoot: dir)
        XCTAssertEqual(cfg.claw.address, "1:0000.0000.AAAA")
        XCTAssertEqual(cfg.claw.nodeId, 211518)
        XCTAssertEqual(cfg.clawAppPort, 7777)
        XCTAssertEqual(cfg.socketBasename, "p.sock")
        XCTAssertTrue(cfg.dataDir.path.contains(p.id.uuidString))
    }

    func testProfileMakeConfigCarriesSharedSecret() {
        let secret = "two-daemon-test-secret-at-least-16-chars"
        let p = ClawProfile(
            name: "claw",
            address: "1:0000.0000.AAAA",
            nodeId: 1,
            sharedSecret: secret
        )
        let cfg = p.makeConfig(dataRoot: FileManager.default.temporaryDirectory)
        XCTAssertEqual(cfg.sharedSecret, secret)
    }

    func testProfileMakeConfigDefaultsToEmptySecret() {
        let p = ClawProfile(name: "claw", address: "1:0000.0000.AAAA", nodeId: 1)
        let cfg = p.makeConfig(dataRoot: FileManager.default.temporaryDirectory)
        XCTAssertEqual(cfg.sharedSecret, "")
    }

    /// Round-trip: sign on the client side, encode → decode → verify with the
    /// same secret returns true. This guards the iOS-side bind into Wire.sign;
    /// the plugin already has the matching test in TypeScript.
    func testSignedEnvelopeVerifiesEndToEnd() throws {
        let secret = "two-daemon-test-secret-at-least-16-chars"
        var env = Wire.Envelope(kind: .user, id: "id-1", ts: 1700000000, text: "hello")
        env.hmac = try Wire.sign(env, secret: secret)
        let buf = try Wire.encode(env)
        let decoded = try Wire.decode(buf)
        XCTAssertEqual(decoded.hmac, env.hmac)
        XCTAssertTrue(try Wire.verify(decoded, secret: secret))
        XCTAssertFalse(try Wire.verify(decoded, secret: "wrong-secret-at-least-16-chars"))
    }
}

final class ProfileValidationTests: XCTestCase {

    func testValidAddresses() {
        let cases = [
            "1:0000.0000.AAAA",
            "65535:FFFF.FFFF.FFFF",
            "0:abcd.ef01.2345",
            "0:0000.CAFE.BABE",
        ]
        for s in cases {
            XCTAssertTrue(ClawProfileValidation.isValidAddress(s), "\(s) should be valid")
        }
    }

    func testInvalidAddresses() {
        let cases = [
            "1.0000.0000.AAAA",     // dots not colon
            "1:0000-0000-AAAA",     // hyphens
            "1:GGGG.0000.AAAA",     // non-hex
            "1:00.00.00",           // too short
            "",
            ":0000.0000.AAAA",      // missing network
        ]
        for s in cases {
            XCTAssertFalse(ClawProfileValidation.isValidAddress(s), "\(s) should be invalid")
        }
    }

    func testValidateMessages() {
        XCTAssertNil(ClawProfileValidation.validate(name: "home", address: "1:0000.0000.AAAA", nodeId: "42"))
        XCTAssertNotNil(ClawProfileValidation.validate(name: "", address: "1:0000.0000.AAAA", nodeId: "42"))
        XCTAssertNotNil(ClawProfileValidation.validate(name: "home", address: "not-an-addr", nodeId: "42"))
        XCTAssertNotNil(ClawProfileValidation.validate(name: "home", address: "1:0000.0000.AAAA", nodeId: "not-a-num"))
    }

    func testProfileIsCodable() throws {
        let original = ClawProfile(name: "home", address: "1:0000.0000.AAAA", nodeId: 42)
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ClawProfile.self, from: encoded)
        XCTAssertEqual(original, decoded)
    }
}
