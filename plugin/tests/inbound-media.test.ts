import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { InboundPipeline, type InboundDispatchInput } from "../src/inbound.js";
import { resolveAccount } from "../src/config.js";
import type { IncomingDatagram, Transport, TransportInfo } from "../src/transport.js";
import { chunkMedia, encodeEnvelope } from "../src/wire.js";

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  async start(): Promise<TransportInfo> {
    this.running = true;
    return { address: "1:0000.0000.0001", nodeId: 1 };
  }
  async send(): Promise<void> {
    /* noop */
  }
  async stop(): Promise<void> {
    this.running = false;
    this.emit("closed");
  }
  emitDatagram(dg: IncomingDatagram): void {
    this.emit("datagram", dg);
  }
}

const ALICE = "1:0000.0000.AAAA";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function randomBytes(n: number, seed = 1): Buffer {
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

describe("InboundPipeline — media", () => {
  it("reassembles a multi-chunk image and writes to the media dir", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "claw-pilot-test-"));
    const dispatched: InboundDispatchInput[] = [];
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger,
      mediaDir,
    });
    pipeline.attach(transport);

    const src = randomBytes(10_000, 7);
    const parts = chunkMedia({
      from: "user",
      media: "image",
      bytes: src,
      filename: "cat.jpg",
      mime: "image/jpeg",
      caption: "look at this cat",
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

    expect(dispatched).toHaveLength(1);
    const msg = dispatched[0]!;
    expect(msg.text).toBe("look at this cat");
    expect(msg.attachments).toHaveLength(1);
    const att = msg.attachments![0]!;
    expect(att.media).toBe("image");
    expect(att.filename).toBe("cat.jpg");
    expect(att.mime).toBe("image/jpeg");
    expect(att.size).toBe(src.length);
    expect(statSync(att.path).size).toBe(src.length);
    expect(readFileSync(att.path).equals(src)).toBe(true);

    pipeline.stop();
  });

  it("drops media from outside the allowlist", async () => {
    const dispatched: InboundDispatchInput[] = [];
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger,
    });
    pipeline.attach(transport);

    const parts = chunkMedia({
      from: "user",
      media: "file",
      bytes: Buffer.from("malicious"),
      filename: "x.bin",
    });
    for (const p of parts) {
      transport.emitDatagram({
        srcAddr: "9:DEAD.BEEF.CAFE",
        srcPort: 0,
        dstPort: 7777,
        data: encodeEnvelope(p),
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(dispatched).toHaveLength(0);
    pipeline.stop();
  });

  it("enforces maxMediaBytes cap", async () => {
    const dispatched: InboundDispatchInput[] = [];
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger,
      maxMediaBytes: 1_000,
    });
    pipeline.attach(transport);

    const parts = chunkMedia({
      from: "user",
      media: "file",
      bytes: randomBytes(5_000, 3),
      filename: "big.bin",
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
    expect(dispatched).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    pipeline.stop();
  });

  it("sanitizes filename — strips path traversal", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "claw-pilot-test-"));
    const dispatched: InboundDispatchInput[] = [];
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: async (m) => {
        dispatched.push(m);
      },
      logger,
      mediaDir,
    });
    pipeline.attach(transport);

    const parts = chunkMedia({
      from: "user",
      media: "file",
      bytes: Buffer.from("hi"),
      filename: "../../../etc/passwd",
      mime: "text/plain",
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
    expect(dispatched).toHaveLength(1);
    const path = dispatched[0]!.attachments![0]!.path;
    // Must live under mediaDir and not contain "../"
    expect(path.startsWith(mediaDir + "/")).toBe(true);
    expect(path).not.toMatch(/\.\.\//);

    pipeline.stop();
  });
});
