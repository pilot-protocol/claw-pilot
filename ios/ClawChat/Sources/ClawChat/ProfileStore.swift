// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ProfileStore — list of claws the user has configured. Persists to
// UserDefaults under a single JSON-encoded key. Observable so SwiftUI can
// drive the UI off it.

import Foundation
#if canImport(Combine)
import Combine
#endif

@MainActor
public final class ProfileStore: ObservableObject {

    public static let defaultsKey = "io.vulturelabs.clawchat.profiles.v1"

    @Published public private(set) var profiles: [ClawProfile] = []
    @Published public var selectedProfileId: UUID?

    /// Where each profile's Pilot data dir lives. Defaults to Application Support.
    public let dataRoot: URL

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard, dataRoot: URL? = nil) {
        self.defaults = defaults
        if let dataRoot {
            self.dataRoot = dataRoot
        } else {
            self.dataRoot = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory)
                .appendingPathComponent("claw-pilot")
        }
        try? FileManager.default.createDirectory(at: self.dataRoot, withIntermediateDirectories: true)
        load()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = defaults.data(forKey: Self.defaultsKey) else { return }
        let dec = JSONDecoder()
        if let stored = try? dec.decode(StoredFormat.self, from: data) {
            self.profiles = stored.profiles
            self.selectedProfileId = stored.selectedId ?? stored.profiles.first?.id
        }
    }

    private func save() {
        let stored = StoredFormat(profiles: profiles, selectedId: selectedProfileId)
        if let data = try? JSONEncoder().encode(stored) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }

    // MARK: - Mutations

    @discardableResult
    public func add(_ profile: ClawProfile) -> ClawProfile {
        profiles.append(profile)
        if selectedProfileId == nil { selectedProfileId = profile.id }
        save()
        return profile
    }

    public func update(_ profile: ClawProfile) {
        guard let idx = profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        profiles[idx] = profile
        save()
    }

    public func remove(id: UUID) {
        profiles.removeAll { $0.id == id }
        if selectedProfileId == id {
            selectedProfileId = profiles.first?.id
        }
        save()
    }

    public func select(id: UUID) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        selectedProfileId = id
        save()
    }

    public var selectedProfile: ClawProfile? {
        guard let id = selectedProfileId else { return nil }
        return profiles.first(where: { $0.id == id })
    }

    // MARK: - Storage shape

    private struct StoredFormat: Codable {
        var profiles: [ClawProfile]
        var selectedId: UUID?
    }
}
