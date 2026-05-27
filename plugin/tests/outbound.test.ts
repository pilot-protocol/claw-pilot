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

    // Concatenating chunks yields the original text. Dedupe by seq first
    // — the redundancy pass sends each chunk twice for multi-chunk
    // messages (UDP-loss mitigation over the relay).
    const bySeq = new Map<number, string>();
    for (const s of transport.sent) {
      const env = decodeEnvelope(s.data);
      if (env.kind === "agent") bySeq.set(env.seq ?? 0, env.text);
    }
    const reassembled = Array.from(bySeq.entries())
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
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

  // Regression for the openclaw-passes-node_id bug. Before the peer-address
  // coercion the wire reject would queue every chunk to the outbox forever
  // (the outbox key is the same bad numeric string).
  it("coerces a numeric node_id `to` back to an address before sending", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    // 211747 → 0:0000.0003.3B23 (the real phone node from production logs).
    const r = (await out.sendText!(ctxFor("211747"))) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.peerAddr).toBe("0:0000.0003.3B23");
  });

  // Hard-reject path: malformed `to` that's neither an address nor a
  // node_id. We refuse synchronously instead of letting transport.send
  // throw and the outbox swallow 126 chunks.
  it("refuses send (no transport call, no outbox queue) when `to` is unparseable", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    let warned = false;
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
      logger: { info: () => {}, warn: () => { warned = true; } },
    });
    const r = (await out.sendText!(ctxFor("not-an-address"))) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/cannot resolve peer address/);
    expect(transport.sent).toHaveLength(0);
    expect(warned).toBe(true);
  });

  // Peer cache lets us pick the right network for known peers. Without the
  // cache the fallback always uses network 0, which is wrong for any
  // non-default-network deployment.
  it("uses the per-account peer cache to resolve into the right network", async () => {
    const { PeerAddressCache } = await import("../src/peer-address.js");
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const cache = new PeerAddressCache();
    cache.remember("7:0000.0003.3B23"); // observed inbound from network 7
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
      resolvePeerCache: () => cache,
    });
    await out.sendText!(ctxFor("211747"));
    expect(transport.sent[0]!.peerAddr).toBe("7:0000.0003.3B23");
  });

  // Redundancy pass: multi-chunk messages send each chunk twice to absorb
  // per-datagram UDP loss over the relay. Single-chunk messages do not —
  // the second pass is pure waste for them.
  it("sends each chunk TWICE for a multi-chunk message", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const long = "A".repeat(3_500); // forces ≥2 chunks
    await out.sendText!(ctxFor(ALICE_ADDR, long));
    // Each unique envelope id should appear at least twice in transport.sent
    // (once per pass).
    const counts = new Map<string, number>();
    for (const s of transport.sent) {
      const env = decodeEnvelope(s.data);
      if (env.kind === "agent") {
        const key = `${env.id}:${env.seq ?? 0}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect(counts.size).toBeGreaterThan(1); // multi-chunk
    for (const [_key, count] of counts) {
      expect(count).toBe(2);
    }
  });

  // Single-chunk text messages must NOT pay the 50ms redundancy delay —
  // chat-style "hi" sends should be as snappy as possible.
  it("does NOT double-send a single-chunk message", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE_ADDR] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    await out.sendText!(ctxFor(ALICE_ADDR, "hi"));
    expect(transport.sent).toHaveLength(1);
  });
});
