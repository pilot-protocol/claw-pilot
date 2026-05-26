import { mkdtempSync, rmSync } from "node:fs";
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

  it("media-only payload is rejected with a warn (channel-side gap, not a crash)", async () => {
    const transport = new CapturingTransport();
    const logger = silentLogger();
    const d = buildPilotReplyDispatcher({
      account: makeAccount(),
      peerAddr: PEER,
      transport,
      logger,
    });
    expect(d.sendFinalReply({ mediaUrl: "file:///tmp/x.png" })).toBe(true);
    await d.waitForIdle();
    expect(transport.sent).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("media payload ignored"),
      expect.any(Object),
    );
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
