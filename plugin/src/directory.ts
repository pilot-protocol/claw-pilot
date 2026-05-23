// Directory adapter — maps free-form text targets to canonical pilot
// addresses, so users (and the agent) can say `pilot:phone` instead of
// the full 48-bit address. v0 keeps it minimal: only the configured
// allowlist entries are resolvable.

import type { ChannelDirectoryAdapter } from "./openclaw-types.js";

import { isValidPilotAddress } from "./config.js";
import type { ResolvedPilotAccount } from "./config.js";

export function buildPilotDirectory(deps: {
  resolveAccount: (accountId: string | null | undefined) => ResolvedPilotAccount | undefined;
}): ChannelDirectoryAdapter {
  return {
    listEntries: async ({ accountId }: { accountId?: string | null }) => {
      const acct = deps.resolveAccount(accountId ?? null);
      if (!acct) return [];
      return [...acct.allowlist].map((addr) => ({
        kind: "direct" as const,
        id: addr,
        label: addr,
      }));
    },
    resolveTarget: async ({ accountId, query }: { accountId?: string | null; query: string }) => {
      const acct = deps.resolveAccount(accountId ?? null);
      if (!acct) return { ok: false as const, reason: "account-not-configured" };
      const q = query.trim();
      if (isValidPilotAddress(q) && acct.allowlist.has(q)) {
        return { ok: true as const, kind: "direct" as const, id: q, label: q };
      }
      return { ok: false as const, reason: "not-in-allowlist" };
    },
  };
}
