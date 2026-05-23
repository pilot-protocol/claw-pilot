import { describe, expect, it } from "vitest";

import {
  MAX_ENVELOPE_BYTES,
  MediaReassembler,
  WIRE_VERSION,
  chunkMedia,
  decodeEnvelope,
  encodeEnvelope,
  type MediaMessage,
} from "../src/wire.js";

function randomBytes(n: number, seed = 1): Buffer {
  // Deterministic xorshift32 — keep tests reproducible without crypto deps.
  let state = seed >>> 0;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

describe("chunkMedia", () => {
  it("emits a single envelope for tiny payload", () => {
    const parts = chunkMedia({
      from: "user",
      media: "image",
      bytes: Buffer.from([1, 2, 3, 4]),
      filename: "tiny.bin",
      mime: "application/octet-stream",
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.seq).toBe(1);
    expect(parts[0]!.total).toBe(1);
    expect(parts[0]!.filename).toBe("tiny.bin");
    expect(parts[0]!.totalBytes).toBe(4);
  });

  it("each envelope fits MAX_ENVELOPE_BYTES", () => {
    const bytes = randomBytes(12_000);
    const parts = chunkMedia({
      from: "user",
      media: "image",
      bytes,
      filename: "cat.jpg",
      mime: "image/jpeg",
      caption: "look at this cat",
    });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(encodeEnvelope(p).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    }
  });

  it("metadata only on first chunk", () => {
    const parts = chunkMedia({
      from: "user",
      media: "image",
      bytes: randomBytes(5_000),
      filename: "a.png",
      mime: "image/png",
      caption: "x",
    });
    expect(parts[0]!.filename).toBe("a.png");
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.filename).toBeUndefined();
      expect(parts[i]!.mime).toBeUndefined();
      expect(parts[i]!.caption).toBeUndefined();
      expect(parts[i]!.totalBytes).toBeUndefined();
    }
  });

  it("all chunks share the same id, increasing seq, same total", () => {
    const parts = chunkMedia({
      from: "agent",
      media: "file",
      bytes: randomBytes(8_000),
    });
    const ids = new Set(parts.map((p) => p.id));
    expect(ids.size).toBe(1);
    parts.forEach((p, i) => {
      expect(p.seq).toBe(i + 1);
      expect(p.total).toBe(parts.length);
    });
  });
});

describe("MediaReassembler", () => {
  it("reassembles a small payload", () => {
    const r = new MediaReassembler();
    const src = Buffer.from("hello world", "utf8");
    const parts = chunkMedia({
      from: "user",
      media: "file",
      bytes: src,
      filename: "hi.txt",
      mime: "text/plain",
    });
    let out = null;
    for (const p of parts) {
      const result = r.push(p);
      if (result) out = result;
    }
    expect(out).not.toBeNull();
    expect(out!.bytes.toString("utf8")).toBe("hello world");
    expect(out!.filename).toBe("hi.txt");
    expect(out!.mime).toBe("text/plain");
    expect(out!.from).toBe("user");
    expect(out!.media).toBe("file");
  });

  it("reassembles a multi-chunk binary blob byte-for-byte", () => {
    const r = new MediaReassembler();
    const src = randomBytes(20_000, 42);
    const parts = chunkMedia({
      from: "agent",
      media: "image",
      bytes: src,
      filename: "shot.png",
      mime: "image/png",
    });
    expect(parts.length).toBeGreaterThan(20);

    let out = null;
    for (const p of parts) {
      out = r.push(p) ?? out;
    }
    expect(out).not.toBeNull();
    expect(out!.bytes.equals(src)).toBe(true);
  });

  it("reassembles out-of-order chunks", () => {
    const r = new MediaReassembler();
    const src = randomBytes(5_000, 7);
    const parts = chunkMedia({
      from: "user",
      media: "file",
      bytes: src,
      filename: "blob.bin",
    });
    // Shuffle deterministically — reverse order
    const shuffled = [...parts].reverse();
    let out = null;
    for (const p of shuffled) {
      out = r.push(p) ?? out;
    }
    expect(out).not.toBeNull();
    expect(out!.bytes.equals(src)).toBe(true);
    expect(out!.filename).toBe("blob.bin");
  });

  it("returns null when totalBytes mismatch (tamper detection)", () => {
    const r = new MediaReassembler();
    const parts = chunkMedia({
      from: "user",
      media: "file",
      bytes: Buffer.from("abcdefghij"),
      filename: "x.bin",
    });
    // Corrupt the second-to-last chunk: replace its data with empty base64
    const tampered = [...parts];
    if (tampered.length > 1) {
      tampered[1] = { ...tampered[1]!, data: "" };
    } else {
      // Force multi-chunk
      const big = chunkMedia({
        from: "user",
        media: "file",
        bytes: randomBytes(2_000),
        filename: "big.bin",
      });
      tampered.length = 0;
      tampered.push(...big);
      tampered[1] = { ...tampered[1]!, data: "" };
    }
    let out = null;
    for (const p of tampered) {
      out = r.push(p) ?? out;
    }
    expect(out).toBeNull();
  });

  it("ignores contradictory total fields", () => {
    const r = new MediaReassembler();
    const env1: MediaMessage = {
      v: WIRE_VERSION,
      kind: "media",
      from: "user",
      media: "file",
      id: "x",
      ts: 1,
      data: "AA==",
      seq: 1,
      total: 2,
      filename: "a",
      totalBytes: 2,
    };
    const env2bad: MediaMessage = {
      v: WIRE_VERSION,
      kind: "media",
      from: "user",
      media: "file",
      id: "x",
      ts: 1,
      data: "AA==",
      seq: 2,
      total: 3, // mismatch
    };
    expect(r.push(env1)).toBeNull();
    expect(r.push(env2bad)).toBeNull();
  });
});

describe("media envelope wire schema", () => {
  it("decode accepts a valid media envelope", () => {
    const env: MediaMessage = {
      v: WIRE_VERSION,
      kind: "media",
      from: "user",
      media: "image",
      id: "abc",
      ts: 1,
      data: "aGVsbG8=",
      seq: 1,
      total: 1,
      filename: "a.png",
      mime: "image/png",
      totalBytes: 5,
    };
    const buf = encodeEnvelope(env);
    const back = decodeEnvelope(buf);
    expect(back.kind).toBe("media");
    if (back.kind === "media") {
      expect(back.data).toBe("aGVsbG8=");
      expect(back.from).toBe("user");
      expect(back.media).toBe("image");
    }
  });

  it("decode rejects media envelope missing required fields", () => {
    const bad = Buffer.from(
      JSON.stringify({
        v: WIRE_VERSION,
        kind: "media",
        id: "x",
        ts: 1,
        data: "AAA=",
        // missing from / media / seq / total
      }),
    );
    expect(() => decodeEnvelope(bad)).toThrow(/schema/);
  });
});
