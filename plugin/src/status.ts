// Status adapter — surfaces `openclaw status` and `openclaw channels list`
// output for the pilot channel. Reports whether the daemon is reachable and
// who's in the allowlist.

import type { ChannelStatusAdapter } from "./openclaw-types.js";

import type { ResolvedPilotAccount } from "./config.js";
import type { TransportInfo } from "./transport.js";

export type StatusDeps = {
  resolveAccount: (accountId: string | null | undefined) => ResolvedPilotAccount | undefined;
  /** Returns the live transport info if started, else null. */
  getTransportInfo: () => TransportInfo | null;
};

export function buildPilotStatus(deps: StatusDeps): ChannelStatusAdapter {
  return {
    summarize: ({ accountId }) => {
      const account = deps.resolveAccount(accountId ?? null);
      if (!account) {
        return { configured: false, enabled: false, state: "missing", detail: "no account" };
      }
      const info = deps.getTransportInfo();
      if (!account.enabled) {
        return { configured: true, enabled: false, state: "disabled", detail: "disabled in config" };
      }
      if (!info) {
        return { configured: true, enabled: true, state: "starting", detail: "pilot transport not started" };
      }
      const peerCount = account.allowlist.size;
      return {
        configured: true,
        enabled: true,
        state: "ok",
        detail: `addr=${info.address} node_id=${info.nodeId} peers=${peerCount}`,
      };
    },
  };
}
