// Inbound dispatch — routes a parsed pilot message (text or media) into
// openclaw's reply pipeline.
//
// The OpenClaw plugin runtime exposes several different inbound surfaces
// depending on version. We probe them in order of preference and use the
// first one that's present. This keeps the plugin working across the active
// openclaw versions (2026.5.7 stable channel) without recompiling.
//
// Tried in order:
//
//   1. runtime.channel.reply.dispatchReplyFromConfig({ ctx, cfg })   — preferred
//      Walks the full reply pipeline (route resolve → record → dispatch).
//   2. dispatchInboundMessage({ ctx, cfg, dispatcher })              — fallback
//      Direct inbound dispatch with a hand-built reply dispatcher.
//   3. api.enqueueNextTurnInjection({ sessionKey, text })            — last resort
//      Queues text for the *next* agent turn but doesn't trigger one.
//
// We log the chosen path once at boot so it's easy to debug from `openclaw
// plugins doctor`.

import type { ResolvedPilotAccount } from "./config.js";
import type {
  InboundDispatchInput,
  InboundLogger,
  InboundMediaAttachment,
} from "./inbound.js";
import type { OpenClawConfig, OpenClawPluginApi, PluginRuntime } from "./openclaw-types.js";
import type { Outbox } from "./outbox.js";
import { buildPilotReplyDispatcher, type ReplyDispatcher } from "./reply-dispatcher.js";
import type { Transport } from "./transport.js";
import { CHANNEL_ID } from "./channel-plugin-api.js";

/**
 * Inputs that `MsgContext` accepts for media. We populate as many shapes as
 * possible since the host's media subsystem reads from any of these slots.
 */
function attachmentSlots(attachments: InboundMediaAttachment[] | undefined): {
  MediaPath?: string;
  MediaPaths?: string[];
  MediaUrl?: string;
  MediaUrls?: string[];
} {
  if (!attachments || attachments.length === 0) return {};
  const paths = attachments.map((a) => a.path);
  return {
    MediaPath: paths[0],
    MediaPaths: paths,
    MediaUrl: `file://${paths[0]}`,
    MediaUrls: paths.map((p) => `file://${p}`),
  };
}

type RuntimeShape = PluginRuntime & {
  // dispatchReplyFromConfig path. The dispatcher param is REQUIRED by
  // openclaw — calling without it crashes on `dispatcher.sendFinalReply`
  // the moment the agent run produces (or fails to produce) output.
  channel?: {
    reply?: {
      dispatchReplyFromConfig?: (params: {
        ctx: Record<string, unknown>;
        cfg: OpenClawConfig;
        dispatcher: ReplyDispatcher;
        configOverride?: OpenClawConfig;
      }) => Promise<unknown>;
    };
  };
  // Access to current openclaw config
  cfg?: () => OpenClawConfig;
};

type ApiShape = OpenClawPluginApi & {
  /** Newer surface; preferred for "inject context into next turn". */
  enqueueNextTurnInjection?: (params: {
    sessionKey: string;
    text: string;
    idempotencyKey?: string;
  }) => Promise<{ enqueued: boolean; id: string }>;
};

/** Pre-decided dispatch strategy resolved at plugin boot. */
type DispatchStrategy =
  | { kind: "dispatchReplyFromConfig"; runtime: RuntimeShape }
  | { kind: "enqueueNextTurnInjection"; api: ApiShape }
  | { kind: "log-only" };

export function pickDispatchStrategy(api: OpenClawPluginApi, logger: InboundLogger): DispatchStrategy {
  const runtime = api.runtime as RuntimeShape;
  if (typeof runtime?.channel?.reply?.dispatchReplyFromConfig === "function") {
    logger.info("pilot dispatch: using runtime.channel.reply.dispatchReplyFromConfig");
    return { kind: "dispatchReplyFromConfig", runtime };
  }
  const apiShape = api as ApiShape;
  if (typeof apiShape.enqueueNextTurnInjection === "function") {
    logger.warn(
      "pilot dispatch: falling back to enqueueNextTurnInjection — replies will land on the next agent turn but won't trigger one",
    );
    return { kind: "enqueueNextTurnInjection", api: apiShape };
  }
  logger.error(
    "pilot dispatch: no compatible inbound surface found on this openclaw runtime — messages will be logged only",
  );
  return { kind: "log-only" };
}

/**
 * Build the dispatch closure for a single account, given a pre-resolved
 * primary strategy. The closure takes one `InboundDispatchInput` (a parsed
 * pilot message) and routes it into openclaw — falling through to the next
 * strategy in the chain if the primary throws, so a single bad call doesn't
 * lose the message silently.
 */
/**
 * Per-account wiring required for the dispatchReplyFromConfig path to send
 * agent replies back to the peer. When absent (e.g. legacy tests), the path
 * passes a no-op dispatcher — openclaw won't crash, but no reply will reach
 * the peer either.
 */
export type ReplyTransportDeps = {
  account: ResolvedPilotAccount;
  transport: Transport;
  outbox?: Outbox;
};

export function buildDispatcher(params: {
  strategy: DispatchStrategy;
  logger: InboundLogger;
  api: OpenClawPluginApi;
  replyDeps?: ReplyTransportDeps;
}): (msg: InboundDispatchInput) => Promise<void> {
  const { strategy, logger, api, replyDeps } = params;

  // Order primary first, then the rest as fallbacks. If the primary IS
  // log-only there's nothing to fall through to.
  const chain: DispatchStrategy[] = buildFallbackChain(strategy, api);

  // Per-account first-delivery-success beacon — log one info line the first
  // time a message lands via each strategy so ops can spot the path actually
  // being exercised in production without grepping ACKs.
  const beaconSeen = new Set<string>();

  return async (msg) => {
    const slots = attachmentSlots(msg.attachments);
    const sessionKey = buildSessionKey({ accountId: msg.accountId, peer: msg.senderAddress });

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]!;
      const isLast = i === chain.length - 1;
      try {
        await runStrategy(step, msg, sessionKey, slots, logger, replyDeps);
        const beaconKey = `${msg.accountId}:${step.kind}`;
        if (!beaconSeen.has(beaconKey)) {
          beaconSeen.add(beaconKey);
          // enqueueNextTurnInjection just appends the message to a queue;
          // it does NOT trigger an agent run, so the user won't get a reply
          // until the next time the agent fires (cron / manual / etc).
          // Surface this so logs aren't misleading.
          const note = step.kind === "enqueueNextTurnInjection"
            ? " (queued only — agent must run to consume; no reply will be generated by this delivery alone)"
            : step.kind === "log-only"
              ? " (log-only — no delivery actually happened)"
              : "";
          logger.info(`pilot inbound: first delivery succeeded${note}`, {
            accountId: msg.accountId,
            strategy: step.kind,
            via: i === 0 ? "primary" : `fallback step ${i}`,
          });
        }
        return;
      } catch (e) {
        const stepName = step.kind;
        if (isLast) {
          logger.error(`pilot dispatch (${stepName}) failed, no more fallbacks`, {
            id: msg.messageId,
            err: (e as Error).message,
          });
        } else {
          logger.warn(`pilot dispatch (${stepName}) failed, falling through`, {
            id: msg.messageId,
            err: (e as Error).message,
            nextStep: chain[i + 1]!.kind,
          });
        }
      }
    }
  };
}

function buildFallbackChain(primary: DispatchStrategy, api: OpenClawPluginApi): DispatchStrategy[] {
  const chain: DispatchStrategy[] = [primary];
  const apiShape = api as ApiShape;
  // If primary is reply-from-config and we ALSO have enqueueNextTurnInjection
  // available, add it as a fallback.
  if (
    primary.kind === "dispatchReplyFromConfig"
    && typeof apiShape.enqueueNextTurnInjection === "function"
  ) {
    chain.push({ kind: "enqueueNextTurnInjection", api: apiShape });
  }
  // Always end with log-only so a totally broken runtime still records the message.
  if (chain[chain.length - 1]!.kind !== "log-only") {
    chain.push({ kind: "log-only" });
  }
  return chain;
}

async function runStrategy(
  strategy: DispatchStrategy,
  msg: InboundDispatchInput,
  sessionKey: string,
  slots: ReturnType<typeof attachmentSlots>,
  logger: InboundLogger,
  replyDeps: ReplyTransportDeps | undefined,
): Promise<void> {
  switch (strategy.kind) {
    case "dispatchReplyFromConfig": {
      const cfg =
        typeof strategy.runtime.cfg === "function"
          ? strategy.runtime.cfg()
          : ({} as OpenClawConfig);
      // Build a per-message ReplyDispatcher bound to this peer. openclaw
      // calls dispatcher.sendFinalReply / sendBlockReply / sendToolResult as
      // the agent run produces output. Without one openclaw would crash on
      // `Cannot read properties of undefined (reading 'sendFinalReply')`.
      const dispatcher: ReplyDispatcher = replyDeps
        ? buildPilotReplyDispatcher({
            account: replyDeps.account,
            peerAddr: msg.senderAddress,
            transport: replyDeps.transport,
            outbox: replyDeps.outbox,
            logger,
          })
        : noopReplyDispatcher(logger);
      // Field names match openclaw's MsgContext type — see
      // plugin-sdk/src/auto-reply/templating.d.ts. The schema uses PascalCase
      // (Body, From, MessageSid, Provider, etc).
      try {
        await strategy.runtime.channel!.reply!.dispatchReplyFromConfig!({
          ctx: {
            cfg,
            Body: msg.text,
            BodyForAgent: msg.text,
            BodyForCommands: msg.text,
            RawBody: msg.text,
            Provider: CHANNEL_ID,
            AccountId: msg.accountId,
            From: msg.senderAddress,
            To: msg.senderAddress,
            SenderId: msg.senderAddress,
            SenderName: msg.senderAddress,
            MessageSid: msg.messageId,
            MessageSidFull: msg.messageId,
            RootMessageId: msg.messageId,
            Timestamp: msg.timestamp,
            ChatType: "direct",
            SessionKey: sessionKey,
            ...slots,
          },
          cfg,
          dispatcher,
        });
        // Wait for any in-flight chunked sends to finish before returning
        // so beacon logs / failure reporting see the settled state.
        await dispatcher.waitForIdle();
      } finally {
        dispatcher.markComplete();
      }
      return;
    }
    case "enqueueNextTurnInjection": {
      const decorated = decorateForInjection(msg, slots);
      await strategy.api.enqueueNextTurnInjection!({
        sessionKey,
        text: decorated,
        idempotencyKey: msg.messageId,
      });
      return;
    }
    case "log-only":
    default: {
      logger.warn("pilot dispatch (log-only) — message would have been delivered", {
        id: msg.messageId,
        accountId: msg.accountId,
        sender: msg.senderAddress,
        textLen: msg.text.length,
        attachments: msg.attachments?.length ?? 0,
      });
      return;
    }
  }
}

/**
 * Build a session key. For pilot we use `pilot:<accountId>:<peer>` so that
 * each peer DM gets its own session. This matches the convention other DM
 * channels (telegram, signal) use.
 */
export function buildSessionKey(params: { accountId: string; peer: string }): string {
  return `${CHANNEL_ID}:${params.accountId}:${params.peer}`;
}

/**
 * Stand-in dispatcher used when no transport deps are wired (tests, legacy
 * callers). Lets `dispatchReplyFromConfig` complete without crashing on
 * undefined dispatcher fields — but any replies the agent emits are dropped.
 */
function noopReplyDispatcher(logger: InboundLogger): ReplyDispatcher {
  const counts = { tool: 0, block: 0, final: 0 } as Record<"tool" | "block" | "final", number>;
  const note = (kind: "tool" | "block" | "final") => {
    counts[kind] += 1;
    logger.warn("pilot dispatch: reply dropped — no transport wired into dispatcher", { kind });
    return true;
  };
  return {
    sendToolResult: () => note("tool"),
    sendBlockReply: () => note("block"),
    sendFinalReply: () => note("final"),
    waitForIdle: async () => undefined,
    getQueuedCounts: () => ({ ...counts }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => undefined,
  };
}

/**
 * For the next-turn-injection fallback, render the inbound as a chat-style
 * line so the agent at least sees the message text plus attachment paths.
 */
function decorateForInjection(
  msg: InboundDispatchInput,
  slots: { MediaPaths?: string[] },
): string {
  const lines: string[] = [];
  lines.push(`pilot://${msg.senderAddress} → ${msg.text || "(no text)"}`);
  if (slots.MediaPaths && slots.MediaPaths.length > 0) {
    for (const p of slots.MediaPaths) {
      lines.push(`  attachment: ${p}`);
    }
  }
  return lines.join("\n");
}
