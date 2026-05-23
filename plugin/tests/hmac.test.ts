import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { InboundPipeline, type InboundDispatchInput } from "../src/inbound.js";
import { resolveAccount } from "../src/config.js";
import type { IncomingDatagram, Transport, TransportInfo } from "../src/transport.js";
import {
  WIRE_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  signEnvelope,
  verifyEnvelope,
} from "../src/wire.js";

const ALICE = "1:0000.0000.AAAA";
const STRANGER = "9:DEAD.BEEF.CAFE";
const SECRET = "this-is-a-shared-secret-at-least-16-chars";

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];
  async start(): Promise<TransportInfo> {
    this.running = true;
    return { address: "1:0000.0000.0001", nodeId: 1 };
  }
  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    this.sent.push({ peerAddr, port, data });
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  emitDatagram(dg: IncomingDatagram): void {
    this.emit("datagram", dg);
  }
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("wire HMAC", () => {
  it("signs and verifies a basic envelope", async () => {
    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "abc",
      ts: 1_700_000_000_000,
      text: "hi",
    };
    const hmac = await signEnvelope(env, SECRET);
    expect(hmac.length).toBeGreaterThan(20); // base64 of 32 bytes ≈ 44 chars

    const signed = { ...env, hmac };
    expect(await verifyEnvelope(signed, SECRET)).toBe(true);
  });

  it("rejects an envelope signed with a different secret", async () => {
    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: 1,
      text: "hi",
    };
    const hmac = await signEnvelope(env, SECRET);
    const signed = { ...env, hmac };
    expect(await verifyEnvelope(signed, "wrong-secret-at-least-16-chars-xx")).toBe(false);
  });

  it("rejects an envelope whose body was tampered with", async () => {
    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: 1,
      text: "hi",
    };
    const hmac = await signEnvelope(env, SECRET);
    const tampered = { ...env, text: "evil", hmac };
    expect(await verifyEnvelope(tampered, SECRET)).toBe(false);
  });

  it("returns false when hmac field is missing", async () => {
    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: 1,
      text: "hi",
    };
    expect(await verifyEnvelope(env as never, SECRET)).toBe(false);
  });

  it("canonicalization is key-order independent", async () => {
    // We never construct envelopes with reordered keys ourselves, but the
    // canonicalization MUST sort keys before signing so encoders that emit
    // keys in different orders produce the same HMAC.
    const a = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: 1,
      text: "hi",
    };
    const b = { ts: 1, kind: "user" as const, v: WIRE_VERSION, text: "hi", id: "x" };
    const sa = await signEnvelope(a, SECRET);
    const sb = await signEnvelope(b as never, SECRET);
    expect(sa).toBe(sb);
  });
});

describe("InboundPipeline — HMAC bypasses allowlist", () => {
  it("HMAC-valid envelope from non-allowlisted peer is delivered", async () => {
    const dispatched: InboundDispatchInput[] = [];
    const transport = new FakeTransport();
    const account = resolveAccount({
      allowlist: [ALICE],
      sharedSecret: SECRET,
    });
    const pipeline = new InboundPipeline({
      account,
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger: silentLogger(),
    });
    pipeline.attach(transport);

    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: Date.now(),
      text: "hello from a stranger with the password",
    };
    const hmac = await signEnvelope(env, SECRET);
    const signed = { ...env, hmac };

    transport.emitDatagram({
      srcAddr: STRANGER, // NOT in allowlist
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(signed),
    });
    await new Promise((r) => setImmediate(r));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.text).toBe(env.text);
    expect(dispatched[0]!.senderAddress).toBe(STRANGER);

    pipeline.stop();
  });

  it("invalid HMAC falls through to allowlist (which rejects)", async () => {
    const dispatched: InboundDispatchInput[] = [];
    const logger = silentLogger();
    const transport = new FakeTransport();
    const account = resolveAccount({
      allowlist: [ALICE],
      sharedSecret: SECRET,
    });
    const pipeline = new InboundPipeline({
      account,
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger,
    });
    pipeline.attach(transport);

    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: Date.now(),
      text: "evil",
      hmac: "junk-base64",
    };
    transport.emitDatagram({
      srcAddr: STRANGER,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(env),
    });
    await new Promise((r) => setImmediate(r));

    expect(dispatched).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "pilot inbound: dropped — not allowed",
      expect.objectContaining({ srcAddr: STRANGER, hadSecret: true }),
    );
    pipeline.stop();
  });

  it("when no sharedSecret configured, behavior is unchanged (allowlist only)", async () => {
    const dispatched: InboundDispatchInput[] = [];
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE] });
    const pipeline = new InboundPipeline({
      account,
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger: silentLogger(),
    });
    pipeline.attach(transport);

    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: Date.now(),
      text: "hi",
    };
    // Allowed peer succeeds.
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(env),
    });
    await new Promise((r) => setImmediate(r));
    expect(dispatched).toHaveLength(1);

    // Non-allowed peer is rejected.
    transport.emitDatagram({
      srcAddr: STRANGER,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({ ...env, id: "y" }),
    });
    await new Promise((r) => setImmediate(r));
    expect(dispatched).toHaveLength(1); // unchanged

    pipeline.stop();
  });
});

describe("resolveAccount — sharedSecret rules", () => {
  it("accepts a config with secret but no allowlist", () => {
    const acc = resolveAccount({ allowlist: [], sharedSecret: SECRET });
    expect(acc.allowlist.size).toBe(0);
    expect(acc.sharedSecret).toBe(SECRET);
  });

  it("rejects when neither allowlist nor secret is set", () => {
    expect(() => resolveAccount({ allowlist: [] })).toThrow(/allowlist.*sharedSecret/);
  });

  it("rejects a secret shorter than 16 chars", () => {
    expect(() => resolveAccount({ allowlist: [ALICE], sharedSecret: "tooshort" })).toThrow(
      /16 characters/,
    );
  });

  it("decodeEnvelope tolerates an hmac field (schema accepts it)", () => {
    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "x",
      ts: 1,
      text: "hi",
      hmac: "AAAA",
    };
    const back = decodeEnvelope(encodeEnvelope(env));
    expect((back as { hmac?: string }).hmac).toBe("AAAA");
  });
});
