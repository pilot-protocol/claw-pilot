import { describe, expect, it, vi } from "vitest";

import { buildDispatcher, buildSessionKey, pickDispatchStrategy } from "../src/dispatch.js";
import type { InboundDispatchInput } from "../src/inbound.js";

const ALICE = "1:0000.0000.AAAA";

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
    senderAddress: ALICE,
    text: "hi",
    messageId: "msg-1",
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe("buildSessionKey", () => {
  it("produces pilot:<account>:<peer>", () => {
    expect(buildSessionKey({ accountId: "default", peer: ALICE })).toBe(
      `pilot:default:${ALICE}`,
    );
    expect(buildSessionKey({ accountId: "alice", peer: "2:1.2.3" })).toBe(
      "pilot:alice:2:1.2.3",
    );
  });
});

describe("pickDispatchStrategy", () => {
  it("prefers dispatchReplyFromConfig when present", () => {
    const api = {
      logger: silentLogger(),
      runtime: {
        channel: {
          reply: {
            dispatchReplyFromConfig: vi.fn(),
          },
        },
      },
    } as never;
    const strategy = pickDispatchStrategy(api, silentLogger());
    expect(strategy.kind).toBe("dispatchReplyFromConfig");
  });

  it("falls back to enqueueNextTurnInjection", () => {
    const api = {
      logger: silentLogger(),
      runtime: {},
      enqueueNextTurnInjection: vi.fn(),
    } as never;
    const strategy = pickDispatchStrategy(api, silentLogger());
    expect(strategy.kind).toBe("enqueueNextTurnInjection");
  });

  it("falls through to log-only when no surface is found", () => {
    const api = { logger: silentLogger(), runtime: {} } as never;
    const strategy = pickDispatchStrategy(api, silentLogger());
    expect(strategy.kind).toBe("log-only");
  });
});

describe("buildDispatcher (dispatchReplyFromConfig path)", () => {
  it("forwards text + media slots through the runtime", async () => {
    const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);
    const cfg = vi.fn().mockReturnValue({ stub: true });
    const runtime = {
      channel: { reply: { dispatchReplyFromConfig } },
      cfg,
    };
    const strategy = {
      kind: "dispatchReplyFromConfig" as const,
      runtime: runtime as never,
    };
    const dispatcher = buildDispatcher({
      strategy,
      logger: silentLogger(),
      api: { runtime } as never,
    });

    await dispatcher(
      makeMsg({
        text: "look at this",
        attachments: [
          { media: "image", path: "/tmp/x.png", filename: "x.png", mime: "image/png", size: 12 },
        ],
      }),
    );

    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const call = dispatchReplyFromConfig.mock.calls[0]![0]!;
    expect(call.ctx.Body).toBe("look at this");
    expect(call.ctx.BodyForAgent).toBe("look at this");
    expect(call.ctx.BodyForCommands).toBe("look at this");
    expect(call.ctx.RawBody).toBe("look at this");
    expect(call.ctx.From).toBe(ALICE);
    expect(call.ctx.To).toBe(ALICE);
    expect(call.ctx.SenderId).toBe(ALICE);
    expect(call.ctx.SessionKey).toBe(`pilot:default:${ALICE}`);
    expect(call.ctx.Provider).toBe("pilot"); // not "channel"
    expect(call.ctx.MessageSid).toBe("msg-1");
    expect(call.ctx.MessageSidFull).toBe("msg-1");
    expect(call.ctx.RootMessageId).toBe("msg-1");
    expect(call.ctx.ChatType).toBe("direct");
    expect(call.ctx.MediaPath).toBe("/tmp/x.png");
    expect(call.ctx.MediaUrl).toBe("file:///tmp/x.png");
    expect(call.ctx.MediaPaths).toEqual(["/tmp/x.png"]);
  });

  it("logs and falls through when runtime call fails; final fallback is log-only warn", async () => {
    const logger = silentLogger();
    const dispatchReplyFromConfig = vi.fn().mockRejectedValue(new Error("boom"));
    const strategy = {
      kind: "dispatchReplyFromConfig" as const,
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      } as never,
    };
    const dispatcher = buildDispatcher({
      strategy,
      logger,
      api: { runtime: {} } as never,
    });
    await expect(dispatcher(makeMsg())).resolves.toBeUndefined();
    // First call to dispatchReplyFromConfig throws → fall through warn.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dispatchReplyFromConfig"),
      expect.objectContaining({ err: "boom", nextStep: "log-only" }),
    );
    // Final fallback runs (log-only).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("log-only"),
      expect.any(Object),
    );
  });

  it("works when runtime.cfg is not a function", async () => {
    const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);
    const strategy = {
      kind: "dispatchReplyFromConfig" as const,
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
      } as never,
    };
    const dispatcher = buildDispatcher({
      strategy,
      logger: silentLogger(),
      api: { runtime: {} } as never,
    });
    await dispatcher(makeMsg());
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});

describe("buildDispatcher (enqueueNextTurnInjection path)", () => {
  it("queues a decorated message keyed by the session key", async () => {
    const enqueue = vi.fn().mockResolvedValue({ enqueued: true, id: "inj-1" });
    const api = {
      enqueueNextTurnInjection: enqueue,
      runtime: {},
    } as never;
    const strategy = { kind: "enqueueNextTurnInjection" as const, api };
    const dispatcher = buildDispatcher({
      strategy,
      logger: silentLogger(),
      api,
    });
    await dispatcher(
      makeMsg({
        text: "hi claw",
        attachments: [
          { media: "image", path: "/tmp/a.png", filename: "a.png", mime: "image/png", size: 5 },
        ],
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0]![0]!;
    expect(call.sessionKey).toBe(`pilot:default:${ALICE}`);
    expect(call.idempotencyKey).toBe("msg-1");
    expect(call.text).toMatch(/pilot:\/\/1:0000\.0000\.AAAA → hi claw/);
    expect(call.text).toMatch(/attachment: \/tmp\/a\.png/);
  });

  it("survives an enqueue rejection by falling through to log-only", async () => {
    const logger = silentLogger();
    const enqueue = vi.fn().mockRejectedValue(new Error("queue full"));
    const api = { enqueueNextTurnInjection: enqueue, runtime: {} } as never;
    const dispatcher = buildDispatcher({
      strategy: { kind: "enqueueNextTurnInjection", api },
      logger,
      api,
    });
    await expect(dispatcher(makeMsg())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("enqueueNextTurnInjection"),
      expect.objectContaining({ err: "queue full", nextStep: "log-only" }),
    );
  });
});

describe("buildDispatcher (log-only)", () => {
  it("warns but does not throw", async () => {
    const logger = silentLogger();
    const dispatcher = buildDispatcher({
      strategy: { kind: "log-only" },
      logger,
      api: { runtime: {} } as never,
    });
    await dispatcher(makeMsg());
    expect(logger.warn).toHaveBeenCalledWith(
      "pilot dispatch (log-only) — message would have been delivered",
      expect.objectContaining({ id: "msg-1" }),
    );
  });
});

describe("buildDispatcher fallback chain", () => {
  it("falls through dispatchReplyFromConfig → enqueueNextTurnInjection when primary throws", async () => {
    const dispatchReplyFromConfig = vi.fn().mockRejectedValue(new Error("primary down"));
    const enqueue = vi.fn().mockResolvedValue({ enqueued: true, id: "x" });
    const api = {
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      },
      enqueueNextTurnInjection: enqueue,
    } as never;
    const logger = silentLogger();
    const dispatcher = buildDispatcher({
      strategy: {
        kind: "dispatchReplyFromConfig",
        runtime: api.runtime,
      },
      logger,
      api,
    });
    await dispatcher(makeMsg({ text: "fail then succeed" }));
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The fall-through is warn-level, not error — the message did get through.
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs error only after every strategy in the chain has failed", async () => {
    const dispatchReplyFromConfig = vi.fn().mockRejectedValue(new Error("primary down"));
    const enqueue = vi.fn().mockRejectedValue(new Error("queue down"));
    const api = {
      runtime: {
        channel: { reply: { dispatchReplyFromConfig } },
        cfg: () => ({}),
      },
      enqueueNextTurnInjection: enqueue,
    } as never;
    const logger = silentLogger();
    const dispatcher = buildDispatcher({
      strategy: {
        kind: "dispatchReplyFromConfig",
        runtime: api.runtime,
      },
      logger,
      api,
    });
    await dispatcher(makeMsg());
    // Both primary and secondary attempted, log-only also ran (warn-only).
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // No error because log-only doesn't throw — it's a terminal step.
    // Both fall-throughs should warn.
    expect(logger.warn).toHaveBeenCalled();
  });
});
