import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { buildPilotChannelPlugin } from "../src/channel-plugin-api.js";
import { PilotLifecycle } from "../src/lifecycle.js";
import type { Transport, TransportInfo } from "../src/transport.js";
import { decodeEnvelope } from "../src/wire.js";

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];
  label: string;

  constructor(label: string) {
    super();
    this.label = label;
  }
  async start(): Promise<TransportInfo> {
    this.running = true;
    return { address: `1:0000.0000.${this.label.toUpperCase().padEnd(4, "F")}`, nodeId: 1 };
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

describe("multi-account routing", () => {
  it("outbound.sendText routes to the per-account transport", async () => {
    const transports = new Map<string, FakeTransport>();
    const lifecycle = new PilotLifecycle({
      logger: silentLogger(),
      createTransport: ({ socketPath }) => {
        // We rig the transport label from the socket path so each account
        // gets a uniquely identifiable transport.
        const t = new FakeTransport(socketPath?.includes("phone") ? "p" : "tab");
        transports.set(socketPath ?? "?", t);
        return t;
      },
    });

    const { plugin } = buildPilotChannelPlugin({
      logger: silentLogger(),
      lifecycle,
    });

    await lifecycle.startAll({
      channels: {
        pilot: {
          accounts: {
            phone: {
              allowlist: ["1:0000.0000.AAAA"],
              socketPath: "/tmp/phone.sock",
              appPort: 7777,
            },
            tablet: {
              allowlist: ["2:1111.2222.3333"],
              socketPath: "/tmp/tablet.sock",
              appPort: 8888,
            },
          },
        },
      },
    } as never);

    // Send to phone
    const sendText = plugin.outbound!.sendText as unknown as (ctx: {
      accountId: string;
      to: string;
      text: string;
    }) => Promise<{ ok: boolean }>;
    const r1 = await sendText({
      accountId: "phone",
      to: "1:0000.0000.AAAA",
      text: "hi phone",
    });
    expect(r1.ok).toBe(true);

    // Send to tablet
    const r2 = await sendText({
      accountId: "tablet",
      to: "2:1111.2222.3333",
      text: "hi tablet",
    });
    expect(r2.ok).toBe(true);

    const phoneT = transports.get("/tmp/phone.sock")!;
    const tabletT = transports.get("/tmp/tablet.sock")!;

    expect(phoneT.sent).toHaveLength(1);
    expect(phoneT.sent[0]!.port).toBe(7777);
    expect(decodeEnvelope(phoneT.sent[0]!.data).text).toBe("hi phone");

    expect(tabletT.sent).toHaveLength(1);
    expect(tabletT.sent[0]!.port).toBe(8888);
    expect(decodeEnvelope(tabletT.sent[0]!.data).text).toBe("hi tablet");

    await lifecycle.stopAll();
  });

  it("outbound returns failure when no transport for the account", async () => {
    const lifecycle = new PilotLifecycle({
      logger: silentLogger(),
      createTransport: () => new FakeTransport("x"),
    });
    const { plugin } = buildPilotChannelPlugin({
      logger: silentLogger(),
      lifecycle,
    });
    await lifecycle.startAll({
      channels: { pilot: { allowlist: ["1:0000.0000.AAAA"] } },
    } as never);

    const sendText = plugin.outbound!.sendText as unknown as (ctx: {
      accountId: string;
      to: string;
      text: string;
    }) => Promise<{ ok: boolean; error?: Error }>;
    const r = await sendText({
      accountId: "nonexistent",
      to: "1:0000.0000.AAAA",
      text: "lost",
    });
    expect(r.ok).toBe(false);

    await lifecycle.stopAll();
  });
});
