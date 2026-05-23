# claw-pilot

> **Status: WIP.** APIs, wire format, and project layout are still moving. Don't depend on this for anything you'd be sad to lose.

Direct peer-to-peer messaging between a mobile app and your OpenClaw agent, over the [Pilot Protocol](https://pilotprotocol.network) overlay.

No Telegram. No webhook broker. No third-party server in the middle. Your phone and your claw discover each other on the overlay, handshake, and exchange end-to-end encrypted datagrams.

## What's in here

| | |
|---|---|
| `plugin/` | `@openclaw/pilot` — OpenClaw channel plugin (Node/TypeScript). Receives Pilot datagrams, allowlists by sender, reassembles chunked text + media, dispatches into the agent's reply pipeline, sends agent replies back. |
| `ios/`    | `ClawChat` — SwiftUI app + Swift package. Embeds the Pilot daemon via the Swift SDK, handshakes the claw, sends/receives text and media with per-message delivery state. |
| `shared/` | `WIRE.md` — canonical wire format spec, shared by both halves. |

## How it works

```
┌─────────────────┐         Pilot overlay          ┌──────────────────┐
│  ClawChat (iOS) │  ───  E2E-encrypted UDP  ───  │  OpenClaw + claw │
│  embedded daemon│                                │  pilot plugin    │
└─────────────────┘                                └──────────────────┘
```

1. Both sides run a Pilot daemon and get a 48-bit overlay address (`N:NNNN.HHHH.LLLL`).
2. The phone allowlists the claw's address (and vice versa).
3. Messages are JSON envelopes (≤1024 B per UDP datagram), chunked + reassembled by `(id, seq, total)`. See `shared/WIRE.md`.
4. The plugin emits an `ack` envelope after successful delivery; either side can emit `error` envelopes to mark a message failed.

## Building

**Plugin** (requires Node ≥ 22):

```sh
cd plugin
npm install
npm run build
npm test
```

The plugin depends on `pilotprotocol` (Node SDK from the [web4](https://github.com/TeoSlayer/web4) repo) and `openclaw`. Both are expected to be resolvable in your environment — wiring this up cleanly is part of the WIP.

**iOS app** (requires Xcode 16+):

```sh
cd ios
make project   # regenerate the xcodegen project
open ClawChat.xcworkspace
```

The Swift package depends on `web4/sdk/swift`, which embeds `libpilot`.

## Wire format (v1)

```
user / agent:  { v:1, kind, id, ts, text, seq?, total? }
media:         { v:1, kind:"media", from, media, id, ts, data, seq, total,
                 filename?, mime?, totalBytes?, caption? }
ack:           { v:1, kind:"ack", id, ts }
error:         { v:1, kind:"error", id, ts, code, text }
```

Full spec in `shared/WIRE.md`.

## What works today

- Text + media (files, images, audio) round-trip between iOS and the plugin
- Multi-chunk reassembly with id-based dedup
- Per-peer persistent outbox in the plugin (retry on transport failure, drain on peer proof-of-life)
- Per-profile chat history on iOS, persisted to UserDefaults + sidecar attachments
- HMAC-signed envelopes (optional shared secret) for identity-drift recovery
- Local notifications on iOS when the app is backgrounded but in memory

## What doesn't (yet)

- True background wake on iOS — needs APNs sender service + push cert
- Stable claw `node_id` across registry handoffs — requires a `-fixed-node-id` flag in the daemon
- Polished install / config UX — currently very developer-y

## License

AGPL-3.0-or-later. See individual `package.json` / `Package.swift` for per-component licensing.
