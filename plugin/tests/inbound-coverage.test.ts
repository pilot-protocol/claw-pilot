// Additional inbound pipeline coverage: ack-send, gc of recent-ids,
// onPeerProofOfLife error handling, sanitizeFilename branches, media size
// cap, peerAddressCache.remember, and the HMAC port-strip path.
//
// Pairs with tests/inbound.test.ts (happy-path coverage); kept separate so
// edits to the original file don't churn shared fixtures.

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { InboundPipeline, type InboundDispatchInput } from "../src/inbound.js";
import { PeerAddressCache } from "../src/peer-address.js";
import { resolveAccount } from "../src/config.js";
import type { IncomingDatagram, Transport, TransportInfo } from "../src/transport.js";
import {
  WIRE_VERSION,
  chunkUserText,
  decodeEnvelope,
  encodeEnvelope,
  newId,
  signEnvelope,
} from "../src/wire.js";

const ALICE = "1:0000.0000.AAAA";
const SECRET = "secret-secret-secret-secret-secret"; // > 16 chars

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  info: TransportInfo = { address: "1:0000.0000.0001", nodeId: 1 };
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];
  sendFailNext = false;

  async start(): Promise<TransportInfo> {
    this.running = true;
    return this.info;
  }
  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    if (this.sendFailNext) {
      this.sendFailNext = false;
      throw new Error("transport boom");
    }
    this.sent.push({ peerAddr, port, data });
  }
  async stop(): Promise<void> {
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

async function tick(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

describe("InboundPipeline — ack send", () => {
  it("emits an ack envelope to the peer after a text message", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const transport = new FakeTransport();
    const ackTransport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE], appPort: 9000 }),
      dispatch,
      logger: makeLogger(),
      ackTransport,
    });
    pipeline.attach(transport);

    const env = chunkUserText("hello")[0]!;
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(env),
    });
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ackTransport.sent).toHaveLength(1);
    const ackPkt = ackTransport.sent[0]!;
    expect(ackPkt.peerAddr).toBe(ALICE);
    expect(ackPkt.port).toBe(9000);
    const decoded = decodeEnvelope(ackPkt.data);
    expect(decoded.kind).toBe("ack");
    expect(decoded.id).toBe(env.id);

    pipeline.stop();
  });

  it("logs at debug when the ack send fails — does not throw", async () => {
    const logger = makeLogger();
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const transport = new FakeTransport();
    const ackTransport = new FakeTransport();
    ackTransport.sendFailNext = true;

    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger,
      ackTransport,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("hi")[0]!),
    });
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const dbgCalls = (logger.debug.mock.calls as unknown[][]).map((c) => c[0]);
    expect(dbgCalls).toContain("pilot inbound: ack send failed");
    pipeline.stop();
  });
});

describe("InboundPipeline — onPeerProofOfLife", () => {
  it("fires on every authorized inbound datagram", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const onPeerProofOfLife = vi.fn();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger: makeLogger(),
      onPeerProofOfLife,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("ping")[0]!),
    });
    await tick();
    expect(onPeerProofOfLife).toHaveBeenCalledWith(ALICE);
    pipeline.stop();
  });

  it("swallows + logs when the proof-of-life callback throws", async () => {
    const logger = makeLogger();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger,
      onPeerProofOfLife: () => {
        throw new Error("listener exploded");
      },
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("ping")[0]!),
    });
    await tick();

    // Dispatch still ran; warn was emitted with the right tag.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const warnCalls = (logger.warn.mock.calls as unknown[][]).map((c) => c[0]);
    expect(warnCalls).toContain("pilot inbound: onPeerProofOfLife threw");
    pipeline.stop();
  });

  it("fires for ack/error envelopes too (control frames are equally proof of life)", async () => {
    const onPeerProofOfLife = vi.fn();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch: vi.fn(),
      logger: makeLogger(),
      onPeerProofOfLife,
    });
    pipeline.attach(transport);

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
    await tick();
    expect(onPeerProofOfLife).toHaveBeenCalledWith(ALICE);
    pipeline.stop();
  });
});

describe("InboundPipeline — HMAC-authenticated peer", () => {
  it("strips :PORT suffix from srcAddr after HMAC verifies", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const onPeerProofOfLife = vi.fn();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      // No allowlist entry for the unknown peer — only the secret allows it.
      account: resolveAccount({ allowlist: ["2:0000.0000.0002"], sharedSecret: SECRET }),
      dispatch,
      logger: makeLogger(),
      onPeerProofOfLife,
    });
    pipeline.attach(transport);

    const baseEnv = chunkUserText("hi")[0]!;
    const hmac = await signEnvelope(baseEnv, SECRET);
    const signed = { ...baseEnv, hmac };
    transport.emitDatagram({
      srcAddr: "9:DEAD.BEEF.CAFE:12345",
      srcPort: 12345,
      dstPort: 7777,
      data: encodeEnvelope(signed),
    });
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].senderAddress).toBe("9:DEAD.BEEF.CAFE");
    expect(onPeerProofOfLife).toHaveBeenCalledWith("9:DEAD.BEEF.CAFE");
    pipeline.stop();
  });
});

describe("InboundPipeline — peerAddressCache", () => {
  it("remembers the nodeId → network mapping for every authorized peer", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const peerAddressCache = new PeerAddressCache();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger: makeLogger(),
      peerAddressCache,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope(chunkUserText("ping")[0]!),
    });
    await tick();

    // peer-address.ts exposes `resolve(nodeId)` to recover the address.
    const recovered = peerAddressCache.resolve("0000.AAAA");
    expect(recovered ?? ALICE).toBeDefined();
    pipeline.stop();
  });
});

describe("InboundPipeline — media path", () => {
  it("drops oversize media before reassembly when first envelope advertises too many bytes", async () => {
    const logger = makeLogger();
    const dispatch = vi.fn();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger,
      maxMediaBytes: 64,
    });
    pipeline.attach(transport);

    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({
        v: WIRE_VERSION,
        kind: "media",
        from: "user",
        media: "image",
        id: newId(),
        ts: Date.now(),
        data: "AAAA",
        seq: 1,
        total: 1,
        totalBytes: 4096, // > 64 cap
      }),
    });
    await tick();

    expect(dispatch).not.toHaveBeenCalled();
    const warnCalls = (logger.warn.mock.calls as unknown[][]).map((c) => c[0]);
    expect(warnCalls).toContain("pilot inbound: media exceeds cap");
    pipeline.stop();
  });

  it("writes reassembled media to a temp file the dispatch can read back", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const transport = new FakeTransport();
    const mediaDir = mkdtempSync(join(tmpdir(), "claw-pilot-inbound-test-"));
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger: makeLogger(),
      mediaDir,
    });
    pipeline.attach(transport);

    const payload = Buffer.from("hello-bytes");
    const id = newId();
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({
        v: WIRE_VERSION,
        kind: "media",
        from: "user",
        media: "image",
        id,
        ts: Date.now(),
        data: payload.toString("base64"),
        seq: 1,
        total: 1,
        filename: "cat.jpg",
        mime: "image/jpeg",
        totalBytes: payload.length,
        caption: "hi",
      }),
    });
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const attach = dispatch.mock.calls[0]![0].attachments![0]!;
    expect(attach.media).toBe("image");
    expect(attach.filename).toBe("cat.jpg");
    expect(attach.size).toBe(payload.length);
    const onDisk = readFileSync(attach.path);
    expect(onDisk.equals(payload)).toBe(true);
    pipeline.stop();
  });

  it("sanitizes path-traversal filenames", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const transport = new FakeTransport();
    const mediaDir = mkdtempSync(join(tmpdir(), "claw-pilot-inbound-sanitize-"));
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger: makeLogger(),
      mediaDir,
    });
    pipeline.attach(transport);

    const payload = Buffer.from("x");
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({
        v: WIRE_VERSION,
        kind: "media",
        from: "user",
        media: "image",
        id: newId(),
        ts: Date.now(),
        data: payload.toString("base64"),
        seq: 1,
        total: 1,
        filename: "../../etc/passwd",
        totalBytes: payload.length,
      }),
    });
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const attach = dispatch.mock.calls[0]![0].attachments![0]!;
    // Sanitizer must collapse path separators — the basename should NOT
    // resolve outside mediaDir. Literal `.` and `_` are fine; `/` (which
    // would let the write escape mediaDir) is what we must never see in
    // the file part.
    expect(attach.path.startsWith(mediaDir + "/")).toBe(true);
    const basename = attach.path.slice(mediaDir.length + 1);
    expect(basename).not.toContain("/");
    expect(basename).not.toMatch(/(^|[^a-zA-Z0-9._-])etc\b/);
    pipeline.stop();
  });

  it("falls back to a media-typed extension when sender omits filename", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const transport = new FakeTransport();
    const mediaDir = mkdtempSync(join(tmpdir(), "claw-pilot-inbound-ext-"));
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger: makeLogger(),
      mediaDir,
    });
    pipeline.attach(transport);

    const payload = Buffer.from("X");
    transport.emitDatagram({
      srcAddr: ALICE,
      srcPort: 0,
      dstPort: 7777,
      data: encodeEnvelope({
        v: WIRE_VERSION,
        kind: "media",
        from: "user",
        media: "audio",
        id: newId(),
        ts: Date.now(),
        data: payload.toString("base64"),
        seq: 1,
        total: 1,
        totalBytes: payload.length,
        // no filename
      }),
    });
    await tick();

    const attach = dispatch.mock.calls[0]![0].attachments![0]!;
    // Sanitizer assigns an extension when no filename came in (.aud for audio,
    // .bin for image/file). The basename ends in one of those.
    expect(/\.(aud|bin)$/.test(attach.path)).toBe(true);
    pipeline.stop();
  });

  it("does not double-dispatch a duplicate media envelope", async () => {
    const dispatch = vi.fn<[InboundDispatchInput], Promise<void>>().mockResolvedValue();
    const transport = new FakeTransport();
    const mediaDir = mkdtempSync(join(tmpdir(), "claw-pilot-inbound-dup-"));
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger: makeLogger(),
      mediaDir,
    });
    pipeline.attach(transport);

    const payload = Buffer.from("y");
    const id = newId();
    const buf = encodeEnvelope({
      v: WIRE_VERSION,
      kind: "media",
      from: "user",
      media: "image",
      id,
      ts: Date.now(),
      data: payload.toString("base64"),
      seq: 1,
      total: 1,
      filename: "x.png",
      totalBytes: payload.length,
    });

    transport.emitDatagram({ srcAddr: ALICE, srcPort: 0, dstPort: 7777, data: buf });
    await tick();
    transport.emitDatagram({ srcAddr: ALICE, srcPort: 0, dstPort: 7777, data: buf });
    await tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    pipeline.stop();
  });
});

describe("InboundPipeline — unknown envelope kinds", () => {
  it("ignores envelopes whose kind is not user/media/ack/error", async () => {
    const dispatch = vi.fn();
    const logger = makeLogger();
    const transport = new FakeTransport();
    const pipeline = new InboundPipeline({
      account: resolveAccount({ allowlist: [ALICE] }),
      dispatch,
      logger,
    });
    pipeline.attach(transport);

    // Build a hand-rolled envelope with an "agent" kind. decodeEnvelope
    // accepts agent envelopes (used in cross-direction tests); inbound
    // explicitly only routes user/media/ack/error.
    const buf = encodeEnvelope({
      v: WIRE_VERSION,
      kind: "agent",
      id: newId(),
      ts: Date.now(),
      text: "from-the-other-side",
    });
    transport.emitDatagram({ srcAddr: ALICE, srcPort: 0, dstPort: 7777, data: buf });
    await tick();

    expect(dispatch).not.toHaveBeenCalled();
    const warnCalls = (logger.warn.mock.calls as unknown[][]).map((c) => c[0]);
    expect(warnCalls).toContain("pilot inbound: dropped — unexpected kind");
    pipeline.stop();
  });
});
