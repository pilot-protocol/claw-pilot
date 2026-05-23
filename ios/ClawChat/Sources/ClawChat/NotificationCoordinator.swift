// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NotificationCoordinator — request authorization once, then post local
// notifications for incoming claw messages when the app is backgrounded.
//
// Why local (not push): we don't have an APNs sender side yet. The Pilot
// daemon embedded in the iOS app runs while the app is foreground/active
// (and briefly while backgrounded, depending on iOS scheduler). When a
// message arrives during that window and the user isn't actively looking,
// a UNUserNotificationCenter local notification surfaces it. For full
// "phone is asleep, claw still reaches you" we'd need APNs — separate
// workstream needing an Apple cert + a server-side sender.

import Foundation

#if canImport(UserNotifications)
import UserNotifications
#endif

#if canImport(UIKit)
import UIKit
#endif

public final class NotificationCoordinator: @unchecked Sendable {

    public static let shared = NotificationCoordinator()

    private init() {}

    /// True once the user has been prompted (we don't re-prompt regardless of
    /// their answer — iOS only honors the first request anyway).
    private var didRequest = false

    /// Ask the OS for permission to show notifications. Safe to call multiple
    /// times; only the first request shows the prompt.
    public func requestAuthorizationIfNeeded() {
        #if canImport(UserNotifications)
        guard !didRequest else { return }
        didRequest = true
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { _, _ in
            // Result is opaque from our side. iOS persists the decision.
        }
        #endif
    }

    /// Post a local notification for a claw → me message. No-ops if the app
    /// is foreground+active (the chat UI is already showing it).
    /// `title` is typically the profile name, `body` is the message preview.
    public func postIncoming(title: String, body: String, threadId: String? = nil) {
        #if canImport(UserNotifications)
        guard appIsBackgroundedOrInactive() else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = previewClamp(body)
        content.sound = .default
        if let threadId { content.threadIdentifier = threadId }
        let req = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil // deliver immediately
        )
        UNUserNotificationCenter.current().add(req) { _ in }
        #endif
    }

    /// True when the SwiftUI scene is backgrounded or the app is inactive.
    /// On non-UIKit platforms (macOS unit tests) returns false so we don't
    /// post notifications during tests.
    private func appIsBackgroundedOrInactive() -> Bool {
        #if canImport(UIKit)
        // App state must be read on main; we tolerate a stale read on bg
        // threads — worst case we suppress a notification when we shouldn't,
        // never the reverse.
        let state = MainActor.assumeIsolated { UIApplication.shared.applicationState }
        return state != .active
        #else
        return false
        #endif
    }

    /// Notifications display poorly with very long bodies. Cap to 200 chars
    /// and add an ellipsis — iOS truncates further itself. Internal (not
    /// private) so unit tests can exercise the clamp without needing the
    /// UserNotifications framework to be present.
    internal func previewClamp(_ s: String) -> String {
        if s.count <= 200 { return s }
        return s.prefix(199) + "…"
    }
}
