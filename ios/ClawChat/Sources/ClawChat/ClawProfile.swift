// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ClawProfile is one configured claw the app knows how to talk to. The user
// can have many — each has its own Pilot identity address, node id, and
// app-layer port, and its own pinned conversation in the chat UI.

import Foundation

public struct ClawProfile: Identifiable, Codable, Equatable, Sendable {
    public let id: UUID
    public var name: String
    public var address: String   // pilot text address, e.g. "1:0000.0000.AAAA"
    public var nodeId: UInt32
    public var appPort: UInt16
    public var trustAutoApprove: Bool
    public var trustTimeoutMs: UInt32
    public var createdAt: Date
    /// Optional shared secret — if set, messages from this app carry an HMAC
    /// that the claw plugin verifies. With a secret set, the claw doesn't need
    /// the iOS device's pilot address in its allowlist; any device with the
    /// secret is authorized. Default empty = identity-pinned (allowlist) mode.
    public var sharedSecret: String

    public init(
        id: UUID = UUID(),
        name: String,
        address: String,
        nodeId: UInt32,
        appPort: UInt16 = 7777,
        trustAutoApprove: Bool = true,
        trustTimeoutMs: UInt32 = 30_000,
        createdAt: Date = Date(),
        sharedSecret: String = ""
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.nodeId = nodeId
        self.appPort = appPort
        self.trustAutoApprove = trustAutoApprove
        self.trustTimeoutMs = trustTimeoutMs
        self.createdAt = createdAt
        self.sharedSecret = sharedSecret
    }

    /// Convert to the SDK-level PilotConnection.Config. Each profile gets its
    /// own dataDir + socketBasename so identities don't clash if the user
    /// adds multiple claws (the embedded Pilot daemon is process-global so
    /// only ONE can be active at a time — but disk state stays separate).
    public func makeConfig(dataRoot: URL) -> PilotConnection.Config {
        let dir = dataRoot.appendingPathComponent("profiles/\(id.uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return PilotConnection.Config(
            dataDir: dir,
            socketBasename: "p.sock",
            claw: ClawAddress(address: address, nodeId: nodeId),
            clawAppPort: appPort,
            trustTimeoutMs: trustTimeoutMs,
            trustAutoApprove: trustAutoApprove,
            sharedSecret: sharedSecret
        )
    }
}

public enum ClawProfileValidation {
    /// Pilot addresses look like `N:NNNN.HHHH.LLLL` (network:high.mid.low).
    public static let pilotAddressRegex = try! NSRegularExpression(
        pattern: #"^[0-9]+:[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$"#
    )

    public static func isValidAddress(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..., in: s)
        return pilotAddressRegex.firstMatch(in: s, range: range) != nil
    }

    public static func validate(name: String, address: String, nodeId: String) -> String? {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        if trimmedName.isEmpty { return "Name can't be empty" }
        if !isValidAddress(address) {
            return "Address must look like 1:0000.0000.AAAA"
        }
        if UInt32(nodeId) == nil { return "Node id must be a positive integer" }
        return nil
    }
}
