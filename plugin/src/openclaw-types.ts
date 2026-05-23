// Type bridge to openclaw's plugin-sdk.
//
// The public `openclaw/plugin-sdk/core` re-export surface includes most of
// what we need (ChannelMeta, ChannelCapabilities, ChannelOutboundAdapter,
// ChannelPlugin, definePluginEntry, etc.). The remaining adapters
// (ChannelDirectoryAdapter, ChannelStatusAdapter, OutboundDeliveryResult,
// PluginRuntimeLifecycleRegistration) are not in the published re-export,
// so we declare minimal stand-ins here. Where openclaw exposes a richer type
// at runtime, we coerce via `as unknown as <real type>` at the boundaries.

export type {
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  ChannelDirectoryEntry,
  ChannelMessagingAdapter,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginLogger,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";

export type { ChannelCapabilities } from "openclaw/plugin-sdk";

export { definePluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";

// ---------------------------------------------------------------------------
// Local stand-ins — minimal shapes used at the type level.
// ---------------------------------------------------------------------------

export type OutboundDeliveryResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: Error };

export type ChannelDirectoryAdapter = {
  listEntries?: (params: {
    accountId?: string | null;
  }) => Promise<Array<{ kind: "direct" | "group" | "channel"; id: string; label?: string }>>;
  resolveTarget?: (params: {
    accountId?: string | null;
    query: string;
  }) => Promise<
    | { ok: true; kind: "direct" | "group" | "channel"; id: string; label?: string }
    | { ok: false; reason: string }
  >;
};

export type ChannelStatusAdapter<A = unknown, P = unknown, U = unknown> = {
  summarize: (params: { accountId?: string | null }) => {
    configured: boolean;
    enabled: boolean;
    state: "ok" | "disabled" | "missing" | "starting" | "error";
    detail?: string;
  };
  // Underscores keep the generics in scope so callers can specialize.
  _accountTypeHint?: A;
  _probeTypeHint?: P;
  _auditTypeHint?: U;
};

export type ChannelLifecycleAdapter = {
  onActivate?: (params: { cfg: import("openclaw/plugin-sdk/core").OpenClawConfig }) => Promise<void> | void;
  onDeactivate?: () => Promise<void> | void;
  onReload?: (params: {
    cfg: import("openclaw/plugin-sdk/core").OpenClawConfig;
  }) => Promise<void> | void;
};

export type PluginRuntimeLifecycleRegistration = {
  onShutdown?: () => Promise<void> | void;
  onActivate?: () => Promise<void> | void;
  onDeactivate?: () => Promise<void> | void;
};
