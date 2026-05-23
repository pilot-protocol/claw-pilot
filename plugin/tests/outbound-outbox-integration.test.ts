// Integration test for the outbox wiring:
//   1. transport.send throws → outbox holds all chunks
//   2. peer sends ANY inbound → outbox drains for that peer → chunks go out
//
// Uses a FakeTransport that lets us inject failures, then flip back to success
// to simulate the peer coming back online.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAccount } from "../src/config.js";
import { InboundPipeline } from "../src/inbound.js";
import { buildPilotOutbound } from "../src/outbound.js";
import { Outbox } from "../src/outbox.js";
import type { Transport, TransportInfo } from "../src/transport.js";
import { chunkAgentText, encodeEnvelope, WIRE_VERSION } from "../src/wire.js";

const PEER = "0:0000.DEAD.BEEF";

let workDir: string;
let oboxPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "outbox-integ-"));
  oboxPath = join(workDir, "outbox.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

class FlakyTransport extends EventEmitter implements Transport {
  public failNext = false;
  public sent: Array<{ peer: string; port: number; data: Buffer }> = [];
  async start(): Promise<TransportInfo> {
    return { address: "0:0000.0001.0001", nodeId: 1 };
  }
  async send(peer: string, port: number, data: Buffer): Promise<void> {
    if (this.failNext) throw new Error("simulated send failure");
    this.sent.push({ peer, port, data });
  }
  async stop(): Promise<void> {}
}

function silent() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("outbound + outbox integration", () => {
  it("falls back to the outbox when the transport throws, and drains on the next inbound from the peer", async () => {
    const transport = new FlakyTransport();
    const outbox = new Outbox({ path: oboxPath });
    const account = resolveAccount({ allowlist: [PEER] });

    // Build outbound with our outbox wired in.
    const outbound = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
      resolveOutbox: () => outbox,
      logger: silent(),
    });

    // Hook the inbound pipeline so proof-of-life from PEER triggers the
    // outbox drain — this is the wire we actually want to exercise.
    const pipeline = new InboundPipeline({
      account,
      dispatch: async () => {},
      logger: silent(),
      onPeerProofOfLife: (peer) => {
        if (outbox.forPeer(peer).length === 0) return;
        void outbox.drain(peer, (p, port, data) => transport.send(p, port, data));
      },
    });
    pipeline.attach(transport);

    // === 1) Peer is "offline" — every send fails. Outbox should capture ===
    transport.failNext = true;
    const sendText = outbound.sendText as unknown as (ctx: {
      to: string;
      text: string;
    }) => Promise<{ ok: boolean; messageId: string; queued?: boolean }>;
    const result1 = await sendText({ to: PEER, text: "hi while you were away" });
    expect(result1.ok).toBe(true);
    expect(result1.queued).toBe(true);
    expect(transport.sent).toHaveLength(0);
    expect(outbox.forPeer(PEER).length).toBeGreaterThanOrEqual(1);

    // === 2) Peer comes back — flip the flag + emit a fake inbound datagram ===
    transport.failNext = false;
    // Use a valid user envelope so the InboundPipeline passes auth + decode.
    const inboundEnv = encodeEnvelope(
      chunkAgentText("ping from peer", "irrelevant-id")[0]!,
    );
    transport.emit("datagram", {
      srcAddr: PEER,
      srcPort: 12345,
      dstPort: 7777,
      data: inboundEnv,
    });

    // Drain is awaited via setImmediate inside .drain — wait long enough.
    await new Promise((r) => setTimeout(r, 50));

    // The queued chunk(s) should have been resent.
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    expect(transport.sent[0]!.peer).toBe(PEER);
    expect(outbox.forPeer(PEER)).toHaveLength(0);

    pipeline.stop();
  });

  it("with no outbox configured, send failures propagate as ok=false", async () => {
    const transport = new FlakyTransport();
    transport.failNext = true;
    const account = resolveAccount({ allowlist: [PEER] });
    const outbound = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
      // no resolveOutbox
      logger: silent(),
    });
    const sendText = outbound.sendText as unknown as (ctx: {
      to: string;
      text: string;
    }) => Promise<{ ok: boolean; queued?: boolean; error?: Error }>;
    const result = await sendText({ to: PEER, text: "no outbox here" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/simulated send failure/);
  });
});
