// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Render a chat message's text the way the user expects:
//   - Markdown (bold, italic, code spans, links) parsed inline.
//   - Pilot addresses (N:NNNN.HHHH.LLLL) recognised, styled monospaced
//     in the accent color, and made tappable via a `clawchat://peer/...`
//     custom URL that the host view handles.
//
// Returns an AttributedString so SwiftUI's Text can render the whole thing
// natively — no NSAttributedString conversion, no AttributedTextView wrapper.

import Foundation
#if canImport(SwiftUI)
import SwiftUI

/// Regex for Pilot addresses — same shape we validate elsewhere
/// (`N:NNNN.HHHH.LLLL`, optional `:port` suffix). Anchored to word
/// boundaries so addresses embedded in prose ("at 0:0000.0003.3B23 please")
/// still match without grabbing surrounding punctuation.
private let pilotAddressRegex: NSRegularExpression = {
    // swiftlint:disable:next force_try
    try! NSRegularExpression(
        pattern: #"\b\d+:[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}(?::\d+)?\b"#,
        options: [],
    )
}()

/// Custom URL scheme the host view subscribes to via `.environment(\.openURL, ...)`.
/// Tapping a pilot-address pill resolves to `clawchat://peer/<addr>`; the host
/// decides what to do (copy to clipboard, navigate to a peer detail view,
/// fire a "Test ping" send, etc.).
public enum ChatLinkScheme {
    public static let scheme = "clawchat"
    public static let peerHost = "peer"

    public static func peerURL(for address: String) -> URL? {
        URL(string: "\(scheme)://\(peerHost)/\(address)")
    }

    /// Extract the pilot address from a `clawchat://peer/<addr>` URL.
    /// Returns nil for any other URL shape — the host's openURL handler
    /// can pass everything else through to the system.
    public static func peerAddress(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == peerHost else { return nil }
        let path = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        return path.isEmpty ? nil : path
    }
}

/// Render `text` as an AttributedString with markdown + pilot-address styling.
/// Falls back to the literal string if markdown parsing fails — the user
/// always sees their text, even if our renderer doesn't.
public func renderChatText(_ text: String) -> AttributedString {
    // 1. Parse markdown. `.inlineOnlyPreservingWhitespace` is the sweet spot
    //    for chat: bold/italic/code/links/strikethrough work, multi-line
    //    block elements don't get mangled. Plain string fallback ensures the
    //    user sees their text on any parse failure.
    var attributed: AttributedString = {
        let opts = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
        )
        if let parsed = try? AttributedString(markdown: text, options: opts) {
            return parsed
        }
        return AttributedString(text)
    }()

    // 2. Find Pilot addresses in the *rendered* text and overlay link +
    //    monospace + accent styling. Iterating on the rendered text means
    //    addresses that survived markdown (most do — they have no markdown-
    //    special characters) get found regardless of where they sit.
    overlayPilotAddressStyling(in: &attributed)

    return attributed
}

private func overlayPilotAddressStyling(in attributed: inout AttributedString) {
    let plain = String(attributed.characters)
    let nsText = plain as NSString
    let range = NSRange(location: 0, length: nsText.length)
    let matches = pilotAddressRegex.matches(in: plain, options: [], range: range)
    // Walk matches end-to-start so we can use NSRange→AttributedString.Index
    // mapping without invalidation issues from prior edits.
    for m in matches.reversed() {
        let nsRange = m.range
        guard let attrRange = Range(nsRange, in: attributed) else { continue }
        let addrText = nsText.substring(with: nsRange)
        attributed[attrRange].font = .system(.body, design: .monospaced)
        attributed[attrRange].foregroundColor = .accentColor
        attributed[attrRange].underlineStyle = .single
        if let url = ChatLinkScheme.peerURL(for: addrText) {
            attributed[attrRange].link = url
        }
    }
}

#endif
