// Allowlist gate — the only thing standing between a stranger's pilot peer
// and the agent. The Pilot trust handshake already proved the sender is who
// they claim (X25519 + Ed25519); we just enforce *who is allowed at all*.

import { canonicalPilotAddr, pilotAddrBase } from "./config.js";

export type AllowlistDecision =
  | { allowed: true; peer: string }
  | { allowed: false; reason: "not-in-allowlist" | "malformed-src" };

export function decideAllowlist(
  rawSrcAddr: string | undefined,
  allowlist: ReadonlySet<string>,
): AllowlistDecision {
  if (!rawSrcAddr || typeof rawSrcAddr !== "string") {
    return { allowed: false, reason: "malformed-src" };
  }
  // The address grammar accepts hex in either case, so compare on the
  // canonical form. `resolveAccount` already canonicalizes the configured
  // set; the fallback scan covers sets assembled by other callers.
  const peer = canonicalPilotAddr(pilotAddrBase(rawSrcAddr));
  if (!allowlist.has(peer)) {
    let found = false;
    for (const entry of allowlist) {
      if (canonicalPilotAddr(entry) === peer) {
        found = true;
        break;
      }
    }
    if (!found) return { allowed: false, reason: "not-in-allowlist" };
  }
  return { allowed: true, peer };
}
