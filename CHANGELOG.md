# Changelog

All notable changes to claw-pilot. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are pre-1.0 and may break anything.

## [Unreleased]

### Changed
- Moved repository into the `pilot-protocol` org folder.
- Removed `deploy/` install scripts and `e2e/` harness — to be reintroduced once the project layout stabilises.
- Sanitised hardcoded developer paths and real Pilot addresses out of source and tests.

### Added
- Initial public README + this changelog.
- Root `.gitignore` covering Node + Xcode + SwiftPM build artefacts.

## [0.1.0] — 2026-05-21

First end-to-end working build.

### Plugin (`@openclaw/pilot`)
- `InboundPipeline`: HMAC verify → allowlist → decode → reassemble (text + media) → dispatch into agent → emit delivery ACK.
- `OutboundAdapter`: chunk + encode agent text/media, send via Pilot transport, enqueue on failure.
- `Outbox`: per-peer FIFO persistent queue, 24h TTL, cap 256, atomic writes, drain on peer proof-of-life + 30s tick.
- `DispatchStrategy`: probes `runtime.channel.reply.dispatchReplyFromConfig` → `enqueueNextTurnInjection` → log-only fallback.
- Module-level `registered` guard against duplicate plugin loads.
- Lazy import of `pilot-transport.js` so the plugin registers even when `pilotprotocol` isn't available.
- HMAC bypass mode (shared secret) for identity-drift recovery.

### iOS (`ClawChat`)
- `PilotConnection`: embedded Pilot daemon, handshakes claw, exposes `messages` / `acks` / `errors` AsyncStreams.
- `Wire.swift`: envelope encode/decode/sign/verify, multi-chunk reassembly, byte-identical cross-language compatibility with the TypeScript encoder.
- `ClawProfile` + `ProfileStore`: multi-claw model persisted to UserDefaults; per-profile data dir keeps the Pilot identity stable across launches.
- `Conversation` + `MessageStore`: chat VM with persisted history, offline send queue, attachment sidecars.
- `NotificationCoordinator`: local notifications for incoming messages while the app is backgrounded but in memory.
- UI distinguishes "sending while connected" (grey clock) from "queued while offline" (orange tray).

### Wire format v1
- JSON envelopes ≤ 1024 B per UDP datagram.
- Kinds: `user`, `agent`, `media`, `ack`, `error`.
- Media metadata only on `seq=1` to keep subsequent chunks lean.
