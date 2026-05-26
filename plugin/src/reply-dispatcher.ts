// ReplyDispatcher factory for the openclaw embedded-reply lane.
//
// `runtime.channel.reply.dispatchReplyFromConfig` REQUIRES a ReplyDispatcher
// parameter. Without one, openclaw's internal dispatch helper crashes with
// "Cannot read properties of undefined (reading 'sendFinalReply')" the moment
// the agent either succeeds or errors — there's nowhere to put the result.
//
// This factory returns a dispatcher that takes openclaw's ReplyPayload, chunks
// any text via the same `chunkAgentText` + `encodeEnvelope` path the
// OutboundAdapter uses, and hands the encoded bytes to the transport for the
// peer that originated the inbound message. On transport failure the chunks
// fall through to the per-account outbox if one is provided, matching
// outbound.ts behavior.

import type { ResolvedPilotAccount } from "./config.js";
import type { Outbox } from "./outbox.js";
import type { Transport } from "./transport.js";
import { chunkAgentText, encodeEnvelope, newId } from "./wire.js";

/**
 * Subset of openclaw's ReplyPayload we care about. The full type lives in
 * `@openclaw/plugin-sdk` but the channel only needs `text` (and `mediaUrl(s)`
 * for the deferred media path).
 */
export type ReplyDispatcherPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  isError?: boolean;
  isReasoning?: boolean;
  // Other fields exist in the full type but the channel ignores them.
  [k: string]: unknown;
};

/** Mirrors openclaw's ReplyDispatchKind. */
export type ReplyDispatchKind = "tool" | "block" | "final";

/**
 * Mirrors openclaw's ReplyDispatcher contract. We only depend on the fields
 * openclaw actually invokes from dispatchReplyFromConfig.
 */
export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyDispatcherPayload) => boolean;
  sendBlockReply: (payload: ReplyDispatcherPayload) => boolean;
  sendFinalReply: (payload: ReplyDispatcherPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
};

export type ReplyDispatcherDeps = {
  account: ResolvedPilotAccount;
  /** Peer that originated the inbound message — replies go back here. */
  peerAddr: string;
  transport: Transport;
  /** Optional. If provided, send failures enqueue for later retry. */
  outbox?: Outbox;
  logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

export function buildPilotReplyDispatcher(deps: ReplyDispatcherDeps): ReplyDispatcher {
  const { account, peerAddr, transport, outbox, logger } = deps;
  const queued: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const failed: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const pending: Array<Promise<void>> = [];
  let complete = false;

  function dispatch(kind: ReplyDispatchKind, payload: ReplyDispatcherPayload): boolean {
    if (complete) {
      logger?.debug?.("pilot reply: post-complete dispatch ignored", { kind });
      return false;
    }
    queued[kind] += 1;

    if (payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
      // Media replies via the embedded reply lane are not wired yet — the
      // OutboundAdapter path handles them for normal channel routing.
      logger?.warn("pilot reply: media payload ignored (only text supported via embedded reply lane)", {
        kind,
        hasMediaUrl: !!payload.mediaUrl,
        mediaCount: payload.mediaUrls?.length ?? (payload.mediaUrl ? 1 : 0),
      });
    }

    const text = payload.text;
    if (typeof text !== "string" || text.length === 0) {
      // Tool results and reasoning blocks frequently have no visible text.
      // Counted as queued (so openclaw knows we accepted it), no wire work.
      return true;
    }

    const envelopes = chunkAgentText(text, newId());
    const encoded: Buffer[] = envelopes.map((env) => encodeEnvelope(env));

    const sendAll = (async () => {
      for (let i = 0; i < encoded.length; i++) {
        try {
          await transport.send(peerAddr, account.appPort, encoded[i]!);
        } catch (e) {
          // Match outbound.ts: enqueue ALL chunks so the receiver's
          // reassembler doesn't see partial state after a stale TTL.
          if (outbox) {
            for (let j = 0; j < envelopes.length; j++) {
              outbox.enqueue(peerAddr, {
                id: envelopes[j]!.id,
                seq: envelopes[j]!.seq,
                port: account.appPort,
                dataB64: encoded[j]!.toString("base64"),
              });
            }
            logger?.info("pilot reply: send failed, message queued in outbox", {
              kind,
              peer: peerAddr,
              messageId: envelopes[0]!.id,
              chunks: envelopes.length,
              failedAt: i,
              err: e instanceof Error ? e.message : String(e),
            });
            return;
          }
          failed[kind] += 1;
          logger?.warn?.("pilot reply: send failed (no outbox)", {
            kind,
            peer: peerAddr,
            messageId: envelopes[0]!.id,
            failedAt: i,
            err: e instanceof Error ? e.message : String(e),
          });
          return;
        }
      }
    })();

    // Swallow rejections so an unhandled-rejection doesn't take down the
    // event loop — the failure path above already accounts for them.
    pending.push(sendAll.catch(() => undefined));
    return true;
  }

  return {
    sendToolResult: (p) => dispatch("tool", p),
    sendBlockReply: (p) => dispatch("block", p),
    sendFinalReply: (p) => dispatch("final", p),
    waitForIdle: async () => {
      await Promise.all(pending);
    },
    getQueuedCounts: () => ({ ...queued }),
    getFailedCounts: () => ({ ...failed }),
    markComplete: () => {
      complete = true;
    },
  };
}
