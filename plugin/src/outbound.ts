// Outbound adapter — when openclaw's reply pipeline has text/payload to send
// to the user, it calls this. We encode an agent envelope and shoot it to the
// peer's pilot address via the transport.

import { readFile } from "node:fs/promises";
import { extname, basename, resolve as pathResolve, sep } from "node:path";

import type { ChannelOutboundAdapter, OutboundDeliveryResult } from "./openclaw-types.js";

import type { ResolvedPilotAccount } from "./config.js";
import type { Outbox } from "./outbox.js";
import { isPilotAddress, looksLikeNodeId, nodeIdToAddress, PeerAddressCache } from "./peer-address.js";
import type { Transport } from "./transport.js";
import {
  WIRE_VERSION,
  chunkAgentText,
  chunkMedia,
  encodeEnvelope,
  newId,
  type MediaKind,
} from "./wire.js";

export type OutboundDeps = {
  resolveAccount: (accountId: string | null | undefined) => ResolvedPilotAccount | undefined;
  /**
   * Resolve the live transport for a given account. Each pilot account owns
   * its own daemon socket + transport instance.
   */
  resolveTransport: (accountId: string | null | undefined) => Transport | undefined;
  /**
   * Trust roots for the fallback path-read when `ctx.mediaReadFile` isn't
   * provided by the runtime. ABSOLUTE prefixes; reads outside any root are
   * refused. Default: only the openclaw workspace media dir.
   *
   * If empty, the fallback path is disabled entirely — `mediaReadFile` MUST
   * be provided by the runtime to send media.
   */
  mediaTrustRoots?: readonly string[];
  /**
   * Optional outbox. When set, if a chunk's `transport.send` throws, all
   * chunks of the message are enqueued for retry instead of failing the
   * caller. The next inbound from this peer (proof of life) and the
   * lifecycle's periodic tick drain the queue.
   */
  resolveOutbox?: (accountId: string | null | undefined) => Outbox | undefined;
  /** Optional logger for outbox events. */
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * Resolves a `to` value that arrived as a bare node_id (e.g. `"211747"`)
   * back to a proper pilot address (`0:0000.0003.3B23`). openclaw's outbound
   * routing sometimes hands us the agent-side identifier instead of the
   * channel-side address; without this coercion, `transport.send` rejects
   * with `invalid address` and every chunk pollutes the outbox forever.
   */
  resolvePeerCache?: (accountId: string | null | undefined) => PeerAddressCache | undefined;
};

/**
 * Build a `ChannelOutboundAdapter` for the pilot channel.
 *
 * Targets are bare pilot addresses (e.g. "1:0000.0000.AAAA"). The plugin
 * doesn't address by port — Pilot routes to the peer's daemon; the
 * application demux happens via envelope kind.
 */
export function buildPilotOutbound(deps: OutboundDeps): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    textChunkLimit: 900, // safely under MAX_ENVELOPE_BYTES once JSON-wrapped
    chunkerMode: "text",
    sendText: (async (ctx: { accountId?: string | null; to: string; text: string }) => {
      const account = deps.resolveAccount(ctx.accountId ?? null);
      if (!account) {
        return failResult(`pilot: no resolved account for ${ctx.accountId ?? "<default>"}`);
      }
      const transport = deps.resolveTransport(ctx.accountId ?? null);
      if (!transport) {
        return failResult(`pilot: no live transport for ${ctx.accountId ?? "<default>"}`);
      }
      const peerAddr = resolvePeerAddr(ctx.to, deps.resolvePeerCache?.(ctx.accountId ?? null));
      if (!peerAddr) {
        deps.logger?.warn?.("pilot outbound: refusing send — unresolvable `to`", {
          to: ctx.to,
          accountId: ctx.accountId ?? "default",
        });
        return failResult(`pilot: cannot resolve peer address from "${ctx.to}" — expected N:XXXX.YYYY.YYYY or a known node_id`);
      }
      const envelopes = chunkAgentText(ctx.text, newId());
      const sendResult = await sendOrEnqueue({
        envelopes,
        peerAddr,
        appPort: account.appPort,
        transport,
        outbox: deps.resolveOutbox?.(ctx.accountId ?? null),
        logger: deps.logger,
      });
      return sendResult;
    }) as unknown as ChannelOutboundAdapter["sendText"],

    // Outbound media — openclaw calls this with `mediaUrl` (a path or URL) and
    // an optional caption in `text`. We read the file (using mediaReadFile if
    // provided, else fs.readFile), then chunk and send as media envelopes.
    sendMedia: (async (ctx: {
      accountId?: string | null;
      to: string;
      text?: string;
      mediaUrl?: string;
      mediaReadFile?: (path: string) => Promise<Buffer>;
    }) => {
      const account = deps.resolveAccount(ctx.accountId ?? null);
      if (!account) {
        return failResult(`pilot: no resolved account for ${ctx.accountId ?? "<default>"}`);
      }
      if (!ctx.mediaUrl) {
        return failResult("pilot: sendMedia called without mediaUrl");
      }
      const transport = deps.resolveTransport(ctx.accountId ?? null);
      if (!transport) {
        return failResult(`pilot: no live transport for ${ctx.accountId ?? "<default>"}`);
      }
      const peerAddr = resolvePeerAddr(ctx.to, deps.resolvePeerCache?.(ctx.accountId ?? null));
      if (!peerAddr) {
        deps.logger?.warn?.("pilot outbound: refusing media send — unresolvable `to`", {
          to: ctx.to,
          accountId: ctx.accountId ?? "default",
        });
        return failResult(`pilot: cannot resolve peer address from "${ctx.to}" — expected N:XXXX.YYYY.YYYY or a known node_id`);
      }
      try {
        const bytes = await loadMedia(ctx.mediaUrl, ctx.mediaReadFile, deps.mediaTrustRoots);
        const filename = pathFilename(ctx.mediaUrl);
        const mime = inferMime(filename);
        const media = classifyMedia(mime, filename);
        const envelopes = chunkMedia({
          from: "agent",
          media,
          bytes,
          filename,
          mime,
          caption: ctx.text && ctx.text.length > 0 ? ctx.text : undefined,
          id: newId(),
        });
        return await sendOrEnqueue({
          envelopes,
          peerAddr,
          appPort: account.appPort,
          transport,
          outbox: deps.resolveOutbox?.(ctx.accountId ?? null),
          logger: deps.logger,
        });
      } catch (e) {
        return failResult(e instanceof Error ? e.message : String(e));
      }
    }) as unknown as ChannelOutboundAdapter["sendMedia"],
  };
}

function failResult(msg: string): OutboundDeliveryResult {
  return { ok: false, error: new Error(msg) };
}

/**
 * Try to send every chunk. On the first failure: if an outbox is configured,
 * enqueue ALL chunks of this message (including ones already sent) under
 * the peer and return ok=true with a "queued" marker — otherwise propagate
 * the error.
 *
 * Why enqueue everything including already-sent chunks: the receiver's
 * `Reassembler` buffers chunks for ~60s. If the peer is offline for hours,
 * the leader chunks would expire before the tail arrives. Re-sending the
 * full message on drain guarantees reassembly. Brief duplication when the
 * peer is reachable is harmless — the receiver's `recent` Set dedups by
 * message id after reassembly.
 */
async function sendOrEnqueue(params: {
  envelopes: Array<{ id: string; seq?: number }>;
  peerAddr: string;
  appPort: number;
  transport: Transport;
  outbox?: Outbox;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}): Promise<OutboundDeliveryResult> {
  const { envelopes, peerAddr, appPort, transport, outbox, logger } = params;
  const encoded: Buffer[] = envelopes.map((env) =>
    encodeEnvelope(env as Parameters<typeof encodeEnvelope>[0]),
  );
  // Visibility: success path was silent, hiding successful sends from
  // diagnostics. One info line per OutboundAdapter call lets us tell
  // "channel-adapter route fired and succeeded" from "never ran" — the
  // missing diagnostic that left the recent image-delivery question
  // ambiguous (was the agent silent? Or was it sending via this path?).
  logger?.info("pilot outbound: sending", {
    peer: peerAddr,
    port: appPort,
    messageId: envelopes[0]!.id,
    chunks: envelopes.length,
  });
  for (let i = 0; i < envelopes.length; i++) {
    await throttleIfNeeded(i, envelopes.length);
    try {
      await transport.send(peerAddr, appPort, encoded[i]!);
    } catch (e) {
      if (!outbox) {
        return failResult(e instanceof Error ? e.message : String(e));
      }
      // Enqueue ALL chunks for retry — see comment above.
      for (let j = 0; j < envelopes.length; j++) {
        outbox.enqueue(peerAddr, {
          id: envelopes[j]!.id,
          seq: envelopes[j]!.seq,
          port: appPort,
          dataB64: encoded[j]!.toString("base64"),
        });
      }
      logger?.info("pilot outbound: send failed, message queued in outbox", {
        peer: peerAddr,
        messageId: envelopes[0]!.id,
        chunks: envelopes.length,
        failedAt: i,
        err: e instanceof Error ? e.message : String(e),
      });
      return { ok: true, messageId: envelopes[0]!.id, queued: true } as OutboundDeliveryResult;
    }
  }
  return { ok: true, messageId: envelopes[0]!.id } as OutboundDeliveryResult;
}

/**
 * Small inter-chunk delay applied to multi-chunk outbound after the first
 * burst window. The iOS daemon's UDP recv socket has a ~256KB kernel buffer
 * (default for SO_RCVBUF on iOS); at ~1KB per encoded chunk, only ~256
 * can sit waiting before the kernel silently drops the rest. The recv
 * worker drains much slower than we can pump (relay path adds latency to
 * the drain). Burst the first N chunks at full speed for small media, then
 * slow down so the receiver can keep up.
 */
const BURST_WINDOW = 50;
const POST_BURST_DELAY_MS = 5;

async function throttleIfNeeded(chunkIndex: number, totalChunks: number): Promise<void> {
  if (totalChunks <= BURST_WINDOW) return;
  if (chunkIndex < BURST_WINDOW) return;
  await new Promise((r) => setTimeout(r, POST_BURST_DELAY_MS));
}

async function loadMedia(
  url: string,
  reader: ((path: string) => Promise<Buffer>) | undefined,
  trustRoots: readonly string[] | undefined,
): Promise<Buffer> {
  // The runtime-provided reader applies the host's mediaAccess sandbox. If
  // we have one, use it unconditionally.
  if (reader) return reader(url);

  // No reader — only allow reads under explicit trust roots.
  if (!trustRoots || trustRoots.length === 0) {
    throw new Error(
      "pilot: no mediaReadFile from runtime and no mediaTrustRoots configured — refusing to read arbitrary path",
    );
  }
  const path = url.startsWith("file://") ? url.slice("file://".length) : url;
  const abs = pathResolve(path);
  const ok = trustRoots.some((root) => {
    const normalizedRoot = pathResolve(root);
    // Path must equal the root or be under it (separator-checked).
    return abs === normalizedRoot || abs.startsWith(normalizedRoot + sep);
  });
  if (!ok) {
    throw new Error(
      `pilot: refused media read for ${abs} — not under any configured trust root`,
    );
  }
  return readFile(abs);
}

function pathFilename(urlish: string): string {
  if (urlish.startsWith("file://")) return basename(urlish.slice("file://".length));
  return basename(urlish);
}

function inferMime(filename: string): string {
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

function classifyMedia(mime: string, _filename: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function stripPort(target: string): string {
  // Accept "addr" or "addr:port"; canonicalize to bare address.
  const m = target.match(/^([0-9]+:[0-9A-Fa-f.]+)(?::\d+)?$/);
  return m ? m[1]! : target;
}

/**
 * Resolve a host-supplied `to` to a pilot address that `transport.send`
 * accepts. Handles:
 *   - already-an-address (with or without :port): stripPort
 *   - bare numeric node_id: synthesise the address (looking up the network
 *     in the peer cache if we've seen this peer inbound, defaulting to 0)
 *   - anything else: undefined → caller refuses the send rather than letting
 *     it fall through to a wire-layer rejection that pollutes the outbox
 */
function resolvePeerAddr(
  to: string,
  peerCache: PeerAddressCache | undefined,
): string | undefined {
  if (isPilotAddress(to)) return stripPort(to);
  if (looksLikeNodeId(to)) {
    // Prefer the cache (knows the network for peers we've seen).
    if (peerCache) return peerCache.resolve(to);
    // Fall back to algorithmic conversion against network 0 — works for
    // every peer in network 0 (the common case) and is harmless if the
    // peer turns out to be elsewhere (the wire send will reject with a
    // more specific error).
    return nodeIdToAddress(to);
  }
  return undefined;
}

// Re-export a constant used in tests + runtime so wire & outbound stay in sync.
export const PILOT_OUTBOUND_WIRE_VERSION = WIRE_VERSION;
