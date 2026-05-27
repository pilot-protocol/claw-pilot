// Address ↔ node_id conversion for the Pilot overlay.
//
// Pilot addresses are formatted `N:NNNN.HHHH.LLLL` where:
//   - N is the 16-bit network id
//   - NNNN.HHHH.LLLL is the 48-bit node id in big-endian hex with `.`s
//     between 16-bit groups
//
// Every address therefore *contains* its node_id — the conversion is pure
// arithmetic, no daemon round-trip required.
//
// Why this exists: openclaw's reply routing sometimes hands the channel
// `ctx.to` as a node_id string (e.g. `"211747"`) instead of an address.
// Without this helper, `transport.send` rejects with `invalid address` and
// every chunk falls into the outbox, where it sits forever because the
// outbox key is the same bad numeric peer string. This module coerces the
// numeric form back to the address form so the send actually goes through.

/** Stable wire address format that `transport.send` accepts. */
const ADDRESS_RE = /^(\d+):([0-9A-Fa-f]{4})\.([0-9A-Fa-f]{4})\.([0-9A-Fa-f]{4})(?::\d+)?$/;

/** Pure node_id strings the agent might pass in `ctx.to`. */
const NUMERIC_RE = /^\d+$/;

export function isPilotAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}

export function looksLikeNodeId(s: string): boolean {
  return NUMERIC_RE.test(s);
}

/**
 * Algorithmic conversion. Returns `undefined` if the input isn't a
 * representable node_id (negative, NaN, or larger than 48 bits — overlay
 * cap).
 */
export function nodeIdToAddress(nodeId: number | string | bigint, network = 0): string | undefined {
  let n: bigint;
  try {
    n = typeof nodeId === "bigint" ? nodeId : BigInt(nodeId as number | string);
  } catch {
    return undefined;
  }
  if (n < 0n) return undefined;
  if (n >= (1n << 48n)) return undefined;
  const high = Number((n >> 32n) & 0xffffn);
  const mid = Number((n >> 16n) & 0xffffn);
  const low = Number(n & 0xffffn);
  return `${network}:${pad4(high)}.${pad4(mid)}.${pad4(low)}`;
}

export function addressToNodeId(addr: string): { nodeId: number; network: number } | undefined {
  const m = addr.match(ADDRESS_RE);
  if (!m) return undefined;
  const network = parseInt(m[1]!, 10);
  const high = parseInt(m[2]!, 16);
  const mid = parseInt(m[3]!, 16);
  const low = parseInt(m[4]!, 16);
  const nodeId = (BigInt(high) << 32n) | (BigInt(mid) << 16n) | BigInt(low);
  // Safe to coerce to Number — 48 bits fits in JS number's 53-bit integer range.
  return { nodeId: Number(nodeId), network };
}

function pad4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Tracks the network each peer is on, so that when we get a bare node_id from
 * the host and want to send to it, we use the right network prefix rather
 * than defaulting to 0.
 *
 * Populated on every inbound datagram (we know the full address from
 * `srcAddr`); read on every outbound that needs coercion.
 */
export class PeerAddressCache {
  private readonly networkByNodeId = new Map<number, number>();

  /** Record a peer address we observed inbound. Cheap; idempotent. */
  remember(addr: string): void {
    const parsed = addressToNodeId(addr);
    if (!parsed) return;
    this.networkByNodeId.set(parsed.nodeId, parsed.network);
  }

  /**
   * Has this node_id ever been recorded? Lets callers distinguish "seen
   * inbound and trustworthy" from "we'd be guessing the network." The
   * resolver uses this to reject targets the agent can't possibly be
   * referring to legitimately.
   */
  has(nodeId: number): boolean {
    return this.networkByNodeId.has(nodeId);
  }

  /**
   * Resolve a `to` value that might be either an address or a bare node_id.
   * Returns:
   *   - the input unchanged if it's already an address
   *   - the synthesised address if it's a numeric node_id we can resolve (or
   *     fall back to network 0 for if we haven't seen it before)
   *   - undefined if it's neither
   */
  resolve(to: string): string | undefined {
    if (isPilotAddress(to)) return to;
    if (looksLikeNodeId(to)) {
      const nodeId = Number(to);
      const network = this.networkByNodeId.get(nodeId) ?? 0;
      return nodeIdToAddress(nodeId, network);
    }
    return undefined;
  }
}
