// ChannelResolverAdapter — the hook openclaw's `message.send` tool calls to
// validate / canonicalise a target string before routing the send. Without
// it, the agent's tool gets `Unknown target "0:0000.0003.3B23" for Pilot`
// and the agent gives up + tells the user "image delivery isn't supported."
//
// For us, a target is a pilot address (`N:NNNN.HHHH.LLLL`) or a bare
// node_id we can resolve via PeerAddressCache (same logic the OutboundAdapter
// uses for the openclaw-passes-node_id case). Group targets aren't a thing
// for the pilot channel — single-DM only.

import { isPilotAddress, looksLikeNodeId, PeerAddressCache } from "./peer-address.js";

/** Kind of target the agent is asking us to resolve. */
export type ChannelResolveKind = "user" | "group";

/** Shape openclaw expects back per input target. */
export type ChannelResolveResult = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

export type ResolverDeps = {
  /**
   * Returns the per-account cache so non-zero-network peers we've seen
   * inbound resolve to the right address. The OutboundAdapter uses the
   * same one; sharing keeps `message.send` and `dispatchReplyFromConfig`
   * routing consistent.
   */
  resolvePeerCache: (accountId: string | null | undefined) => PeerAddressCache | undefined;
};

/**
 * Returns the adapter object openclaw expects on
 * `ChannelPlugin.resolver.resolveTargets`. The implementation mirrors the
 * OutboundAdapter's coercion: address-form passes through, numeric node_id
 * gets translated via the peer cache or via algorithmic decomposition
 * defaulting to network 0.
 */
export function buildPilotResolver(deps: ResolverDeps): {
  resolveTargets: (params: {
    accountId?: string | null;
    inputs: string[];
    kind: ChannelResolveKind;
  }) => Promise<ChannelResolveResult[]>;
} {
  return {
    async resolveTargets({ accountId, inputs, kind }) {
      if (kind === "group") {
        // Pilot is single-DM. Be honest rather than silently failing.
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "pilot channel only supports direct messages (no groups)",
        }));
      }
      const cache = deps.resolvePeerCache(accountId ?? null);
      return inputs.map((rawInput) => {
        const input = rawInput.trim();
        if (input.length === 0) {
          return { input: rawInput, resolved: false, note: "empty target" };
        }
        // Strip the `pilot:` provider prefix the agent might add — same shape
        // we accept in our messaging.normalizeTarget hook.
        const stripped = input.startsWith("pilot:") ? input.slice("pilot:".length).trim() : input;
        // Also strip a trailing `:port` if present — `transport.send` does the
        // same; targets stay address-only on the resolver surface.
        const addrOnly = stripped.replace(/(:\d+)$/, "");

        if (isPilotAddress(addrOnly)) {
          return {
            input: rawInput,
            resolved: true,
            id: addrOnly,
            name: addrOnly,
          };
        }
        if (looksLikeNodeId(addrOnly)) {
          const nodeId = Number(addrOnly);
          // Only treat as resolved if we've actually seen this peer inbound.
          // PeerAddressCache.resolve() will happily synthesise a network-0
          // address for any numeric input — fine for OutboundAdapter
          // (matches the agent's expectation when the address is right),
          // but for `message.send` resolution we want STRONGER semantics:
          // "I can confirm this peer exists." Use has() to check.
          if (cache?.has(nodeId)) {
            const fromCache = cache.resolve(addrOnly);
            if (fromCache) {
              return {
                input: rawInput,
                resolved: true,
                id: fromCache,
                name: fromCache,
                note: "resolved from node_id",
              };
            }
          }
          return {
            input: rawInput,
            resolved: false,
            note: "node_id not seen inbound from this account — send a message from that peer first, or use the full N:NNNN.HHHH.LLLL form",
          };
        }
        return {
          input: rawInput,
          resolved: false,
          note: "target must be a pilot address (N:NNNN.HHHH.LLLL) or a known node_id",
        };
      });
    },
  };
}
