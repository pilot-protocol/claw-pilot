import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { buildPilotChannelPlugin } from "../src/channel-plugin-api.js";
import { PilotLifecycle } from "../src/lifecycle.js";
import type { Transport, TransportInfo } from "../src/transport.js";
import { decodeEnvelope, MediaReassembler } from "../src/wire.js";

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
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("buildPilotChannelPlugin", () => {
  it("returns a ChannelPlugin with id, meta, capabilities and adapters", () => {
    const { plugin } = buildPilotChannelPlugin({ logger: silentLogger() });
    expect(plugin.id).toBe("pilot");
    expect(plugin.meta.label).toBe("Pilot");
    expect(plugin.capabilities.chatTypes).toEqual(["direct"]);
    expect(plugin.outbound).toBeDefined();
    expect(plugin.outbound?.sendText).toBeDefined();
    expect((plugin.outbound as unknown as { sendMedia?: unknown }).sendMedia).toBeDefined();
    expect(plugin.directory).toBeDefined();
    expect(plugin.status).toBeDefined();
    expect(plugin.lifecycle).toBeDefined();
    expect(plugin.messaging?.targetPrefixes).toEqual(["pilot:"]);
  });

  it("messaging.normalizeTarget strips the pilot: prefix", () => {
    const { plugin } = buildPilotChannelPlugin({ logger: silentLogger() });
    expect(plugin.messaging?.normalizeTarget?.(`pilot:${ALICE}`)).toBe(ALICE);
    expect(plugin.messaging?.normalizeTarget?.(ALICE)).toBe(ALICE);
    expect(plugin.messaging?.normalizeTarget?.("   ")).toBeUndefined();
  });

  it("status.summarize transitions through states as the account starts", async () => {
    const logger = silentLogger();
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
    });
    const { plugin } = buildPilotChannelPlugin({ logger, lifecycle });

    // Not configured yet
    const s0 = plugin.status?.summarize?.({}) as { state: string };
    expect(s0.state).toBe("missing");

    // After start
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);
    const s1 = plugin.status?.summarize?.({ accountId: "default" }) as {
      state: string;
      detail: string;
    };
    expect(s1.state).toBe("ok");
    expect(s1.detail).toMatch(/addr=.*node_id=.*peers=1/);

    await lifecycle.stopAll();
  });

  it("outbound.sendMedia from the live plugin produces valid pilot envelopes", async () => {
    const logger = silentLogger();
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
    });
    const { plugin } = buildPilotChannelPlugin({ logger, lifecycle });

    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    const src = Buffer.from("this is the image bytes", "utf8");
    const ctx = {
      cfg: {} as never,
      to: ALICE,
      text: "screenshot for you",
      mediaUrl: "/tmp/x.png",
      accountId: "default",
      mediaReadFile: async () => src,
    };
    const result = (await (plugin.outbound as unknown as {
      sendMedia: (c: typeof ctx) => Promise<{ ok: boolean; messageId?: string }>;
    }).sendMedia(ctx)) as { ok: boolean; messageId?: string };
    expect(result.ok).toBe(true);
    expect(transport.sent.length).toBeGreaterThan(0);

    // Verify the envelopes on the wire reassemble to the right bytes.
    const r = new MediaReassembler();
    let assembled: ReturnType<MediaReassembler["push"]> = null;
    for (const s of transport.sent) {
      const env = decodeEnvelope(s.data);
      expect(env.kind).toBe("media");
      if (env.kind === "media") {
        assembled = r.push(env) ?? assembled;
      }
    }
    expect(assembled).not.toBeNull();
    expect(assembled!.bytes.equals(src)).toBe(true);
    expect(assembled!.media).toBe("image");
    expect(assembled!.caption).toBe("screenshot for you");
    expect(assembled!.from).toBe("agent");

    await lifecycle.stopAll();
  });

  it("directory.resolveTarget accepts allowlisted addresses", async () => {
    const logger = silentLogger();
    const transport = new FakeTransport();
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => transport,
    });
    const { plugin } = buildPilotChannelPlugin({ logger, lifecycle });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);

    const ok = (await (plugin.directory as unknown as {
      resolveTarget: (p: {
        accountId: string;
        query: string;
      }) => Promise<{ ok: boolean; id?: string }>;
    }).resolveTarget({
      accountId: "default",
      query: ALICE,
    })) as { ok: boolean; id?: string };
    expect(ok.ok).toBe(true);
    expect(ok.id).toBe(ALICE);

    const denied = await (plugin.directory as unknown as {
      resolveTarget: (p: {
        accountId: string;
        query: string;
      }) => Promise<{ ok: boolean }>;
    }).resolveTarget({ accountId: "default", query: "9:DEAD.BEEF.CAFE" });
    expect(denied.ok).toBe(false);

    await lifecycle.stopAll();
  });
});
