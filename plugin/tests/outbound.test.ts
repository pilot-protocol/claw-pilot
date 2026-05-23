import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { resolveAccount } from "../src/config.js";
import { buildPilotOutbound } from "../src/outbound.js";
import type { Transport, TransportInfo } from "../src/transport.js";
import { MAX_ENVELOPE_BYTES, decodeEnvelope } from "../src/wire.js";

class FakeTransport extends EventEmitter implements Transport {
  running = true;
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];

  async start(): Promise<TransportInfo> {
    return { address: "1:0000.0000.0001", nodeId: 1 };
  }
  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    this.sent.push({ peerAddr, port, data });
  }
  async stop(): Promise<void> {
    this.running = false;
  }
}

const ALICE_ADDR = "1:0000.0000.AAAA";

function ctxFor(to = ALICE_ADDR, text = "ok", accountId: string | null = null) {
  return {
    cfg: {} as never,
    to,
    text,
    accountId,
  } as Parameters<NonNullable<ReturnType<typeof buildPilotOutbound>["sendText"]>>[0];
}

describe("buildPilotOutbound", () => {
  it("sends one envelope for short text", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const r = (await out.sendText!(ctxFor())) as { ok: boolean; messageId?: string };
    expect(r.ok).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.peerAddr).toBe(ALICE_ADDR);
    expect(transport.sent[0]!.port).toBe(7777);

    const decoded = decodeEnvelope(transport.sent[0]!.data);
    expect(decoded.kind).toBe("agent");
    if (decoded.kind === "agent") {
      expect(decoded.text).toBe("ok");
    }
  });

  it("strips a port suffix on the target", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    await out.sendText!(ctxFor(`${ALICE_ADDR}:1234`));
    expect(transport.sent[0]!.peerAddr).toBe(ALICE_ADDR);
  });

  it("chunks long text across multiple envelopes", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const long = "A".repeat(3_500);
    const r = (await out.sendText!(ctxFor(ALICE_ADDR, long))) as { ok: boolean; messageId?: string };
    expect(r.ok).toBe(true);
    expect(transport.sent.length).toBeGreaterThan(1);

    // Each datagram fits the budget.
    for (const s of transport.sent) {
      expect(s.data.length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    }

    // Concatenating chunks yields the original text.
    const reassembled = transport.sent
      .map((s) => decodeEnvelope(s.data))
      .filter((e) => e.kind === "agent")
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((e) => (e.kind === "agent" ? e.text : ""))
      .join("");
    expect(reassembled).toBe(long);
  });

  it("returns ok:false when the account can't be resolved", async () => {
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => undefined,
      resolveTransport: () => transport,
    });
    const r = (await out.sendText!(ctxFor())) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/no resolved account/);
    expect(transport.sent).toHaveLength(0);
  });

  it("returns ok:false when the transport throws", async () => {
    const transport = new FakeTransport();
    transport.send = async () => {
      throw new Error("daemon unreachable");
    };
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const r = (await out.sendText!(ctxFor())) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/daemon unreachable/);
  });
});
