import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { ResolvedPilotAccount } from "../src/config.js";
import { Outbox } from "../src/outbox.js";
import { buildPilotReplyDispatcher } from "../src/reply-dispatcher.js";
import type { Transport } from "../src/transport.js";
import { decodeEnvelope } from "../src/wire.js";

import { EventEmitter } from "node:events";

class CapturingTransport extends EventEmitter implements Transport {
  public sent: Array<{ peer: string; port: number; data: Buffer }> = [];
  public failNext = 0;
  async start() {
    return { address: "0:0000.0001.0001", nodeId: 1 };
  }
  async send(peer: string, port: number, data: Buffer): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated send failure");
    }
    this.sent.push({ peer, port, data });
  }
  async stop(): Promise<void> {}
}

const PEER = "0:0000.DEAD.BEEF";

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeAccount(): ResolvedPilotAccount {
  return {
    accountId: "default",
    enabled: true,
    socketPath: "/tmp/pilot.sock",
    allowlist: new Set([PEER]),
    appPort: 7777,
    handshakeTrustAutoApprove: true,
    sharedSecret: undefined,
  };
}

describe("buildPilotReplyDispatcher", () => {
  let workDir: string;
  let outbox: Outbox;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pilot-reply-disp-"));
    outbox = new Outbox({ path: join(workDir, "outbox.json") });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("sendFinalReply chunks text into agent envelopes and sends to the peer on appPort", async () => {
    const transport = new CapturingTransport();
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    const ok = d.sendFinalReply({ text: "hello from claw" });
    expect(ok).toBe(true);
    await d.waitForIdle();
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    for (const s of transport.sent) {
      expect(s.peer).toBe(PEER);
      expect(s.port).toBe(7777);
      const env = decodeEnvelope(s.data);
      expect(env.kind).toBe("agent");
    }
    expect(d.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(d.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("sendBlockReply and sendToolResult also route through the transport", async () => {
    const transport = new CapturingTransport();
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.sendBlockReply({ text: "partial..." });
    d.sendToolResult({ text: "tool said: ok" });
    await d.waitForIdle();
    expect(transport.sent.length).toBeGreaterThanOrEqual(2);
    expect(d.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 0 });
  });

  it("empty/missing text is accepted as queued but produces no wire traffic", async () => {
    const transport = new CapturingTransport();
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    expect(d.sendToolResult({})).toBe(true);
    expect(d.sendFinalReply({ text: "" })).toBe(true);
    await d.waitForIdle();
    expect(transport.sent).toHaveLength(0);
  });

  it("a `mediaUrl` payload loads the file, chunks via chunkMedia, and sends each chunk to the peer", async () => {
    const transport = new CapturingTransport();
    const pngPath = join(workDir, "img.png");
    // Make the payload big enough to force at least one chunk split.
    writeFileSync(pngPath, Buffer.alloc(4_096, 0xff));
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    expect(d.sendFinalReply({ mediaUrl: `file://${pngPath}` })).toBe(true);
    await d.waitForIdle();
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    const decoded = transport.sent.map((s) => decodeEnvelope(s.data));
    for (const env of decoded) {
      expect(env.kind).toBe("media");
      if (env.kind === "media") {
        expect(env.media).toBe("image");
        expect(env.from).toBe("agent");
      }
    }
  });

  it("a media payload with caption text sends the caption on the first media chunk (no separate text envelope)", async () => {
    const transport = new CapturingTransport();
    const pngPath = join(workDir, "with-caption.png");
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.sendFinalReply({ text: "here's the diagram", mediaUrl: `file://${pngPath}` });
    await d.waitForIdle();
    const decoded = transport.sent.map((s) => decodeEnvelope(s.data));
    expect(decoded.every((e) => e.kind === "media")).toBe(true);
    const first = decoded[0]!;
    if (first.kind === "media") {
      expect(first.caption).toBe("here's the diagram");
    }
  });

  it("loading a non-existent media file marks the kind failed (counted, not silently dropped)", async () => {
    const transport = new CapturingTransport();
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.sendFinalReply({ mediaUrl: `file://${join(workDir, "does-not-exist.png")}` });
    await d.waitForIdle();
    expect(transport.sent).toHaveLength(0);
    expect(d.getFailedCounts().final).toBeGreaterThanOrEqual(1);
  });

  it("multiple urls in mediaUrls send each, deduped against mediaUrl", async () => {
    const transport = new CapturingTransport();
    const a = join(workDir, "a.png");
    const b = join(workDir, "b.png");
    writeFileSync(a, Buffer.alloc(64, 0x11));
    writeFileSync(b, Buffer.alloc(64, 0x22));
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.sendFinalReply({
      mediaUrl: `file://${a}`,
      mediaUrls: [`file://${a}`, `file://${b}`], // a is duplicated; should appear once
    });
    await d.waitForIdle();
    // Each file is small enough to fit in one media envelope (the bytes are
    // base64'd, ~88 bytes each, plus metadata — still under MAX_ENVELOPE_BYTES
    // for the first chunk + bytes split if needed). Should be 2 distinct ids.
    const ids = new Set<string>();
    for (const s of transport.sent) {
      const env = decodeEnvelope(s.data);
      if (env.kind === "media") ids.add(env.id);
    }
    expect(ids.size).toBe(2);
  });

  it("on send failure with an outbox, enqueues every chunk for retry and counts as queued (not failed)", async () => {
    const transport = new CapturingTransport();
    transport.failNext = 1; // first chunk throws; rest of the message gets queued
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      outbox,
      logger: silentLogger(),
    });
    d.sendFinalReply({ text: "long reply that will fail" });
    await d.waitForIdle();
    expect(outbox.forPeer(PEER).length).toBeGreaterThan(0);
    expect(d.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("on send failure without an outbox, counts the kind as failed", async () => {
    const transport = new CapturingTransport();
    transport.failNext = 1;
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.sendFinalReply({ text: "no outbox" });
    await d.waitForIdle();
    expect(d.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
  });

  it("post-markComplete sends are dropped", async () => {
    const transport = new CapturingTransport();
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.markComplete();
    expect(d.sendFinalReply({ text: "after complete" })).toBe(false);
    await d.waitForIdle();
    expect(transport.sent).toHaveLength(0);
  });

  it("waitForIdle resolves even when send rejects (no unhandled-rejection bubble)", async () => {
    const transport = new CapturingTransport();
    transport.failNext = 1; // no outbox, will be marked as failed
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger: silentLogger(),
    });
    d.sendFinalReply({ text: "will fail" });
    await expect(d.waitForIdle()).resolves.toBeUndefined();
  });
});
