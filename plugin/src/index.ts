// Entry point — openclaw discovers this via `openclaw.extensions[]` in
// package.json. We hand back a plugin-entry definition that:
//   • registers the channel via api.registerChannel({ plugin })
//   • wires up the runtime singleton so the inbound pipeline can dispatch
//     into the agent reply pipeline
//
// To install in a running openclaw:
//   openclaw plugins install /path/to/claw-pilot/plugin --link
//   openclaw channels add --provider pilot --name default \
//     --config '{"allowlist":["1:0000.0000.AAAA"]}'

import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "./openclaw-types.js";

import { buildPilotChannelPlugin } from "./channel-plugin-api.js";
import { buildDispatcher, pickDispatchStrategy } from "./dispatch.js";
import type { InboundLogger } from "./inbound.js";
import { setPilotRuntime } from "./runtime-api.js";

// Module-level guard against double-registration. Openclaw's plugin
// auto-discovery can re-load this module mid-runtime (e.g. when plugins.allow
// is empty and a discovery cycle fires after the agent has already booted).
// Each register() call creates a fresh lifecycle + transport + InboundPipeline;
// if the previous one is still alive, the SAME inbound datagram gets delivered
// to BOTH pipelines (each with its own `recent` dedup Set), causing the agent
// to receive the message twice. Holding a process-wide flag here makes the
// hook idempotent — second call logs a warning and returns the same handle.
let registered = false;

export default definePluginEntry({
  id: "pilot",
  name: "Pilot",
  description: "Pilot Protocol channel — DM your claw over an E2E-encrypted overlay.",
  register(api: OpenClawPluginApi) {
    if (registered) {
      api.logger.warn(
        "[pilot] register() called more than once — ignoring duplicate. " +
        "Set plugins.allow=['pilot'] in openclaw.json to suppress auto-discovery re-loads.",
      );
      return;
    }
    registered = true;
    const baseLogger = api.logger;
    const logger: InboundLogger = {
      debug: (m, meta) => baseLogger.debug?.(formatLog(m, meta)),
      info: (m, meta) => baseLogger.info(formatLog(m, meta)),
      warn: (m, meta) => baseLogger.warn(formatLog(m, meta)),
      error: (m, meta) => baseLogger.error(formatLog(m, meta)),
    };

    // Probe the runtime once for an inbound dispatch path. The strategy is
    // chosen at boot and reused per account so every pilot account shares
    // the same delivery semantics.
    const strategy = pickDispatchStrategy(api, logger);

    setPilotRuntime({
      host: api.runtime,
      buildDispatch: (ctx) =>
        buildDispatcher({
          strategy,
          logger,
          api,
          replyDeps: {
            account: ctx.account,
            transport: ctx.transport,
            outbox: ctx.outbox,
            getOpenClawConfig: ctx.getOpenClawConfig,
          },
        }),
    });

    const handle = buildPilotChannelPlugin({ logger });

    // OpenClawPluginApi.registerChannel takes either a registration shape or a
    // ChannelPlugin. We pass the bare ChannelPlugin; the runtime detects the
    // shape via `kind`-less duck typing on `id`/`meta`.
    (api as { registerChannel: (r: unknown) => void }).registerChannel({
      plugin: handle.plugin,
    });

    // The standard ChannelLifecycleAdapter hooks (onAccountConfigChanged,
    // runStartupMaintenance) aren't called for non-bundled channels in
    // openclaw 2026.5.x, and `api.runtime.cfg()` isn't exposed. Pragmatic
    // shortcut: read openclaw.json directly. We know the path because the
    // plugin runs in the same process as openclaw.
    const tryStart = async () => {
      let cfg: unknown = {};
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const candidates = [
          process.env.OPENCLAW_CONFIG_PATH,
          path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json"),
        ].filter(Boolean) as string[];
        for (const p of candidates) {
          try {
            const raw = fs.readFileSync(p, "utf8");
            cfg = JSON.parse(raw);
            logger.info(`pilot: loaded config from ${p}`);
            break;
          } catch {
            // try next
          }
        }
      } catch (e) {
        logger.warn(`pilot: config read failed (${(e as Error).message}); using empty`);
      }
      try {
        await handle.lifecycle.startAll(cfg as never);
        logger.info("pilot: lifecycle startAll completed");
      } catch (e) {
        logger.error(`pilot startup failed: ${(e as Error).message}`);
      }
    };
    // Defer past the current macrotask so the gateway finishes booting.
    setTimeout(() => {
      tryStart().catch((e) => logger.error(`pilot tryStart threw: ${(e as Error).message}`));
    }, 200);

    // Watch openclaw.json for in-place edits (allowlist tweaks, account adds,
    // etc). When it changes, restart accounts so new entries take effect
    // without requiring a pod restart. Best-effort — failures are logged.
    let watchDebounce: NodeJS.Timeout | null = null;
    (async () => {
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const candidatePath =
          process.env.OPENCLAW_CONFIG_PATH ??
          path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json");
        if (!fs.existsSync(candidatePath)) return;
        fs.watch(candidatePath, { persistent: false }, (eventType) => {
          if (eventType !== "change" && eventType !== "rename") return;
          if (watchDebounce) clearTimeout(watchDebounce);
          watchDebounce = setTimeout(async () => {
            try {
              const raw = fs.readFileSync(candidatePath, "utf8");
              const cfg = JSON.parse(raw);
              logger.info("pilot: openclaw.json changed — reloading accounts");
              await handle.lifecycle.stopAll();
              await handle.lifecycle.startAll(cfg as never);
            } catch (e) {
              logger.warn(`pilot: config reload failed: ${(e as Error).message}`);
            }
          }, 500);
        });
        logger.info(`pilot: watching ${candidatePath} for config changes`);
      } catch (e) {
        logger.warn(`pilot: fs.watch setup failed: ${(e as Error).message}`);
      }
    })().catch(() => {});

    // Hook runtime lifecycle for clean shutdown. The exact lifecycle hook
    // names vary across openclaw versions; we register what we have and let
    // openclaw call the hooks it knows about.
    const reg = api as unknown as {
      registerRuntimeLifecycle?: (r: Record<string, unknown>) => void;
    };
    reg.registerRuntimeLifecycle?.({
      id: "pilot",
      onShutdown: () => handle.lifecycle.stopAll(),
      onDeactivate: () => handle.lifecycle.stopAll(),
    });
  },
});

function formatLog(msg: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return msg;
  return `${msg} ${JSON.stringify(meta)}`;
}

// Re-export the builders so consumers / tests can use them.
export { buildPilotChannelPlugin } from "./channel-plugin-api.js";
export { setPilotRuntime, getPilotRuntime } from "./runtime-api.js";
export type { PilotChannelHandle } from "./channel-plugin-api.js";
export type { Transport, IncomingDatagram, TransportInfo } from "./transport.js";
