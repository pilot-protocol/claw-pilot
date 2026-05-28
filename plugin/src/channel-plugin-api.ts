// The ChannelPlugin object — the heart of the plugin. Composes outbound,
// directory, status, lifecycle into something openclaw can register.

import type {
  ChannelCapabilities,
  ChannelMeta,
  ChannelPlugin,
  OpenClawConfig,
} from "./openclaw-types.js";

import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { PilotLifecycle } from "./lifecycle.js";
import { buildPilotDirectory } from "./directory.js";
import { buildPilotOutbound } from "./outbound.js";
import { buildPilotMessagingTargetResolver, buildPilotResolver } from "./resolver.js";
import { buildPilotStatus } from "./status.js";
import type { InboundLogger } from "./inbound.js";

export const CHANNEL_ID = "pilot";

export const PILOT_META: ChannelMeta = {
  id: CHANNEL_ID,
  label: "Pilot",
  selectionLabel: "Pilot (overlay DM)",
  docsPath: "/docs/channels/pilot",
  blurb: "DM your claw over the Pilot Protocol overlay — E2E encrypted, no third-party broker.",
  detailLabel: "Pilot Node",
  markdownCapable: true,
};

export const PILOT_CAPABILITIES: ChannelCapabilities = {
  chatTypes: ["direct"],
  edit: false,
  unsend: false,
  reactions: false,
  threads: false,
  groupManagement: false,
  reply: true,
  media: false,
  blockStreaming: false,
};

export type BuildPilotPluginDeps = {
  logger: InboundLogger;
  /** Optional factory override (tests). */
  lifecycle?: PilotLifecycle;
};

export type PilotChannelHandle = {
  plugin: ChannelPlugin;
  lifecycle: PilotLifecycle;
};

/**
 * Construct the channel plugin object plus the lifecycle controller. The
 * controller is exported so the entry's `register(api)` can start/stop it
 * around the openclaw runtime lifecycle.
 */
export function buildPilotChannelPlugin(deps: BuildPilotPluginDeps): PilotChannelHandle {
  const lifecycle = deps.lifecycle ?? new PilotLifecycle({ logger: deps.logger });

  const resolveAccount = (accountId: string | null | undefined) =>
    lifecycle.getResolvedAccount(accountId ?? DEFAULT_ACCOUNT_ID);

  const transport = {
    info: (accountId: string | null | undefined) => lifecycle.getTransportInfo(accountId),
  };

  // ChannelPlugin has ~30 optional fields. We populate what makes sense for a
  // single-DM transport: meta, capabilities, outbound, directory, status,
  // lifecycle. Other adapters (groups, threads, pairing, etc.) are intentionally
  // omitted — openclaw treats absence as "this channel does not support that
  // feature."
  const plugin = {
    id: CHANNEL_ID,
    meta: PILOT_META,
    capabilities: PILOT_CAPABILITIES,
    defaults: {
      queue: { debounceMs: 0 },
    },
    reload: {
      configPrefixes: [`channels.${CHANNEL_ID}`],
    },
    config: {
      // Resolve an account from the openclaw config for a given accountId.
      resolveAccount: (params: { cfg: OpenClawConfig; accountId?: string | null }) => {
        const acc = lifecycle.getResolvedAccount(params.accountId ?? DEFAULT_ACCOUNT_ID);
        return acc ? { accountId: acc.accountId } : undefined;
      },
      // openclaw asks the channel for the set of configured account ids so it
      // can decide what to load. We parse the config the same way lifecycle
      // does and return the names.
      listAccountIds: (params: { cfg: OpenClawConfig }) => {
        const parsed = lifecycle.parseAccounts(params.cfg);
        return Array.from(parsed.keys());
      },
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    },
    outbound: buildPilotOutbound({
      resolveAccount,
      resolveTransport: (accountId) =>
        lifecycle.getAccount(accountId ?? DEFAULT_ACCOUNT_ID)?.transport,
      resolveOutbox: (accountId) =>
        lifecycle.getOutbox(accountId ?? DEFAULT_ACCOUNT_ID),
      resolvePeerCache: (accountId) =>
        lifecycle.getAccount(accountId ?? DEFAULT_ACCOUNT_ID)?.peerAddressCache,
      logger: deps.logger,
    }),
    // Target resolver. openclaw's `message.send` agent tool calls this
    // before routing: any input that isn't `resolved: true` gets rejected
    // with "Unknown target", which is exactly what the agent was hitting
    // before this was registered.
    resolver: buildPilotResolver({
      resolvePeerCache: (accountId) =>
        lifecycle.getAccount(accountId ?? DEFAULT_ACCOUNT_ID)?.peerAddressCache,
    }),
    directory: buildPilotDirectory({ resolveAccount }),
    status: buildPilotStatus({
      resolveAccount,
      getTransportInfo: () => transport.info(DEFAULT_ACCOUNT_ID),
    }),
    lifecycle: {
      // Called by openclaw at gateway startup. The real
      // ChannelLifecycleAdapter doesn't have onActivate/onDeactivate;
      // runStartupMaintenance is the entry point for "do this once when the
      // gateway is starting up." We use it to start per-account transports.
      runStartupMaintenance: async ({ cfg }: { cfg: OpenClawConfig }) => {
        deps.logger.info("pilot channel: startup maintenance", {});
        await lifecycle.startAll(cfg);
      },
      // Fires on a per-account add/edit while openclaw is live.
      onAccountConfigChanged: async ({ nextCfg, accountId }: {
        prevCfg: OpenClawConfig;
        nextCfg: OpenClawConfig;
        accountId: string;
      }) => {
        deps.logger.info("pilot channel: account changed, reloading", { accountId });
        await lifecycle.stopAccount(accountId);
        await lifecycle.startAll(nextCfg);
      },
      onAccountRemoved: async ({ accountId }: { accountId: string }) => {
        deps.logger.info("pilot channel: account removed", { accountId });
        const acct = lifecycle.getAccount(accountId);
        if (acct) {
          acct.pipeline.stop();
          await acct.transport.stop();
        }
      },
    },
    messaging: {
      targetPrefixes: ["pilot:"],
      normalizeTarget: (raw: string) => {
        const stripped = raw.startsWith("pilot:") ? raw.slice("pilot:".length) : raw;
        const trimmed = stripped.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      },
      // The actual hook openclaw's `message.send` agent tool consults
      // per-target. Without this, the resolver chain falls through to
      // `unknownTargetError("Unknown target ... for Pilot")` which the
      // agent catches and rewrites as "image delivery isn't supported."
      // ChannelPlugin.resolver below is the batch surface used by
      // autocomplete / mention search; both need to exist.
      targetResolver: buildPilotMessagingTargetResolver({
        resolvePeerCache: (accountId) =>
          lifecycle.getAccount(accountId ?? DEFAULT_ACCOUNT_ID)?.peerAddressCache,
      }),
    },
  } as unknown as ChannelPlugin;

  return { plugin, lifecycle };
}
