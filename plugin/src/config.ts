// Plugin-side config types and resolution.
//
// The schema is declared in openclaw.plugin.json; here we just give it a
// TypeScript shape and provide a resolver that reads the active openclaw
// config to find the configured account.

export type PilotAccountConfig = {
  name?: string;
  enabled?: boolean;
  socketPath?: string;
  allowlist: string[];
  appPort?: number;
  handshakeTrustAutoApprove?: boolean;
  /**
   * Optional shared secret. If set, an inbound envelope with a matching
   * HMAC-SHA256 bypasses the pilot-address allowlist. Lets you authorize
   * "anyone with the password" without pinning identities — useful when iOS
   * profiles generate fresh identities and the allowlist would otherwise
   * need constant updates.
   */
  sharedSecret?: string;
};

export const DEFAULT_SOCKET_PATH = "/tmp/pilot.sock";
export const DEFAULT_APP_PORT = 7777;
export const DEFAULT_ACCOUNT_ID = "default";

export type ResolvedPilotAccount = {
  accountId: string;
  enabled: boolean;
  socketPath: string;
  allowlist: ReadonlySet<string>;
  appPort: number;
  handshakeTrustAutoApprove: boolean;
  /** Set iff the operator configured a shared secret on this account. */
  sharedSecret: string | undefined;
};

export function resolveAccount(
  raw: PilotAccountConfig,
  accountId: string = DEFAULT_ACCOUNT_ID,
): ResolvedPilotAccount {
  const hasAllowlist = Array.isArray(raw.allowlist) && raw.allowlist.length > 0;
  const hasSecret = typeof raw.sharedSecret === "string" && raw.sharedSecret.length > 0;
  if (!hasAllowlist && !hasSecret) {
    throw new Error(
      `pilot channel account '${accountId}' requires either an allowlist entry or a sharedSecret`,
    );
  }
  if (hasAllowlist) {
    for (const entry of raw.allowlist) {
      if (!isValidPilotAddress(entry)) {
        throw new Error(
          `pilot channel account '${accountId}' has invalid allowlist entry: ${entry}`,
        );
      }
    }
  }
  if (hasSecret && (raw.sharedSecret as string).length < 16) {
    throw new Error(
      `pilot channel account '${accountId}' sharedSecret must be at least 16 characters`,
    );
  }
  return {
    accountId,
    enabled: raw.enabled !== false,
    socketPath: raw.socketPath ?? DEFAULT_SOCKET_PATH,
    allowlist: new Set(raw.allowlist ?? []),
    appPort: raw.appPort ?? DEFAULT_APP_PORT,
    handshakeTrustAutoApprove: raw.handshakeTrustAutoApprove !== false,
    sharedSecret: hasSecret ? raw.sharedSecret : undefined,
  };
}

const PILOT_ADDR_RE = /^[0-9]+:[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/;

export function isValidPilotAddress(addr: string): boolean {
  return typeof addr === "string" && PILOT_ADDR_RE.test(addr);
}

/** Strip an optional `:PORT` suffix from a pilot address-with-port. */
export function pilotAddrBase(addrWithMaybePort: string): string {
  const lastColon = addrWithMaybePort.lastIndexOf(":");
  if (lastColon < 0) return addrWithMaybePort;
  const tail = addrWithMaybePort.slice(lastColon + 1);
  if (/^\d+$/.test(tail) && tail.length <= 5) {
    return addrWithMaybePort.slice(0, lastColon);
  }
  return addrWithMaybePort;
}
