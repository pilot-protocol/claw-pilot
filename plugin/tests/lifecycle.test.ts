import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { PilotLifecycle } from "../src/lifecycle.js";
import type { Transport, TransportInfo } from "../src/transport.js";

const ALICE = "1:0000.0000.AAAA";

class FakeTransport extends EventEmitter implements Transport {
  running = false;
  started = vi.fn();
  stopped = vi.fn();
  info: TransportInfo = { address: "1:0000.0000.0001", nodeId: 42 };

  async start(): Promise<TransportInfo> {
    this.running = true;
    this.started();
    return this.info;
  }
  async send(): Promise<void> {
    /* noop */
  }
  async stop(): Promise<void> {
    this.running = false;
    this.stopped();
  }
}

function makeLifecycle() {
  const transports: FakeTransport[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const lifecycle = new PilotLifecycle({
    logger,
    createTransport: () => {
      const t = new FakeTransport();
      transports.push(t);
      return t;
    },
  });
  return { lifecycle, transports, logger };
}

describe("PilotLifecycle", () => {
  it("parses a single default account from flat config", () => {
    const { lifecycle } = makeLifecycle();
    const accounts = lifecycle.parseAccounts({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);
    expect(accounts.size).toBe(1);
    expect(accounts.get("default")!.allowlist.has(ALICE)).toBe(true);
  });

  it("parses multiple named accounts", () => {
    const { lifecycle } = makeLifecycle();
    const accounts = lifecycle.parseAccounts({
      channels: {
        pilot: {
          accounts: {
            phone: { allowlist: [ALICE] },
            tablet: { allowlist: ["2:1111.2222.3333"], appPort: 8888 },
          },
        },
      },
    } as never);
    expect(accounts.size).toBe(2);
    expect(accounts.get("phone")).toBeDefined();
    expect(accounts.get("tablet")!.appPort).toBe(8888);
  });

  it("skips invalid accounts but starts the valid ones", async () => {
    const { lifecycle, transports, logger } = makeLifecycle();
    await lifecycle.startAll({
      channels: {
        pilot: {
          accounts: {
            good: { allowlist: [ALICE] },
            broken: { allowlist: [] },
          },
        },
      },
    } as never);
    expect(transports).toHaveLength(1);
    expect(transports[0]!.started).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "pilot: invalid account config",
      expect.objectContaining({ accountId: "broken" }),
    );
    expect(lifecycle.getAccount("good")?.info?.nodeId).toBe(42);
    await lifecycle.stopAll();
  });

  it("skips disabled accounts", async () => {
    const { lifecycle, transports } = makeLifecycle();
    await lifecycle.startAll({
      channels: {
        pilot: { allowlist: [ALICE], enabled: false },
      },
    } as never);
    expect(transports).toHaveLength(0);
  });

  it("stopAll closes every running transport", async () => {
    const { lifecycle, transports } = makeLifecycle();
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);
    expect(transports[0]!.running).toBe(true);
    await lifecycle.stopAll();
    expect(transports[0]!.running).toBe(false);
    expect(transports[0]!.stopped).toHaveBeenCalled();
  });

  it("getResolvedAccount falls back to default", async () => {
    const { lifecycle } = makeLifecycle();
    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);
    expect(lifecycle.getResolvedAccount(null)?.accountId).toBe("default");
    expect(lifecycle.getResolvedAccount(undefined)?.accountId).toBe("default");
    expect(lifecycle.getResolvedAccount("default")?.accountId).toBe("default");
    expect(lifecycle.getResolvedAccount("nonexistent")).toBeUndefined();
    await lifecycle.stopAll();
  });

  it("retries startAccount when the transport's start() throws", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // First transport throws on start (e.g. daemon not yet listening); the
    // second one (used on retry) succeeds.
    let calls = 0;
    const transports: FakeTransport[] = [];
    const lifecycle = new PilotLifecycle({
      logger,
      createTransport: () => {
        calls++;
        const t = new FakeTransport();
        if (calls === 1) {
          t.start = vi.fn().mockRejectedValue(new Error("ENOENT pilot.sock"));
        }
        transports.push(t);
        return t;
      },
    });

    await lifecycle.startAll({
      channels: { pilot: { allowlist: [ALICE] } },
    } as never);
    // First attempt failed.
    expect(logger.error).toHaveBeenCalledWith(
      "pilot: failed to start account — will retry",
      expect.any(Object),
    );

    // Wait past the first backoff (500ms) for the retry.
    await new Promise((r) => setTimeout(r, 800));
    expect(calls).toBeGreaterThan(1);
    expect(logger.info).toHaveBeenCalledWith(
      "pilot: account started on retry",
      expect.any(Object),
    );
    expect(lifecycle.getAccount("default")?.info?.nodeId).toBe(42);

    await lifecycle.stopAll();
  });
});
