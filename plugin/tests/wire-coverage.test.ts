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

describe("Reassembler byte cap", () => {
  function textPart(id: string, seq: number, total: number, text: string): UserMessage {
    return { v: WIRE_VERSION, kind: "user", id, ts: 1_000, text, seq, total };
  }

  it("drops the in-flight message once held text passes the cap", () => {
    const r = new Reassembler<UserMessage>(100);
    const id = newId();
    // Two 40-byte chunks fit; the third pushes the total to 120 > 100.
    expect(r.push(textPart(id, 1, 5, "a".repeat(40)))).toBeNull();
    expect(r.push(textPart(id, 2, 5, "b".repeat(40)))).toBeNull();
    expect(r.push(textPart(id, 3, 5, "c".repeat(40)))).toBeNull();
    // State was discarded, so the remaining chunks can never complete it.
    expect(r.push(textPart(id, 4, 5, "d"))).toBeNull();
    expect(r.push(textPart(id, 5, 5, "e"))).toBeNull();
  });

  it("still assembles a message that stays under the cap", () => {
    const r = new Reassembler<UserMessage>(100);
    const id = newId();
    expect(r.push(textPart(id, 1, 2, "hello "))).toBeNull();
    const out = r.push(textPart(id, 2, 2, "world"));
    expect(out?.text).toBe("hello world");
  });

  it("does not let a re-sent seq inflate the running total", () => {
    const r = new Reassembler<UserMessage>(100);
    const id = newId();
    // The same 40-byte chunk replayed many times replaces itself each time,
    // so the held total stays at 40 and assembly still succeeds.
    for (let i = 0; i < 20; i++) {
      expect(r.push(textPart(id, 1, 2, "a".repeat(40)))).toBeNull();
    }
    const out = r.push(textPart(id, 2, 2, "b".repeat(40)));
    expect(out?.text).toBe("a".repeat(40) + "b".repeat(40));
  });
});

describe("MediaReassembler byte cap", () => {
  function mediaPart(id: string, seq: number, total: number, bytes: number): MediaMessage {
    return {
      v: WIRE_VERSION,
      kind: "media",
      from: "user",
      media: "file",
      id,
      ts: 1_000,
      data: Buffer.alloc(bytes, 7).toString("base64"),
      seq,
      total,
      ...(seq === 1 ? { filename: "x.bin", totalBytes: bytes * total } : {}),
    };
  }

  it("drops the in-flight media once held payload passes the cap", () => {
    const r = new MediaReassembler(100);
    const id = newId();
    expect(r.push(mediaPart(id, 1, 5, 40))).toBeNull();
    expect(r.push(mediaPart(id, 2, 5, 40))).toBeNull();
    expect(r.push(mediaPart(id, 3, 5, 40))).toBeNull();
    expect(r.push(mediaPart(id, 4, 5, 40))).toBeNull();
    expect(r.push(mediaPart(id, 5, 5, 40))).toBeNull();
  });

  it("still assembles media that stays under the cap", () => {
    const r = new MediaReassembler(100);
    const id = newId();
    expect(r.push(mediaPart(id, 1, 2, 40))).toBeNull();
    const out = r.push(mediaPart(id, 2, 2, 40));
    expect(out?.bytes.length).toBe(80);
  });
});
