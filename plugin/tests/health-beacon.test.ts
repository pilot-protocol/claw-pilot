import { describe, expect, it, vi } from "vitest";

import { buildDispatcher } from "../src/dispatch.js";
import type { InboundDispatchInput } from "../src/inbound.js";

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeMsg(over: Partial<InboundDispatchInput> = {}): InboundDispatchInput {
  return {
    accountId: "default",
    senderAddress: "1:0000.0000.AAAA",
    text: "hi",
    messageId: `m-${Math.random()}`,
    timestamp: Date.now(),
    ...over,
  };
}

describe("inbound health beacon", () => {
  it("logs 'first delivery succeeded' once per account/strategy pair", async () => {
    const logger = silentLogger();
    const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);
    const api = {
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      },
    } as never;
    const dispatcher = buildDispatcher({
      strategy: {
        kind: "dispatchReplyFromConfig",
        runtime: api.runtime,
      },
      logger,
      api,
    });

    // First call → beacon fires.
    await dispatcher(makeMsg());
    expect(logger.info).toHaveBeenCalledWith(
      "pilot inbound: first delivery succeeded",
      expect.objectContaining({
        accountId: "default",
        strategy: "dispatchReplyFromConfig",
        via: "primary",
      }),
    );

    // Second call → beacon does NOT fire again for same account/strategy.
    logger.info.mockClear();
    await dispatcher(makeMsg());
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("beacon fires for a fallback strategy when primary fails", async () => {
    const logger = silentLogger();
    const dispatchReplyFromConfig = vi.fn().mockRejectedValue(new Error("primary down"));
    const enqueue = vi.fn().mockResolvedValue({ enqueued: true, id: "x" });
    const api = {
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      },
      enqueueNextTurnInjection: enqueue,
    } as never;
    const dispatcher = buildDispatcher({
      strategy: {
        kind: "dispatchReplyFromConfig",
        runtime: api.runtime,
      },
      logger,
      api,
    });

    await dispatcher(makeMsg());
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("pilot inbound: first delivery succeeded"),
      expect.objectContaining({
        strategy: "enqueueNextTurnInjection",
        via: "fallback step 1",
      }),
    );
    // And specifically, the enqueueNextTurnInjection variant must clarify
    // that no reply will be generated — otherwise the log misleads the
    // operator into thinking a turn was triggered.
    const enqueueCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("queued only"),
    );
    expect(enqueueCall, "expected the 'queued only' clarifier in the log message").toBeTruthy();
  });

  it("beacon fires separately for distinct account IDs", async () => {
    const logger = silentLogger();
    const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);
    const api = {
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      },
    } as never;
    const dispatcher = buildDispatcher({
      strategy: {
        kind: "dispatchReplyFromConfig",
        runtime: api.runtime,
      },
      logger,
      api,
    });

    await dispatcher(makeMsg({ accountId: "phone" }));
    await dispatcher(makeMsg({ accountId: "tablet" }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("first delivery succeeded"),
      expect.objectContaining({ accountId: "phone" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("first delivery succeeded"),
      expect.objectContaining({ accountId: "tablet" }),
    );
    expect(logger.info).toHaveBeenCalledTimes(2);
  });
});
