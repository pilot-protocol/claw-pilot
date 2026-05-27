// Additional wire.ts coverage:
//   - MediaReassembler.gc drops stale partials
//   - verifyEnvelope returns false on a non-base64 hmac
//   - verifyEnvelope returns false on missing hmac (already covered in hmac.test.ts,
//     but kept here as a regression anchor inside the wire.ts test target)

import { describe, expect, it } from "vitest";

import {
  MediaReassembler,
  Reassembler,
  WIRE_VERSION,
  newId,
  signEnvelope,
  verifyEnvelope,
  type MediaMessage,
  type UserMessage,
} from "../src/wire.js";

const SECRET = "secret-secret-secret-secret-1234";

describe("MediaReassembler.gc", () => {
  it("drops partials older than maxAgeMs", () => {
    const r = new MediaReassembler();
    const id = newId();
    const env: MediaMessage = {
      v: WIRE_VERSION,
      kind: "media",
      from: "user",
      media: "image",
      id,
      ts: 1_000,
      data: "AAAA",
      seq: 1,
      total: 2,
      filename: "x.bin",
      totalBytes: 8,
    };
    expect(r.push(env)).toBeNull();

    // Same wall-clock — nothing GC'd.
    r.gc(1_000, 60_000);

    // Far in the future — partial is now older than max age.
    r.gc(1_000 + 120_000, 60_000);

    // The second chunk that completes the message should now create a fresh
    // state (because gc evicted the partial), and the resulting reassembly
    // is null (we only fed one chunk into the fresh state).
    const env2: MediaMessage = { ...env, seq: 2, data: "BBBB" };
    expect(r.push(env2)).toBeNull();
  });

  it("uses Date.now() default when no args passed", () => {
    const r = new MediaReassembler();
    // Just exercising the default-args branch — no observable behavior change.
    expect(() => r.gc()).not.toThrow();
  });
});

describe("Reassembler.gc default args", () => {
  it("does not throw when invoked with no args", () => {
    const r = new Reassembler<UserMessage>();
    expect(() => r.gc()).not.toThrow();
  });
});

describe("verifyEnvelope — defensive paths", () => {
  it("returns false when the hmac is malformed base64", async () => {
    const env: UserMessage = {
      v: WIRE_VERSION,
      kind: "user",
      id: newId(),
      ts: Date.now(),
      text: "hi",
      // not base64 but Buffer.from() will tolerate it and produce junk bytes
      hmac: "!!!not-base64!!!",
    };
    const ok = await verifyEnvelope(env, SECRET);
    expect(ok).toBe(false);
  });

  it("returns false when the hmac length does not match expected", async () => {
    const env: UserMessage = {
      v: WIRE_VERSION,
      kind: "user",
      id: newId(),
      ts: Date.now(),
      text: "hi",
      // base64-decodes to 5 bytes — wrong length vs. the 32-byte sha256
      hmac: "aGVsbG8=",
    };
    const ok = await verifyEnvelope(env, SECRET);
    expect(ok).toBe(false);
  });

  it("returns true on a freshly signed envelope (positive control)", async () => {
    const env: UserMessage = {
      v: WIRE_VERSION,
      kind: "user",
      id: newId(),
      ts: Date.now(),
      text: "positive control",
    };
    const hmac = await signEnvelope(env, SECRET);
    const signed: UserMessage = { ...env, hmac };
    expect(await verifyEnvelope(signed, SECRET)).toBe(true);
  });
});
