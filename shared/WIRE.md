# claw-pilot wire format v1

One JSON envelope per Pilot UDP datagram. Sender produces one or more
envelopes; receiver assembles by `id` + `(seq, total)`.

## Envelope schema

```ts
type Envelope =
  | UserMessage
  | AgentMessage
  | Ack
  | Error;

interface UserMessage {
  v: 1;
  kind: "user";
  id: string;          // unique per message; chunks share it
  ts: number;          // ms since epoch (signed 53-bit safe int)
  text: string;        // UTF-8
  seq?: number;        // 1..total, present only when chunked
  total?: number;      // 1..N
}

interface AgentMessage extends Omit<UserMessage, "kind"> {
  kind: "agent";
}

interface Ack {
  v: 1;
  kind: "ack";
  id: string;          // id of the message being acked
  ts: number;
}

interface Error {
  v: 1;
  kind: "error";
  id: string;
  ts: number;
  code: string;        // short machine-readable code
  text: string;        // human-readable detail
}
```

## Constants

- `v`: always `1` in this version
- `MAX_ENVELOPE_BYTES`: `1024`. Encoders MUST refuse to produce a larger envelope and SHOULD chunk text before that limit fires.
- Pilot UDP MTU (after framing) is ~1200 bytes; 1024 leaves headroom for the daemon's tunnel and crypto overhead.

## Chunking

When `text` doesn't fit:

1. Producer picks a fresh `id` and a `total = N` count.
2. Splits `text` into N pieces such that each `Envelope` JSON encoding is `≤ MAX_ENVELOPE_BYTES`.
3. Sends N envelopes, in any order. Each carries the same `id`, increasing `seq` (`1..N`), and the same `total`.

The receiver:

1. Buffers fragments keyed by `id`.
2. Delivers the assembled message once all `total` fragments have arrived.
3. Drops fragments whose `total` contradicts what's already buffered for that `id`.
4. Garbage-collects partial state older than 60 seconds (configurable).

For unchunked (single-envelope) messages, omit `seq` and `total` — or set `total: 1` (both forms are accepted).

## Idempotency / dedupe

Receivers MUST dedupe by `id`. The recommended LRU window is 512 ids, evicted at ~60s age.

## Encoding rules

- `JSON.stringify` defaults are fine — no special escaping.
- Numbers use base-10 integers. `ts` is milliseconds.
- Encoders MUST NOT add fields beyond those listed above (forward-compat is reserved for `v: 2`).
- Decoders MUST reject envelopes whose `v` they don't understand.

## Examples

Bytes shown as decimal UTF-8 octets.

**user, plain:**
```
{"v":1,"kind":"user","id":"abc","ts":1700000000000,"text":"hello"}
```

**user, UTF-8:**
```
{"v":1,"kind":"user","id":"utf8","ts":1700000000001,"text":"café 🦞"}
```

**agent, multi-chunk:**
```
{"v":1,"kind":"agent","id":"multi","ts":1700000000002,"text":"A","seq":1,"total":3}
{"v":1,"kind":"agent","id":"multi","ts":1700000000002,"text":"B","seq":2,"total":3}
{"v":1,"kind":"agent","id":"multi","ts":1700000000002,"text":"C","seq":3,"total":3}
```

**ack:**
```
{"v":1,"kind":"ack","id":"a-1","ts":1700000000003}
```

**error:**
```
{"v":1,"kind":"error","id":"e-1","ts":1700000000004,"code":"BAD","text":"malformed"}
```

## Cross-language conformance

Both implementations (`plugin/src/wire.ts`, `ios/ClawChat/Sources/ClawChat/Wire.swift`) ship a fixture suite that decodes the EXACT bytes the other side encodes for the examples above. See:

- `plugin/tests/wire.test.ts`
- `ios/ClawChat/Tests/ClawChatTests/CrossLanguageWireTests.swift`
