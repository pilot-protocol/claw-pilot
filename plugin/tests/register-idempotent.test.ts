// Regression test for the double-register bug (2026-05-21).
//
// Symptom in the wild: when openclaw's plugin auto-discovery runs after the
// agent has already booted (e.g. plugins.allow is empty and discovery fires
// again on a config touch), it calls our `register(api)` callback a SECOND
// time on the same module. Each register call creates a fresh
// lifecycle + transport + InboundPipeline. With two pipelines both listening
// to the same daemon socket, the SAME inbound datagram gets delivered twice,
// and each pipeline's `recent` Set is independent — so the dedup check
// passes in both, and the agent receives the same message twice.
//
// Fix: a module-level `registered` flag. Second register call logs a warning
// and returns immediately without creating any new state.

import { beforeEach, describe, expect, it, vi } from "vitest";

function makeFakeApi() {
  const channels: unknown[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    api: {
      logger,
      runtime: {
        channel: {
          reply: {
            dispatchReplyFromConfig: async () => {},
          },
        },
      },
      registerChannel: (r: unknown) => channels.push(r),
    },
    channels,
    logger,
  };
}

describe("plugin entry: register is idempotent", () => {
  beforeEach(() => {
    // Each test starts with a fresh module-level `registered` flag.
    vi.resetModules();
  });

  it("second register() call warns and registers no new channel", async () => {
    const mod = await import("../src/index.js");
    const entry = (mod as { default: { register: (api: unknown) => void } })
      .default;

    const a = makeFakeApi();
    entry.register(a.api);
    expect(a.channels.length).toBe(1);
    expect(a.logger.warn).not.toHaveBeenCalled();

    const b = makeFakeApi();
    entry.register(b.api);
    // Second register must NOT have registered another channel.
    expect(b.channels.length).toBe(0);
    // And it must log the explanatory warning.
    expect(b.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/register\(\) called more than once/i),
    );
  });

  it("re-imported module resets the flag (i.e. the guard is module-level, not global)", async () => {
    const mod1 = await import("../src/index.js");
    const entry1 = (mod1 as { default: { register: (api: unknown) => void } })
      .default;
    const a = makeFakeApi();
    entry1.register(a.api);
    expect(a.channels.length).toBe(1);

    vi.resetModules();
    const mod2 = await import("../src/index.js");
    const entry2 = (mod2 as { default: { register: (api: unknown) => void } })
      .default;
    const b = makeFakeApi();
    entry2.register(b.api);
    // Fresh module = fresh flag = registers cleanly.
    expect(b.channels.length).toBe(1);
    expect(b.logger.warn).not.toHaveBeenCalled();
  });
});
