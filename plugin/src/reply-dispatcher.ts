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

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { ResolvedPilotAccount } from "./config.js";
import type { Outbox } from "./outbox.js";
import type { Transport } from "./transport.js";
import { chunkAgentText, chunkMedia, encodeEnvelope, newId, type MediaKind } from "./wire.js";

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

    const mediaUrls = collectMediaUrls(payload);
    const text = payload.text;

    // Nothing visible to send (e.g. tool-progress notice with no text/media).
    // Counted as queued so openclaw knows we accepted, no wire work.
    if (mediaUrls.length === 0 && (typeof text !== "string" || text.length === 0)) {
      return true;
    }

    // Text first (when present) — for media replies with a caption, openclaw
    // typically packages caption in `payload.text` and the file ref in
    // `mediaUrl`. We send the text as a chat bubble; the caption itself
    // travels on the first media chunk via `chunkMedia`.
    if (typeof text === "string" && text.length > 0 && mediaUrls.length === 0) {
      const textPromise = sendTextEnvelopes(text, kind);
      pending.push(textPromise.catch(() => undefined));
    }

    // Media — load each url, chunk, send.
    for (const url of mediaUrls) {
      const mediaPromise = sendOneMedia(url, payload.text, kind);
      pending.push(mediaPromise.catch(() => undefined));
    }

    return true;
  }

  async function sendTextEnvelopes(text: string, kind: ReplyDispatchKind): Promise<void> {
    const envelopes = chunkAgentText(text, newId());
    const encoded: Buffer[] = envelopes.map((env) => encodeEnvelope(env));
    // Visibility: success path was previously silent, which made it
    // impossible to tell "dispatcher was invoked with nothing" from
    // "dispatcher sent successfully." A single info line per reply is
    // cheap and pays for itself the next time delivery is unclear.
    logger?.info("pilot reply: dispatching text", {
      kind,
      peer: peerAddr,
      messageId: envelopes[0]!.id,
      chunks: envelopes.length,
      bytes: text.length,
    });
    await sendChunks({ encoded, envelopes, kind });
  }

  async function sendOneMedia(
    url: string,
    caption: string | undefined,
    kind: ReplyDispatchKind,
  ): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await loadMediaBytes(url);
    } catch (e) {
      failed[kind] += 1;
      logger?.warn?.("pilot reply: media load failed", {
        kind,
        url,
        err: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const filename = pathFilenameFromUrl(url);
    const mime = inferMimeFromFilename(filename);
    const media = classifyMediaFromMime(mime);
    const envelopes = chunkMedia({
      from: "agent",
      media,
      bytes,
      filename,
      mime,
      caption: caption && caption.length > 0 ? caption : undefined,
      id: newId(),
    });
    const encoded: Buffer[] = envelopes.map((env) => encodeEnvelope(env));
    logger?.info("pilot reply: dispatching media", {
      kind,
      peer: peerAddr,
      messageId: envelopes[0]!.id,
      chunks: envelopes.length,
      bytes: bytes.length,
      media,
      mime,
      filename,
    });
    await sendChunks({ encoded, envelopes, kind });
  }

  async function sendChunks(params: {
    encoded: Buffer[];
    envelopes: Array<{ id: string; seq?: number }>;
    kind: ReplyDispatchKind;
  }): Promise<void> {
    const { encoded, envelopes, kind } = params;
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
    // Redundancy pass for multi-chunk messages — see outbound.ts
    // sendOrEnqueue for the math. iOS reassembler dedupes on (id, seq),
    // single-chunk text replies don't bother re-sending.
    if (envelopes.length > 1) {
      await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < encoded.length; i++) {
        try {
          await transport.send(peerAddr, account.appPort, encoded[i]!);
        } catch {
          // Best-effort retry. Primary pass already succeeded; if the
          // relay starts dropping during the second pass, the iOS
          // reassembler still has the originals.
          break;
        }
      }
    }
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

/** Merge the two media-url shapes openclaw can hand us into one ordered list. */
function collectMediaUrls(payload: ReplyDispatcherPayload): string[] {
  const out: string[] = [];
  if (payload.mediaUrl) out.push(payload.mediaUrl);
  if (payload.mediaUrls && payload.mediaUrls.length > 0) {
    for (const u of payload.mediaUrls) {
      if (u && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

/**
 * Read media bytes from a url the agent produced. Accepts `file://` URLs and
 * raw absolute paths — the embedded reply lane runs in-process with the
 * agent, so anything the agent could write the dispatcher can read. No
 * trust-roots check here (unlike outbound.ts) because the agent is already
 * trusted: the alternative is silently dropping its replies.
 */
async function loadMediaBytes(url: string): Promise<Buffer> {
  const path = url.startsWith("file://") ? url.slice("file://".length) : url;
  return readFile(path);
}

function pathFilenameFromUrl(url: string): string {
  if (url.startsWith("file://")) return basename(url.slice("file://".length));
  return basename(url);
}

function inferMimeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".heic": return "image/heic";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".wav": return "audio/wav";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    default: return "application/octet-stream";
  }
}

function classifyMediaFromMime(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}
