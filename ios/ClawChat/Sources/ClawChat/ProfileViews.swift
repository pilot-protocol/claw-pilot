// SPDX-License-Identifier: AGPL-3.0-or-later

#if canImport(SwiftUI)
import SwiftUI

// ---------------------------------------------------------------------------
// Root — picks between "no profiles configured" and "chat with selected"
// ---------------------------------------------------------------------------

@MainActor
public struct ClawChatRootView: View {
    @StateObject private var store: ProfileStore
    @State private var showAddSheet = false
    @State private var showManageSheet = false

    public init(store: ProfileStore? = nil) {
        let resolved = store ?? ProfileStore()
        _store = StateObject(wrappedValue: resolved)
    }

    public var body: some View {
        Group {
            if store.profiles.isEmpty {
                EmptyProfilesView { showAddSheet = true }
            } else if let profile = store.selectedProfile {
                ChatForProfileView(
                    profile: profile,
                    dataRoot: store.dataRoot,
                    onManage: { showManageSheet = true }
                )
                // Re-mount the conversation whenever ANY identity-affecting field
                // changes — not just the profile id. Editing a profile's address
                // or nodeId after a timeout would otherwise leave the stale
                // PilotConnection in place. Secret is included because cfg is
                // captured by value into PilotConnection at init.
                .id("\(profile.id.uuidString)|\(profile.address)|\(profile.nodeId)|\(profile.appPort)|\(profile.sharedSecret.isEmpty ? "noauth" : "hmac")")
            } else {
                // Profiles exist but none selected (rare).
                EmptyProfilesView { showAddSheet = true }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            ProfileEditView(initial: nil) { profile in
                store.add(profile)
                showAddSheet = false
            } onCancel: {
                showAddSheet = false
            }
        }
        .sheet(isPresented: $showManageSheet) {
            ProfilesManageView(store: store)
        }
    }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

struct EmptyProfilesView: View {
    let onAdd: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .imageScale(.large)
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("No claws configured")
                .font(.title2.bold())
            Text("Add a claw to start chatting over the Pilot overlay.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button(action: onAdd) {
                Label("Add a claw", systemImage: "plus.circle.fill")
                    .padding(.horizontal, 8)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// ---------------------------------------------------------------------------
// Chat for a selected profile — wraps the existing ClawChatView with a
// profile-switcher header.
// ---------------------------------------------------------------------------

struct ChatForProfileView: View {
    let profile: ClawProfile
    let dataRoot: URL
    let onManage: () -> Void

    var body: some View {
        let config = profile.makeConfig(dataRoot: dataRoot)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(profile.name).font(.headline)
                    Text(profile.address)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(action: onManage) {
                    Image(systemName: "person.2.circle")
                        .imageScale(.large)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Manage claws")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.thinMaterial)
            Divider()
            ClawChatView(clawConfig: config, notificationTitle: profile.name)
        }
    }
}

// ---------------------------------------------------------------------------
// Manage sheet — list, add, edit, delete, select
// ---------------------------------------------------------------------------

struct ProfilesManageView: View {
    @ObservedObject var store: ProfileStore
    @Environment(\.dismiss) private var dismiss
    @State private var showAddSheet = false
    @State private var editing: ClawProfile?

    var body: some View {
        NavigationStack {
            List {
                Section(header: Text("Claws")) {
                    if store.profiles.isEmpty {
                        Text("No claws yet.").foregroundStyle(.secondary)
                    }
                    ForEach(store.profiles) { profile in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(profile.name).font(.headline)
                                Text(profile.address)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                Text("node id: \(profile.nodeId) · port: \(profile.appPort)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if store.selectedProfileId == profile.id {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            store.select(id: profile.id)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                store.remove(id: profile.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                editing = profile
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .tint(.blue)
                        }
                    }
                }
            }
            .navigationTitle("Claws")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showAddSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showAddSheet) {
                ProfileEditView(initial: nil) { profile in
                    store.add(profile)
                    showAddSheet = false
                } onCancel: {
                    showAddSheet = false
                }
            }
            .sheet(item: $editing) { profile in
                ProfileEditView(initial: profile) { updated in
                    store.update(updated)
                    editing = nil
                } onCancel: {
                    editing = nil
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Add / Edit form
// ---------------------------------------------------------------------------

struct ProfileEditView: View {
    let initial: ClawProfile?
    let onSave: (ClawProfile) -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var address: String
    @State private var nodeIdText: String
    @State private var appPortText: String
    @State private var trustAutoApprove: Bool
    @State private var sharedSecret: String
    @State private var validationError: String?

    init(
        initial: ClawProfile?,
        onSave: @escaping (ClawProfile) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.initial = initial
        self.onSave = onSave
        self.onCancel = onCancel
        _name = State(initialValue: initial?.name ?? "")
        _address = State(initialValue: initial?.address ?? "")
        _nodeIdText = State(initialValue: initial.map { String($0.nodeId) } ?? "")
        _appPortText = State(initialValue: String(initial?.appPort ?? 7777))
        _trustAutoApprove = State(initialValue: initial?.trustAutoApprove ?? true)
        _sharedSecret = State(initialValue: initial?.sharedSecret ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("Identity")) {
                    nameField
                    addressField
                    nodeIdField
                }
                Section(header: Text("Transport")) {
                    appPortField
                    Toggle("Auto-approve trust", isOn: $trustAutoApprove)
                }
                Section(
                    header: Text("Authorization"),
                    footer: Text("If set, messages are HMAC-signed with this secret. Match it on the claw side to allow this device without pinning its identity. Leave empty to use the claw's allowlist instead.")
                ) {
                    sharedSecretField
                }
                if let validationError {
                    Section {
                        Label(validationError, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(initial == nil ? "Add Claw" : "Edit Claw")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: attemptSave).disabled(name.isEmpty || address.isEmpty)
                }
            }
        }
    }

    // Platform-conditional field builders — textInputAutocapitalization /
    // keyboardType are iOS-only.

    @ViewBuilder
    private var nameField: some View {
        let f = TextField("Name (e.g. Home claw)", text: $name)
            .autocorrectionDisabled()
        #if os(iOS)
        f.textInputAutocapitalization(.words)
        #else
        f
        #endif
    }

    @ViewBuilder
    private var addressField: some View {
        let f = TextField("Pilot address (1:0000.0000.AAAA)", text: $address)
            .autocorrectionDisabled()
            .font(.body.monospaced())
        #if os(iOS)
        f.textInputAutocapitalization(.never)
        #else
        f
        #endif
    }

    @ViewBuilder
    private var nodeIdField: some View {
        let f = TextField("Node id (e.g. 42)", text: $nodeIdText)
        #if os(iOS)
        f.keyboardType(.numberPad)
        #else
        f
        #endif
    }

    @ViewBuilder
    private var appPortField: some View {
        let f = TextField("App port", text: $appPortText)
        #if os(iOS)
        f.keyboardType(.numberPad)
        #else
        f
        #endif
    }

    @ViewBuilder
    private var sharedSecretField: some View {
        let f = SecureField("Shared secret (optional)", text: $sharedSecret)
            .autocorrectionDisabled()
            .font(.body.monospaced())
        #if os(iOS)
        f.textInputAutocapitalization(.never)
        #else
        f
        #endif
    }

    private func attemptSave() {
        if let err = ClawProfileValidation.validate(name: name, address: address, nodeId: nodeIdText) {
            validationError = err
            return
        }
        let trimmedSecret = sharedSecret.trimmingCharacters(in: .whitespaces)
        if !trimmedSecret.isEmpty && trimmedSecret.count < 16 {
            validationError = "Shared secret must be at least 16 characters (or leave empty)"
            return
        }
        let nodeId = UInt32(nodeIdText) ?? 0
        let appPort = UInt16(appPortText) ?? 7777
        let profile = ClawProfile(
            id: initial?.id ?? UUID(),
            name: name.trimmingCharacters(in: .whitespaces),
            address: address.trimmingCharacters(in: .whitespaces),
            nodeId: nodeId,
            appPort: appPort,
            trustAutoApprove: trustAutoApprove,
            trustTimeoutMs: initial?.trustTimeoutMs ?? 30_000,
            createdAt: initial?.createdAt ?? Date(),
            sharedSecret: trimmedSecret
        )
        onSave(profile)
    }
}

#endif
