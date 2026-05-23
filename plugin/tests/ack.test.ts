import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { InboundPipeline } from "../src/inbound.js";
import { resolveAccount } from "../src/config.js";
import type { IncomingDatagram, Transport, TransportInfo } from "../src/transport.js";
import {
  chunkMedia,
  chunkUserText,
  decodeEnvelope,
  encodeEnvelope,
} from "../src/wire.js";

const ALICE = "1:0000.0000.AAAA";

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

describe("inbound ACK", () => {
  it("emits an ack envelope after a successful text dispatch", async () => {
    const dispatched: unknown[] = [];
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger: silentLogger(),
      ackTransport: transport,
    });
    pipeline.attach(transport);

    const env = chunkUserText("ping")[0]!;
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(env),
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dispatched).toHaveLength(1);
    expect(transport.sent.length).toBe(1);
    const ack = decodeEnvelope(transport.sent[0]!.data);
    expect(ack.kind).toBe("ack");
    expect(ack.id).toBe(env.id);
    expect(transport.sent[0]!.peerAddr).toBe(ALICE);
    expect(transport.sent[0]!.port).toBe(7777);

    pipeline.stop();
  });

  it("emits an ack envelope after a successful media dispatch", async () => {
    const dispatched: unknown[] = [];
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger: silentLogger(),
      ackTransport: transport,
    });
    pipeline.attach(transport);

    const parts = chunkMedia({
      from: "user",
      media: "image",
      bytes: Buffer.from("imgbytes"),
      filename: "x.png",
      mime: "image/png",
    });
    for (const p of parts) {
      transport.emitDatagram({
        srcAddr: ALICE,
        srcPort: 0,
        dstPort: 7777,
        data: encodeEnvelope(p),
      });
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dispatched).toHaveLength(1);
    const acks = transport.sent
      .map((s) => decodeEnvelope(s.data))
      .filter((e) => e.kind === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.id).toBe(parts[0]!.id);

    pipeline.stop();
  });

  it("does not ack when ackTransport is not provided", async () => {
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async () => {
        /* noop */
      },
      logger: silentLogger(),
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("ping")[0]!),
    });
    await new Promise((r) => setImmediate(r));

    expect(transport.sent).toHaveLength(0);
    pipeline.stop();
  });

  it("does not ack when the message was dropped (not in allowlist)", async () => {
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async () => {
        /* noop */
      },
      logger: silentLogger(),
      ackTransport: transport,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: "9:DEAD.BEEF.CAFE",
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("trying")[0]!),
    });
    await new Promise((r) => setImmediate(r));

    expect(transport.sent).toHaveLength(0);
    pipeline.stop();
  });
});
