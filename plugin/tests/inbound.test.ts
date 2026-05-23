import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { InboundPipeline, type InboundDispatchInput } from "../src/inbound.js";
import { resolveAccount } from "../src/config.js";
import type { IncomingDatagram, Transport, TransportInfo } from "../src/transport.js";
import {
  WIRE_VERSION,
  chunkUserText,
  encodeEnvelope,
  newId,
} from "../src/wire.js";

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  info: TransportInfo = { address: "1:0000.0000.0001", nodeId: 1 };
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];

  async start(): Promise<TransportInfo> {
    this.running = true;
    return this.info;
  }
  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    this.sent.push({ peerAddr, port, data });
  }
  async stop(): Promise<void> {
    this.running = false;
    this.emit("closed");
  }
  emitDatagram(dg: IncomingDatagram): void {
    this.emit("datagram", dg);
  }
}

function makeAccount(allow: string[] = ["1:0000.0000.AAAA"]) {
  return resolveAccount({ allowlist: allow });
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("InboundPipeline", () => {
  it("dispatches a single-chunk user message from an allowed peer", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    const env = chunkUserText("ping")[0]!;
    transport.emitDatagram({
      srcAddr: "1:0000.0000.AAAA:7777",
      srcPort: 7777,
      dstPort: 7777,
      data: encodeEnvelope(env),
    });
    // event handlers are sync; the dispatch is async, give it a tick
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      accountId: "default",
      senderAddress: "1:0000.0000.AAAA",
      text: "ping",
      messageId: env.id,
    });

    pipeline.stop();
  });

  it("drops a packet from a peer not in the allowlist", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: "2:DEAD.BEEF.CAFE",
      srcPort: 7777,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("malicious")[0]!),
    });

    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls.find((c) => /not allowed/.test(c[0]));
    expect(warnCall).toBeDefined();

    pipeline.stop();
  });

  it("drops a malformed envelope without crashing", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: "1:0000.0000.AAAA",
      srcPort: 7777,
      dstPort: 7777,
      data: Buffer.from("not even close to JSON"),
    });

    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "pilot inbound: dropped — bad envelope",
      expect.any(Object),
    );

    pipeline.stop();
  });

  it("reassembles multi-chunk user message before dispatching", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    const longText = "🦞 ".repeat(800);
    const parts = chunkUserText(longText);
    expect(parts.length).toBeGreaterThan(1);

    // Send in arbitrary order
    for (const p of [...parts].reverse()) {
      transport.emitDatagram({
        srcAddr: "1:0000.0000.AAAA",
        srcPort: 0,
        dstPort: 7777,
        data: encodeEnvelope(p),
      });
    }
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].text).toBe(longText);

    pipeline.stop();
  });

  it("deduplicates by message id", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    const env = {
      v: WIRE_VERSION,
      kind: "user" as const,
      id: "dup-1",
      ts: Date.now(),
      text: "hi",
    };
    const buf = encodeEnvelope(env);

    transport.emitDatagram({
      srcAddr: "1:0000.0000.AAAA",
      srcPort: 0,
      dstPort: 7777,
      data: buf,
    });
    transport.emitDatagram({
      srcAddr: "1:0000.0000.AAAA",
      srcPort: 0,
      dstPort: 7777,
      data: buf,
    });
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    pipeline.stop();
  });

  it("does not crash when the dispatch callback throws", async () => {
    const err = new Error("agent unreachable");
    const dispatch = vi.fn().mockRejectedValue(err);
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: "1:0000.0000.AAAA",
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("ping")[0]!),
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "pilot inbound: dispatch failed",
      expect.objectContaining({ err: "agent unreachable" }),
    );

    pipeline.stop();
  });

  it("ignores ack/error envelopes silently", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: makeAccount(["1:0000.0000.AAAA"]),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: "1:0000.0000.AAAA",
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({
        v: WIRE_VERSION,
        kind: "ack",
        id: newId(),
        ts: Date.now(),
      }),
    });
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
    pipeline.stop();
  });
});
