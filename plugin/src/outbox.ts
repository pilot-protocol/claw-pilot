// Outbox — per-peer persistent queue for outbound envelopes that couldn't be
// delivered immediately (e.g. iOS phone is asleep, app backgrounded, NAT path
// blip). When `transport.send` fails the caller stashes the encoded envelope
// bytes here, and a drain pass retries them later — on a timer, on the next
// inbound packet from that peer (proof of life), or via an explicit
// `drain(peer)` call.
//
// Design choices:
//   • Keyed by peer pilot address (without port) — every chunk for a given
//     peer-and-id collapses into one outbox slot.
//   • Persisted to a single JSON file atomically (write-temp + rename) so a
//     crash mid-write doesn't corrupt the queue.
//   • Bounded: per-peer ring of N entries (default 256). Newer entries
//     evict older ones (FIFO) so a peer that's been offline for a week
//     doesn't keep an unbounded backlog.
//   • TTL: entries older than ttlMs (default 24h) are dropped on the next
//     drain. Stale messages aren't useful and may confuse the recipient.
//   • No retry counter — we keep retrying on the schedule until success or
//     TTL/cap eviction. Loud retries waste battery but stay correct.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OutboxEntry = {
  /** Wire envelope id (idempotency key — same as messageId on send). */
  id: string;
  /** Optional chunk index for multi-chunk envelopes; uniquely identifies the bytes. */
  seq?: number;
  /** App port (e.g. 7777) — passed to transport.send. */
  port: number;
  /** Encoded envelope as base64. We serialize bytes through JSON. */
  dataB64: string;
  /** Unix ms when queued. Used for TTL eviction. */
  queuedAt: number;
  /** Last delivery attempt timestamp (0 = never tried). */
  lastAttemptAt: number;
  /** Number of failed attempts (informational only). */
  attempts: number;
};

export type OutboxOptions = {
  /** Absolute path to the JSON file. Required. */
  path: string;
  /** Per-peer entry cap. Defaults to 256. */
  maxPerPeer?: number;
  /** Max age (ms) before an entry is evicted on drain. Default 24h. */
  ttlMs?: number;
};

export type Sender = (peerAddr: string, port: number, data: Buffer) => Promise<void>;

export type DrainResult = {
  peer: string;
  sent: number;
  failed: number;
  evictedExpired: number;
  remaining: number;
};

type Persisted = {
  version: 1;
  peers: Record<string, OutboxEntry[]>;
};

export class Outbox {
  private readonly path: string;
  private readonly maxPerPeer: number;
  private readonly ttlMs: number;
  private peers: Map<string, OutboxEntry[]> = new Map();

  constructor(opts: OutboxOptions) {
    this.path = opts.path;
    this.maxPerPeer = opts.maxPerPeer ?? 256;
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      // best-effort; if mkdir fails we'll fail loudly on first save
    }
    this.load();
  }

  /** Test/runtime visibility — total queued entries across peers. */
  size(): number {
    let n = 0;
    for (const list of this.peers.values()) n += list.length;
    return n;
  }

  /** Peers with at least one queued entry. */
  pendingPeers(): string[] {
    const out: string[] = [];
    for (const [p, list] of this.peers) if (list.length > 0) out.push(p);
    return out;
  }

  /** Entries for a given peer, in queue order. Mostly for tests/inspection. */
  forPeer(peer: string): readonly OutboxEntry[] {
    return this.peers.get(peer) ?? [];
  }

  /**
   * Stash an outbound envelope for a peer. Persisted before returning.
   * The dedup rule is (id, seq): re-enqueuing the same (id, seq) for a
   * peer is a no-op (e.g. the caller retried the same chunk).
   */
  enqueue(peer: string, entry: Omit<OutboxEntry, "queuedAt" | "lastAttemptAt" | "attempts">): void {
    const list = this.peers.get(peer) ?? [];
    const dup = list.find((e) => e.id === entry.id && e.seq === entry.seq);
    if (dup) return;
    const full: OutboxEntry = {
      ...entry,
      queuedAt: Date.now(),
      lastAttemptAt: 0,
      attempts: 0,
    };
    list.push(full);
    // Cap-evict oldest. We never want a runaway outbox for a peer that's
    // been offline forever.
    while (list.length > this.maxPerPeer) list.shift();
    this.peers.set(peer, list);
    this.save();
  }

  /**
   * Attempt to send every queued entry for `peer` using `send`. On success
   * the entry is removed. On failure it stays for next drain. Expired
   * entries are evicted before sending. Returns a small summary.
   */
  async drain(peer: string, send: Sender): Promise<DrainResult> {
    const list = this.peers.get(peer);
    const result: DrainResult = { peer, sent: 0, failed: 0, evictedExpired: 0, remaining: 0 };
    if (!list || list.length === 0) return result;

    const now = Date.now();
    const survive: OutboxEntry[] = [];

    for (const entry of list) {
      // TTL check first — drop stale messages before bothering the network.
      if (now - entry.queuedAt > this.ttlMs) {
        result.evictedExpired++;
        continue;
      }
      try {
        const data = Buffer.from(entry.dataB64, "base64");
        await send(peer, entry.port, data);
        result.sent++;
      } catch {
        entry.lastAttemptAt = now;
        entry.attempts++;
        survive.push(entry);
        result.failed++;
      }
    }

    if (survive.length === 0) this.peers.delete(peer);
    else this.peers.set(peer, survive);
    result.remaining = survive.length;
    this.save();
    return result;
  }

  /** Drain every peer in the queue. Used by the periodic retry tick. */
  async drainAll(send: Sender): Promise<DrainResult[]> {
    const results: DrainResult[] = [];
    for (const peer of [...this.peers.keys()]) {
      results.push(await this.drain(peer, send));
    }
    return results;
  }

  // ───── persistence ───────────────────────────────────────────────────

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // Missing file = empty outbox; not an error.
      return;
    }
    let parsed: Persisted;
    try {
      parsed = JSON.parse(raw) as Persisted;
    } catch {
      // Corrupt file — start fresh rather than crash. We'd rather drop the
      // backlog than refuse to boot.
      return;
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.peers !== "object") return;
    for (const [peer, entries] of Object.entries(parsed.peers)) {
      if (Array.isArray(entries)) this.peers.set(peer, entries);
    }
  }

  private save(): void {
    const data: Persisted = { version: 1, peers: {} };
    for (const [peer, list] of this.peers) data.peers[peer] = list;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
