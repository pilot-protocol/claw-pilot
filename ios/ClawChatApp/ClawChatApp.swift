// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App entry. The root view is multi-profile aware: shows the profile manager
// when no claw is configured, otherwise routes to the chat for the selected
// claw. Profiles are persisted to UserDefaults so they survive app restarts.

#if canImport(SwiftUI)
import Foundation
import SwiftUI
import ClawChat

@main
public struct ClawChatApp: App {

    public init() {}

    public var body: some Scene {
        WindowGroup {
            ClawChatRootView()
        }
    }
}
#endif
