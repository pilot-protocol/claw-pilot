// Inbound pipeline — receives raw datagrams from the transport, enforces the
// allowlist, decodes the wire envelope, reassembles chunked messages, and
// hands the resulting user text (or media) to the openclaw runtime for
// dispatch into the agent.
//
// The actual dispatch is provided by the host runtime (set in `runtime-api.ts`).
// This keeps the inbound pipeline pure for testing: pass in a mock
// `InboundDispatch` and assert it was called with the right contents.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ResolvedPilotAccount } from "./config.js";
import { decideAllowlist } from "./allowlist.js";
import type { PeerAddressCache } from "./peer-address.js";
import type { IncomingDatagram, Transport } from "./transport.js";
import {
  MediaReassembler,
  Reassembler,
  WIRE_VERSION,
  encodeEnvelope,
  verifyEnvelope,
  type MediaKind,
  type UserMessage,
  decodeEnvelope,
} from "./wire.js";

export type InboundMediaAttachment = {
  /** What was sent. */
  media: MediaKind;
  /** Absolute path to the reassembled bytes on local disk. */
  path: string;
  /** Original filename if provided by sender. */
  filename?: string;
  /** Original MIME if provided. */
  mime?: string;
  /** Size in bytes. */
  size: number;
};

export type InboundDispatchInput = {
  accountId: string;
  /** Peer's pilot address (without port). */
  senderAddress: string;
  /** UTF-8 text the user sent (or empty for media-only). */
  text: string;
  /** Wire-envelope id (idempotency key). */
  messageId: string;
  /** Original envelope ts (ms since epoch). */
  timestamp: number;
  /** Attachments accompanying this message. */
  attachments?: InboundMediaAttachment[];
};

/** What we call to actually hand the message to the agent. */
export type InboundDispatch = (msg: InboundDispatchInput) => Promise<void>;

export type InboundLogger = {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

export type InboundDeps = {
  account: ResolvedPilotAccount;
  dispatch: InboundDispatch;
  logger: InboundLogger;
  /** Optional dedup cache: ids seen recently are dropped. */
  recentIds?: Set<string>;
  /** Max age for chunk reassembly state (ms). */
  reassemblyTtlMs?: number;
  /**
   * Where to write reassembled media bytes. Each attachment becomes a file
   * in this dir; openclaw's media subsystem then loads it from the path
   * stored in MsgContext.MediaPath. Default: $TMPDIR/claw-pilot-inbound.
   */
  mediaDir?: string;
  /**
   * Cap for an individual inbound media attachment (bytes). Larger
   * envelopes are dropped with a warning. Default 25 MiB.
   */
  maxMediaBytes?: number;
  /**
   * If set, the pipeline sends an `ack` envelope back to the peer once a
   * message has been fully reassembled (text or media). Lets senders
   * distinguish "delivered to the plugin" from silent drops.
   */
  ackTransport?: Transport;
  /**
   * Called with the peer address (no port) on every well-formed inbound
   * datagram that passes authorization. Wires the outbox drain — the peer
   * being reachable right now is the best signal to retry queued messages.
   * Fires before reassembly, so it includes individual chunks too.
   */
  onPeerProofOfLife?: (peer: string) => void;
  /**
   * Optional. Populated on every inbound `srcAddr` so the outbound
   * adapter can resolve a node_id-form `to` back to the correct network.
   * Without this, outbound coercion defaults to network 0 — fine for the
   * common case but wrong for multi-network deployments.
   */
  peerAddressCache?: PeerAddressCache;
};

export class InboundPipeline {
  private readonly deps: InboundDeps;
  private readonly reassembler = new Reassembler<UserMessage>();
  private readonly mediaReassembler = new MediaReassembler();
  private gcTimer: NodeJS.Timeout | null = null;
  private readonly recent: Set<string>;
  private readonly recentTtlMs = 60_000;
  private recentOrder: Array<{ id: string; ts: number }> = [];
  private readonly mediaDir: string;
  private readonly maxMediaBytes: number;

  constructor(deps: InboundDeps) {
    this.deps = deps;
    this.recent = deps.recentIds ?? new Set();
    this.mediaDir = deps.mediaDir ?? join(tmpdir(), "claw-pilot-inbound");
    this.maxMediaBytes = deps.maxMediaBytes ?? 25 * 1024 * 1024;
    try {
      mkdirSync(this.mediaDir, { recursive: true });
    } catch (e) {
      this.deps.logger.warn("pilot inbound: could not create media dir", {
        dir: this.mediaDir,
        err: (e as Error).message,
      });
    }
  }

  /** Hook into a transport's "datagram" event. */
  attach(transport: { on: (e: "datagram", fn: (dg: IncomingDatagram) => void) => unknown }): void {
    transport.on("datagram", (dg) => {
      // Errors inside handleDatagram are swallowed and logged; we never want a
      // bad packet to take down the recv loop.
      this.handleDatagram(dg).catch((e) => {
        this.deps.logger.error("pilot inbound: handler threw", {
          err: (e as Error).message,
        });
      });
    });

    // Periodic GC for stuck reassembly state.
    this.gcTimer = setInterval(() => {
      this.reassembler.gc(Date.now(), this.deps.reassemblyTtlMs ?? 60_000);
      this.gcRecent();
    }, 30_000);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
  }

  async handleDatagram(dg: IncomingDatagram): Promise<void> {
    // Trace EVERY datagram that comes off the transport. Single info line
    // per inbound so production logs stay readable but ops can confirm
    // packets are arriving at the plugin layer.
    this.deps.logger.info("pilot inbound: datagram", {
      srcAddr: dg.srcAddr,
      srcPort: dg.srcPort,
      dstPort: dg.dstPort,
      size: dg.data.length,
    });

    let env: ReturnType<typeof decodeEnvelope>;
    try {
      env = decodeEnvelope(dg.data);
    } catch (e) {
      this.deps.logger.warn("pilot inbound: dropped — bad envelope", {
        srcAddr: dg.srcAddr,
        err: (e as Error).message,
        size: dg.data.length,
      });
      return;
    }
    this.deps.logger.info("pilot inbound: decoded envelope", {
      kind: env.kind,
      id: env.id,
      hasHmac: !!(env as { hmac?: string }).hmac,
    });

    // Authorization: HMAC bypasses allowlist when configured. Allowlist is the
    // fallback / defense-in-depth.
    let peer = dg.srcAddr;
    const hmacOK = this.deps.account.sharedSecret
      ? await verifyEnvelope(env, this.deps.account.sharedSecret)
      : false;
    if (!hmacOK) {
      const decision = decideAllowlist(dg.srcAddr, this.deps.account.allowlist);
      if (!decision.allowed) {
        this.deps.logger.warn("pilot inbound: dropped — not allowed", {
          srcAddr: dg.srcAddr,
          reason: decision.reason,
          hadSecret: !!this.deps.account.sharedSecret,
        });
        return;
      }
      peer = decision.peer;
    } else {
      // Strip any port suffix for consistent logging / dispatch.
      const colonIdx = peer.lastIndexOf(":");
      if (colonIdx > 0 && /^\d+$/.test(peer.slice(colonIdx + 1))) {
        peer = peer.slice(0, colonIdx);
      }
      this.deps.logger.debug?.("pilot inbound: HMAC verified — bypassing allowlist", {
        srcAddr: peer,
        id: env.id,
      });
    }

    // Peer just sent us a well-formed, authorized datagram — they're alive.
    // Trigger any outbox drain queued for them. Fires for control envelopes
    // (ack/error) too because those are equally good proof of life.
    try {
      this.deps.onPeerProofOfLife?.(peer);
    } catch (e) {
      this.deps.logger.warn("pilot inbound: onPeerProofOfLife threw", {
        peer,
        err: (e as Error).message,
      });
    }

    // Remember (nodeId → network) so outbound calls that arrive with a
    // bare node_id `to` (openclaw's reply routing sometimes does this)
    // can be coerced back to the right address.
    this.deps.peerAddressCache?.remember(peer);

    if (env.kind === "ack" || env.kind === "error") {
      // Out of scope for v0 — log and drop.
      this.deps.logger.debug?.("pilot inbound: control envelope", {
        kind: env.kind,
        id: env.id,
      });
      return;
    }

    if (env.kind === "media") {
      await this.handleMedia(env, peer);
      return;
    }

    if (env.kind !== "user") {
      this.deps.logger.warn("pilot inbound: dropped — unexpected kind", {
        kind: env.kind,
      });
      return;
    }

    if (this.recent.has(env.id)) {
      this.deps.logger.debug?.("pilot inbound: dropped duplicate", { id: env.id });
      return;
    }

    const reassembled = this.reassembler.push(env);
    if (!reassembled) return; // waiting for more chunks

    this.recent.add(reassembled.id);
    this.recentOrder.push({ id: reassembled.id, ts: Date.now() });

    // Send the ack BEFORE dispatching to the agent. The dispatch call
    // walks `dispatchReplyFromConfig` which runs the full agent turn
    // (model call + tools, often 10–30s+ even on the happy path). If
    // the agent hangs on a broken upstream tool — as it can — the ack
    // would never fire, the sender's bubble would stay "sending"
    // forever, and the user reads that as "my message didn't arrive."
    // The ack means "the channel received and accepted your envelope,"
    // not "the agent has replied." Decoupling them removes a whole
    // class of UI mystery.
    void this.sendAck(reassembled.id, peer);

    try {
      await this.deps.dispatch({
        accountId: this.deps.account.accountId,
        senderAddress: peer,
        text: reassembled.text,
        messageId: reassembled.id,
        timestamp: reassembled.ts,
      });
    } catch (e) {
      this.deps.logger.error("pilot inbound: dispatch failed", {
        id: reassembled.id,
        err: (e as Error).message,
      });
    }
  }

  private async handleMedia(
    env: Extract<ReturnType<typeof decodeEnvelope>, { kind: "media" }>,
    peer: string,
  ): Promise<void> {
    if (env.totalBytes !== undefined && env.totalBytes > this.maxMediaBytes) {
      this.deps.logger.warn("pilot inbound: media exceeds cap", {
        id: env.id,
        totalBytes: env.totalBytes,
        max: this.maxMediaBytes,
      });
      return;
    }
    if (this.recent.has(env.id)) {
      this.deps.logger.debug?.("pilot inbound: dropped duplicate media", { id: env.id });
      return;
    }
    const out = this.mediaReassembler.push(env);
    if (!out) return; // waiting for more chunks

    if (out.bytes.length > this.maxMediaBytes) {
      this.deps.logger.warn("pilot inbound: reassembled media exceeds cap", {
        id: out.id,
        size: out.bytes.length,
      });
      return;
    }

    this.recent.add(out.id);
    this.recentOrder.push({ id: out.id, ts: Date.now() });

    const safeName = sanitizeFilename(out.filename, out.media, out.id);
    const path = join(this.mediaDir, `${out.id}-${safeName}`);
    try {
      writeFileSync(path, out.bytes);
    } catch (e) {
      this.deps.logger.error("pilot inbound: media write failed", {
        id: out.id,
        path,
        err: (e as Error).message,
      });
      return;
    }

    const attachment: InboundMediaAttachment = {
      media: out.media,
      path,
      filename: out.filename,
      mime: out.mime,
      size: out.bytes.length,
    };

    // Ack-before-dispatch — same reasoning as the text path. See the
    // comment in handleDatagram above.
    void this.sendAck(out.id, peer);

    try {
      await this.deps.dispatch({
        accountId: this.deps.account.accountId,
        senderAddress: peer,
        text: out.caption ?? "",
        messageId: out.id,
        timestamp: out.ts,
        attachments: [attachment],
      });
    } catch (e) {
      this.deps.logger.error("pilot inbound: media dispatch failed", {
        id: out.id,
        err: (e as Error).message,
      });
    }
  }

  /** Send a delivery ack back to the peer. Best-effort; failures are logged. */
  private async sendAck(messageId: string, peer: string): Promise<void> {
    if (!this.deps.ackTransport) return;
    try {
      const buf = encodeEnvelope({
        v: WIRE_VERSION,
        kind: "ack",
        id: messageId,
        ts: Date.now(),
      });
      await this.deps.ackTransport.send(peer, this.deps.account.appPort, buf);
    } catch (e) {
      this.deps.logger.debug?.("pilot inbound: ack send failed", {
        id: messageId,
        err: (e as Error).message,
      });
    }
  }

  private gcRecent(): void {
    const cutoff = Date.now() - this.recentTtlMs;
    while (this.recentOrder.length > 0 && this.recentOrder[0]!.ts < cutoff) {
      const stale = this.recentOrder.shift()!;
      this.recent.delete(stale.id);
    }
  }
}

/**
 * Strip directory traversal characters and pick a sane extension from media
 * kind if the sender didn't provide one. Required because we write to disk
 * with a name partly under sender control.
 */
function sanitizeFilename(
  raw: string | undefined,
  media: MediaKind,
  fallbackId: string,
): string {
  const cleanRaw = (raw ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  if (cleanRaw.length > 0 && /[.][a-zA-Z0-9]{1,8}$/.test(cleanRaw)) return cleanRaw;
  const ext =
    media === "image" ? ".bin" : media === "audio" ? ".aud" : ".bin";
  return `${cleanRaw || fallbackId}${ext}`;
}

