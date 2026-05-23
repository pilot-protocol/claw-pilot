import { describe, expect, it } from "vitest";

import {
  MAX_ENVELOPE_BYTES,
  Reassembler,
  WIRE_VERSION,
  chunkAgentText,
  chunkUserText,
  decodeEnvelope,
  encodeEnvelope,
  newId,
  type AgentMessage,
  type UserMessage,
} from "../src/wire.js";

describe("wire envelope", () => {
  it("round-trips a short user message", () => {
    const env: UserMessage = {
      v: WIRE_VERSION,
      kind: "user",
      id: "abc",
      ts: 1_700_000_000_000,
      text: "hello claw",
    };
    const buf = encodeEnvelope(env);
    expect(buf.length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    const decoded = decodeEnvelope(buf);
    expect(decoded).toEqual(env);
  });

  it("rejects encoding payloads above MAX_ENVELOPE_BYTES", () => {
    const env: UserMessage = {
      v: WIRE_VERSION,
      kind: "user",
      id: "x",
      ts: 1,
      text: "a".repeat(MAX_ENVELOPE_BYTES + 1),
    };
    expect(() => encodeEnvelope(env)).toThrow(/exceeds/);
  });

  it("rejects unknown wire version", () => {
    const bad = Buffer.from(
      JSON.stringify({ v: 99, kind: "user", id: "x", ts: 1, text: "hi" }),
    );
    expect(() => decodeEnvelope(bad)).toThrow(/schema/);
  });

  it("rejects mistyped envelope", () => {
    const bad = Buffer.from(JSON.stringify({ v: WIRE_VERSION, kind: "user", id: "" }));
    expect(() => decodeEnvelope(bad)).toThrow(/schema/);
  });

  it("rejects non-JSON", () => {
    expect(() => decodeEnvelope(Buffer.from("not json"))).toThrow(/not JSON/);
  });

  it("newId is unique-enough and length-stable", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newId());
    expect(ids.size).toBe(1000);
  });
});

describe("chunkUserText / chunkAgentText", () => {
  it("returns a single envelope for short text", () => {
    const parts = chunkUserText("ping");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.total).toBeUndefined();
  });

  it("splits a long text into multiple chunks that each fit", () => {
    const text = "x".repeat(5_000);
    const parts = chunkUserText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const enc = encodeEnvelope(p);
      expect(enc.length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
      expect(p.total).toBe(parts.length);
    }
  });

  it("all chunks share the same id and sum to the original text", () => {
    const text = "Hello clawful world. ".repeat(150);
    const parts = chunkUserText(text);
    const ids = new Set(parts.map((p) => p.id));
    expect(ids.size).toBe(1);
    const joined = parts.map((p) => p.text).join("");
    expect(joined).toBe(text);
  });

  it("handles UTF-8 multi-byte chars correctly", () => {
    const text = "🦞".repeat(500) + "café";
    const parts = chunkUserText(text);
    for (const p of parts) {
      expect(encodeEnvelope(p).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    }
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });
});

describe("Reassembler", () => {
  it("returns single-chunk messages immediately", () => {
    const r = new Reassembler<UserMessage>();
    const env: UserMessage = {
      v: WIRE_VERSION,
      kind: "user",
      id: "single",
      ts: 1,
      text: "hi",
    };
    expect(r.push(env)).toEqual(env);
  });

  it("reassembles in-order chunks", () => {
    const r = new Reassembler<UserMessage>();
    const id = "abc";
    const parts: UserMessage[] = [
      { v: WIRE_VERSION, kind: "user", id, ts: 1, text: "Hello ", seq: 1, total: 3 },
      { v: WIRE_VERSION, kind: "user", id, ts: 1, text: "claw", seq: 2, total: 3 },
      { v: WIRE_VERSION, kind: "user", id, ts: 1, text: "ful world", seq: 3, total: 3 },
    ];
    expect(r.push(parts[0]!)).toBeNull();
    expect(r.push(parts[1]!)).toBeNull();
    const out = r.push(parts[2]!);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("Hello clawful world");
    expect(out!.seq).toBeUndefined();
    expect(out!.total).toBeUndefined();
  });

  it("reassembles out-of-order chunks", () => {
    const r = new Reassembler<UserMessage>();
    const id = "z";
    expect(r.push({ v: WIRE_VERSION, kind: "user", id, ts: 1, text: "C", seq: 3, total: 3 })).toBeNull();
    expect(r.push({ v: WIRE_VERSION, kind: "user", id, ts: 1, text: "A", seq: 1, total: 3 })).toBeNull();
    const out = r.push({ v: WIRE_VERSION, kind: "user", id, ts: 1, text: "B", seq: 2, total: 3 });
    expect(out!.text).toBe("ABC");
  });

  it("rejects contradictory totals", () => {
    const r = new Reassembler<UserMessage>();
    const id = "bad";
    r.push({ v: WIRE_VERSION, kind: "user", id, ts: 1, text: "A", seq: 1, total: 2 });
    expect(r.push({ v: WIRE_VERSION, kind: "user", id, ts: 1, text: "B", seq: 1, total: 3 })).toBeNull();
  });

  it("gc drops stale partial state", () => {
    const r = new Reassembler<UserMessage>();
    const id = "stale";
    const t0 = Date.now() - 120_000;
    r.push({ v: WIRE_VERSION, kind: "user", id, ts: t0, text: "A", seq: 1, total: 2 });
    r.gc(Date.now(), 60_000);
    // After GC, pushing the 2nd part starts fresh; result still null because
    // the first part is gone.
    const out = r.push({ v: WIRE_VERSION, kind: "user", id, ts: t0, text: "B", seq: 2, total: 2 });
    expect(out).toBeNull();
  });
});

describe("chunkAgentText", () => {
  it("produces 'agent' kind envelopes", () => {
    const parts = chunkAgentText("ok");
    expect(parts.every((p) => (p as AgentMessage).kind === "agent")).toBe(true);
  });
});
