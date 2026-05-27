// Additional lifecycle.ts coverage: periodic outbox drain timer + stopAll
// resilience when transport.stop() throws + onPeerProofOfLife wired through
// to actually drain the outbox.

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PilotLifecycle } from "../src/lifecycle.js";
import type { IncomingDatagram, Transport, TransportInfo } from "../src/transport.js";
import {
  WIRE_VERSION,
  chunkUserText,
  encodeEnvelope,
  newId,
} from "../src/wire.js";

const ALICE = "1:0000.0000.AAAA";

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  info: TransportInfo = { address: "1:0000.0000.0001", nodeId: 42 };
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];
  sendImpl: ((peerAddr: string, port: number, data: Buffer) => Promise<void>) | null = null;
  stopImpl: (() => Promise<void>) | null = null;

  async start(): Promise<TransportInfo> {
    this.running = true;
    return this.info;
  }
  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    if (this.sendImpl) return this.sendImpl(peerAddr, port, data);
    this.sent.push({ peerAddr, port, data });
  }
  async stop(): Promise<void> {
    if (this.stopImpl) return this.stopImpl();
    this.running = false;
  }
  emitDatagram(dg: IncomingDatagram): void {
    this.emit("datagram", dg);
  }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("PilotLifecycle — stopAll resilience", () => {
  it("logs but does not throw when a transport's stop() rejects", async () => {
    const logger = makeLogger();
    const transport = new FakeTransport();
    transport.stopImpl = async () => {
      throw new Error("disk on fire");
    };
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
      outboxDir: mkdtempSync(join(tmpdir(), "claw-pilot-stoperr-")),
    });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    await expect(lifecycle.stopAll()).resolves.toBeUndefined();
    const warnCalls = (logger.warn.mock.calls as unknown[][]).map((c) => c[0]);
    expect(warnCalls).toContain("pilot: error stopping account");
  });
});

describe("PilotLifecycle — periodic outbox drain", () => {
  it("drains queued outbox entries on the timer interval", async () => {
    const logger = makeLogger();
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
      outboxDir: mkdtempSync(join(tmpdir(), "claw-pilot-drain-")),
      outboxDrainIntervalMs: 25,
    });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    const outbox = lifecycle.getOutbox("default");
    expect(outbox).toBeDefined();

    // Stash a queued envelope for ALICE.
    const env = chunkUserText("hello-queued")[0]!;
    const buf = encodeEnvelope(env);
    outbox!.enqueue(ALICE, {
      id: env.id,
      port: 7777,
      dataB64: buf.toString("base64"),
    });
    expect(outbox!.forPeer(ALICE).length).toBe(1);

    // Wait past the drain interval for real-timer based delivery.
    await new Promise((r) => setTimeout(r, 80));

    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    expect(transport.sent[0]!.peerAddr).toBe(ALICE);
    expect(transport.sent[0]!.port).toBe(7777);

    await lifecycle.stopAll();
  });

  it("periodic drain leaves entries queued when transport.send rejects", async () => {
    const logger = makeLogger();
    const transport = new FakeTransport();
    transport.sendImpl = async () => {
      throw new Error("network down");
    };
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
      outboxDir: mkdtempSync(join(tmpdir(), "claw-pilot-drain-fail-")),
      outboxDrainIntervalMs: 25,
    });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    const outbox = lifecycle.getOutbox("default")!;
    const env = chunkUserText("fails-to-send")[0]!;
    outbox.enqueue(ALICE, {
      id: env.id,
      port: 7777,
      dataB64: encodeEnvelope(env).toString("base64"),
    });

    await new Promise((r) => setTimeout(r, 80));

    // Drain ran — entry still in queue because send failed (outbox keeps
    // retrying entries until success or TTL eviction).
    expect(outbox.forPeer(ALICE).length).toBeGreaterThanOrEqual(1);

    await lifecycle.stopAll();
  });
});

describe("PilotLifecycle — onPeerProofOfLife drains for that peer", () => {
  it("queued message is delivered on proof of life from the peer", async () => {
    const logger = makeLogger();
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
      outboxDir: mkdtempSync(join(tmpdir(), "claw-pilot-pol-")),
      // Long periodic drain so we know any send is from proof-of-life path.
      outboxDrainIntervalMs: 60_000,
    });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    const outbox = lifecycle.getOutbox("default")!;
    const queuedEnv = chunkUserText("queued-while-alice-was-offline")[0]!;
    outbox.enqueue(ALICE, {
      id: queuedEnv.id,
      port: 7777,
      dataB64: encodeEnvelope(queuedEnv).toString("base64"),
    });

    // ALICE pings us — proof of life fires the per-peer drain.
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({
        v: WIRE_VERSION,
        kind: "ack",
        id: newId(),
        ts: Date.now(),
      }),
    });
    // Let async drains settle.
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    expect(transport.sent.some((p) => p.peerAddr === ALICE)).toBe(true);

    await lifecycle.stopAll();
  });
});
