// Runtime singleton — openclaw calls setPilotRuntime(rt) once at boot and the
// rest of the plugin reads from here. Matches the setIrcRuntime / setTelegramRuntime
// pattern used by the bundled channel plugins.

import type { PluginRuntime } from "./openclaw-types.js";

import type { InboundDispatch } from "./inbound.js";
import type { ResolvedPilotAccount } from "./config.js";
import type { Outbox } from "./outbox.js";
import type { Transport } from "./transport.js";

/**
 * Per-account runtime context. The transport + outbox are what lets the
 * inbound dispatch's ReplyDispatcher actually send the agent's reply back
 * to the peer — without them openclaw's embedded reply lane has nowhere
 * to deliver the result.
 */
export type AccountRuntimeContext = {
  account: ResolvedPilotAccount;
  transport: Transport;
  outbox?: Outbox;
};

export type PilotRuntime = {
  /** Generic plugin runtime from the host. */
  host: PluginRuntime;
  /** Build a dispatch closure bound to a specific account's live transport. */
  buildDispatch: (ctx: AccountRuntimeContext) => InboundDispatch;
};

let _runtime: PilotRuntime | null = null;

export function setPilotRuntime(rt: PilotRuntime): void {
  _runtime = rt;
}

export function getPilotRuntime(): PilotRuntime | null {
  return _runtime;
}

export function resetPilotRuntimeForTests(): void {
  _runtime = null;
}
