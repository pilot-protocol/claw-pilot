# Changelog

All notable changes to claw-pilot. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are pre-1.0 and may break anything.

## [Unreleased]

### Fixed
- **Plugin: wire a real `ReplyDispatcher` into `dispatchReplyFromConfig`.** The
  call was passing `{ ctx, cfg }` but openclaw's signature requires
  `{ ctx, cfg, dispatcher }`; the undefined dispatcher was what produced
  `TypeError: Cannot read properties of undefined (reading 'sendFinalReply')`
  the moment the agent run produced (or failed to produce) any output. With
  this fix the channel actually returns replies to the peer end-to-end. Limit:
  the embedded reply lane only routes `text` replies for now — media replies
  still rely on the channel's `OutboundAdapter` path (logged + ignored if they
  arrive via the dispatcher).
- Inbound errors from openclaw (e.g. agent auth failures) are now deliverable
  back to the peer as `error` envelopes instead of crashing the dispatch helper
  silently.

### Added
- `src/reply-dispatcher.ts` — `buildPilotReplyDispatcher`, a per-peer factory
  that turns openclaw `ReplyPayload`s into chunked `agent` wire envelopes via
  the same `chunkAgentText` + `encodeEnvelope` + outbox path the
  `OutboundAdapter` uses. Counted as `tool`/`block`/`final` for openclaw's
  `getQueuedCounts` / `getFailedCounts` contract.
- `runtime-api.ts`: `PilotRuntime.buildDispatch` now takes an
  `AccountRuntimeContext` (`{ account, transport, outbox? }`) so the dispatch
  closure can reach the live transport for outbound replies.
- 8 tests for `buildPilotReplyDispatcher` + 2 regression tests in
  `dispatch.test.ts` covering the dispatcher-wiring contract.

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
