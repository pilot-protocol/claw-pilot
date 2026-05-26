// SPDX-License-Identifier: AGPL-3.0-or-later

import Foundation
import XCTest
@testable import ClawChat

#if canImport(SwiftUI)

final class MessageTextTests: XCTestCase {

    // The rendered text must equal the input as plain characters — markdown
    // parsing only adds attributes, never alters the surface text. Regression
    // for "I sent X but the bubble shows Y."
    func testPlainTextRendersUnchanged() {
        let rendered = renderChatText("hello world")
        XCTAssertEqual(String(rendered.characters), "hello world")
    }

    // Markdown emphasis removes the asterisks from the surface text — that's
    // the whole point of inline parsing. The styling lives in the attribute
    // runs (tested visually).
    func testMarkdownEmphasisStripsSyntaxFromSurfaceText() {
        let rendered = renderChatText("hello **world**")
        // "hello world" (no asterisks); attributes carry the bold.
        XCTAssertEqual(String(rendered.characters), "hello world")
    }

    // Code spans render with their backticks consumed; the agent's typical
    // "see `0:0000.0003.3B23`" wraps the address in backticks, and we want
    // the addr text inside to still match for the pilot-address overlay
    // (next test).
    func testInlineCodeSpansAreParsed() {
        let rendered = renderChatText("see `addr` for details")
        XCTAssertEqual(String(rendered.characters), "see addr for details")
    }

    // Pilot addresses appear in the rendered text exactly as written (no
    // mangling) AND carry a `clawchat://peer/<addr>` link attribute so the
    // host can intercept the tap.
    func testPilotAddressGetsCustomPeerLink() {
        let rendered = renderChatText("ping 0:0000.0003.3B23 now")
        let plain = String(rendered.characters)
        XCTAssertEqual(plain, "ping 0:0000.0003.3B23 now")

        // Locate the address range in the rendered string and check its link.
        let needle = "0:0000.0003.3B23"
        guard let nsRange = (plain as NSString).range(of: needle) as NSRange?,
              let attrRange = Range(nsRange, in: rendered) else {
            return XCTFail("address substring not found in rendered text")
        }
        let link = rendered[attrRange].link
        XCTAssertNotNil(link)
        XCTAssertEqual(link?.scheme, "clawchat")
        XCTAssertEqual(link?.host, "peer")
        XCTAssertEqual(link?.path, "/\(needle)")
    }

    // Edge: address right at the start, right at the end, and surrounded by
    // punctuation must all still match.
    func testPilotAddressBoundaries() {
        let inputs = [
            "0:0000.0003.3B23 is the phone",
            "the phone is 0:0000.0003.3B23",
            "(see 0:0000.0003.3B23).",
        ]
        for input in inputs {
            let rendered = renderChatText(input)
            let plain = String(rendered.characters)
            let range = (plain as NSString).range(of: "0:0000.0003.3B23")
            XCTAssertNotEqual(range.location, NSNotFound, "should find addr in: \(input)")
            guard let attrRange = Range(range, in: rendered) else { continue }
            XCTAssertNotNil(rendered[attrRange].link, "should have link in: \(input)")
        }
    }

    // Multiple addresses in one message must each get their own link.
    func testMultiplePilotAddressesAllStyled() {
        let rendered = renderChatText("forwarding from 0:0000.0003.3B23 to 0:0000.0002.74EE")
        let plain = String(rendered.characters)
        for addr in ["0:0000.0003.3B23", "0:0000.0002.74EE"] {
            let range = (plain as NSString).range(of: addr)
            XCTAssertNotEqual(range.location, NSNotFound)
            guard let attrRange = Range(range, in: rendered) else {
                return XCTFail("range not mappable for \(addr)")
            }
            XCTAssertEqual(rendered[attrRange].link?.path, "/\(addr)")
        }
    }

    // Non-address numeric tokens like timestamps or counts must NOT get
    // pilot-link styling. Anchored regex with `\b` covers this; the test
    // pins the invariant.
    func testNumericNoiseIsNotMistakenForAnAddress() {
        let rendered = renderChatText("queued 42 messages over 3600 seconds")
        // Nothing has a `clawchat://peer/...` link.
        for run in rendered.runs {
            if let link = run.link {
                XCTAssertNotEqual(link.scheme, "clawchat", "false-positive: \(link)")
            }
        }
    }

    // Markdown links are preserved as their own URL — they must NOT get
    // overridden by our pilot-address pass.
    func testMarkdownLinksSurviveTheAddressOverlay() {
        let rendered = renderChatText("see [docs](https://pilotprotocol.network/docs)")
        var foundMarkdownLink = false
        for run in rendered.runs {
            if run.link?.scheme == "https" {
                foundMarkdownLink = true
            }
        }
        XCTAssertTrue(foundMarkdownLink, "markdown link must be preserved")
    }
}

// MARK: - ChatLinkScheme

final class ChatLinkSchemeTests: XCTestCase {

    func testPeerURLRoundTrip() {
        let addr = "0:0000.0003.3B23"
        guard let url = ChatLinkScheme.peerURL(for: addr) else {
            return XCTFail("peerURL returned nil for valid addr")
        }
        XCTAssertEqual(url.scheme, "clawchat")
        XCTAssertEqual(url.host, "peer")
        XCTAssertEqual(ChatLinkScheme.peerAddress(from: url), addr)
    }

    func testPeerAddressIgnoresUnrelatedURLs() {
        let other = URL(string: "https://pilotprotocol.network/docs")!
        XCTAssertNil(ChatLinkScheme.peerAddress(from: other))
    }

    func testPeerAddressIgnoresWrongHost() {
        let bad = URL(string: "clawchat://something/0:0000.0003.3B23")!
        XCTAssertNil(ChatLinkScheme.peerAddress(from: bad))
    }
}

#endif
