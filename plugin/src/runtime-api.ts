// Runtime singleton — openclaw calls setPilotRuntime(rt) once at boot and the
// rest of the plugin reads from here. Matches the setIrcRuntime / setTelegramRuntime
// pattern used by the bundled channel plugins.

import type { PluginRuntime } from "./openclaw-types.js";

import type { InboundDispatch } from "./inbound.js";
import type { ResolvedPilotAccount } from "./config.js";

export type PilotRuntime = {
  /** Generic plugin runtime from the host. */
  host: PluginRuntime;
  /** Build a dispatch closure bound to a specific account. */
  buildDispatch: (account: ResolvedPilotAccount) => InboundDispatch;
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
