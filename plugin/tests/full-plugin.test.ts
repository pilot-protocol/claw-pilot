// Full-plugin integration test.
//
// Wires a fake OpenClawPluginApi to the plugin's `register(api)` and proves
// the end-to-end inbound path: synthetic datagram → InboundPipeline → dispatch
// strategy → fake openclaw runtime hook. Catches drift between probe ↔
// dispatcher ↔ channel-plugin-api ↔ lifecycle.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { buildPilotChannelPlugin } from "../src/channel-plugin-api.js";
import { buildDispatcher, pickDispatchStrategy } from "../src/dispatch.js";
import { PilotLifecycle } from "../src/lifecycle.js";
import { resetPilotRuntimeForTests, setPilotRuntime } from "../src/runtime-api.js";
import type { Transport, TransportInfo } from "../src/transport.js";
import { chunkUserText, decodeEnvelope, encodeEnvelope } from "../src/wire.js";

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
  emitDatagram(addr: string, data: Buffer): void {
    this.emit("datagram", {
      srcAddr: addr,
      srcPort: 0,
      dstPort: 7777,
      data,
    });
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

describe("full plugin integration (synthetic openclaw)", () => {
  it("inbound datagram → dispatchReplyFromConfig with correct ctx", async () => {
    resetPilotRuntimeForTests();

    // 1. Fake openclaw runtime + api
    const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);
    const cfgFn = vi.fn().mockReturnValue({ stub: true });
    const fakeApi = {
      logger: silentLogger(),
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: cfgFn,
      },
      registerChannel: vi.fn(),
      registerRuntimeLifecycle: vi.fn(),
    } as never;

    // 2. Resolve the dispatch strategy (mimics what index.ts does)
    const logger = silentLogger();
    const strategy = pickDispatchStrategy(fakeApi, logger);
    expect(strategy.kind).toBe("dispatchReplyFromConfig");

    // 3. Wire the runtime singleton
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
    });
    setPilotRuntime({
      host: fakeApi.runtime,
      buildDispatch: () => buildDispatcher({ strategy, logger, api: fakeApi }),
    });

    // 4. Build + start the channel plugin
    const handle = buildPilotChannelPlugin({ logger, lifecycle });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    // 5. Simulate an inbound datagram from the allowlisted phone
    const env = chunkUserText("hello claw, here is a test")[0]!;
    transport.emitDatagram(ALICE, encodeEnvelope(env));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // 6. Assert openclaw was called with the right ctx shape
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const call = dispatchReplyFromConfig.mock.calls[0]![0]!;
    expect(call.ctx.Body).toBe("hello claw, here is a test");
    expect(call.ctx.From).toBe(ALICE);
    expect(call.ctx.Provider).toBe("pilot");
    expect(call.ctx.AccountId).toBe("default");
    expect(call.ctx.SessionKey).toBe(`pilot:default:${ALICE}`);
    expect(call.ctx.ChatType).toBe("direct");
    expect(call.ctx.MessageSid).toBe(env.id);

    // 7. ACK was sent back to the peer
    const acks = transport.sent
      .map((s) => decodeEnvelope(s.data))
      .filter((e) => e.kind === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.id).toBe(env.id);

    // 8. Outbound: agent replies via sendText through the same transport
    const sendText = handle.plugin.outbound!.sendText as unknown as (ctx: {
      accountId: string;
      to: string;
      text: string;
    }) => Promise<{ ok: boolean }>;
    const r = await sendText({
      accountId: "default",
      to: ALICE,
      text: "thanks for the test",
    });
    expect(r.ok).toBe(true);

    const agentReplies = transport.sent
      .map((s) => decodeEnvelope(s.data))
      .filter((e) => e.kind === "agent");
    expect(agentReplies).toHaveLength(1);
    if (agentReplies[0]!.kind === "agent") {
      expect(agentReplies[0]!.text).toBe("thanks for the test");
    }

    await lifecycle.stopAll();
    resetPilotRuntimeForTests();
  });

  it("inbound flows through fallback when primary dispatch throws", async () => {
    resetPilotRuntimeForTests();

    const dispatchReplyFromConfig = vi.fn().mockRejectedValue(new Error("primary down"));
    const enqueue = vi.fn().mockResolvedValue({ enqueued: true, id: "x" });
    const fakeApi = {
      logger: silentLogger(),
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      },
      enqueueNextTurnInjection: enqueue,
      registerChannel: vi.fn(),
      registerRuntimeLifecycle: vi.fn(),
    } as never;

    const logger = silentLogger();
    const strategy = pickDispatchStrategy(fakeApi, logger);
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
    });
    setPilotRuntime({
      host: fakeApi.runtime,
      buildDispatch: () => buildDispatcher({ strategy, logger, api: fakeApi }),
    });
    buildPilotChannelPlugin({ logger, lifecycle });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    transport.emitDatagram(
      ALICE,
      encodeEnvelope(chunkUserText("fail then succeed")[0]!),
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // Message still got through via fallback, so an ACK was sent.
    const acks = transport.sent
      .map((s) => decodeEnvelope(s.data))
      .filter((e) => e.kind === "ack");
    expect(acks.length).toBeGreaterThan(0);

    await lifecycle.stopAll();
    resetPilotRuntimeForTests();
  });
});
