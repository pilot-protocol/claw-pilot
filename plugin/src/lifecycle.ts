// Lifecycle adapter — boots one PilotTransport per enabled account, attaches
// the InboundPipeline, and tears down on shutdown.

import { homedir } from "node:os";
import { join } from "node:path";

import type { OpenClawConfig } from "./openclaw-types.js";

import type { PilotAccountConfig, ResolvedPilotAccount } from "./config.js";
import { DEFAULT_ACCOUNT_ID, resolveAccount } from "./config.js";
import { InboundPipeline, type InboundLogger } from "./inbound.js";
import { Outbox } from "./outbox.js";
import { getPilotRuntime } from "./runtime-api.js";
import type { Transport, TransportInfo } from "./transport.js";

// Lazy-imported so the module loads even if `pilotprotocol` isn't present at
// process boot. The transport is only constructed when an account actually
// starts, by which point an install error would already have logged.
async function loadDefaultTransport(socketPath?: string): Promise<Transport> {
  const mod = (await import("./pilot-transport.js")) as typeof import("./pilot-transport.js");
  return new mod.PilotTransport({ socketPath });
}

/** Per-account live state. */
export type AccountState = {
  account: ResolvedPilotAccount;
  transport: Transport;
  pipeline: InboundPipeline;
  info: TransportInfo | null;
  outbox: Outbox;
  drainTimer: NodeJS.Timeout | null;
};

export type LifecycleDeps = {
  logger: InboundLogger;
  /**
   * Factory for creating a transport. Defaulted to PilotTransport; tests
   * inject a FakeTransport.
   */
  createTransport?: (opts: { socketPath?: string }) => Transport;
  /**
   * Where to place per-account outbox JSON files. Defaults to
   * `~/.openclaw/plugins/claw-pilot`. Tests override.
   */
  outboxDir?: string;
  /**
   * Periodic drain interval (ms). Defaults to 30s. Tests can shorten.
   */
  outboxDrainIntervalMs?: number;
};

export class PilotLifecycle {
  private readonly deps: LifecycleDeps;
  private readonly accounts = new Map<string, AccountState>();
  /**
   * Most recent openclaw.json the lifecycle was started with. Plumbed into
   * the dispatch closure so openclaw's reply pipeline receives the user's
   * configured model (anthropic/...) instead of falling back to the
   * compiled-in `openai/gpt-5.5` default.
   */
  private currentCfg: OpenClawConfig | undefined;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  /** Returns the most recent openclaw config the lifecycle saw. */
  getCurrentCfg(): OpenClawConfig | undefined {
    return this.currentCfg;
  }

  /** Read raw config from openclaw config, return parsed accounts. */
  parseAccounts(cfg: OpenClawConfig): Map<string, ResolvedPilotAccount> {
    const out = new Map<string, ResolvedPilotAccount>();
    const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
    const pilotSection = channels["pilot"] as
      | { accounts?: Record<string, PilotAccountConfig> }
      | PilotAccountConfig
      | undefined;
    if (!pilotSection) return out;

    if ("accounts" in pilotSection && pilotSection.accounts) {
      for (const [id, raw] of Object.entries(pilotSection.accounts)) {
        try {
          out.set(id, resolveAccount(raw, id));
        } catch (e) {
          this.deps.logger.error("pilot: invalid account config", {
            accountId: id,
            err: (e as Error).message,
          });
        }
      }
    } else {
      try {
        out.set(
          DEFAULT_ACCOUNT_ID,
          resolveAccount(pilotSection as PilotAccountConfig, DEFAULT_ACCOUNT_ID),
        );
      } catch (e) {
        this.deps.logger.error("pilot: invalid default account config", {
          err: (e as Error).message,
        });
      }
    }
    return out;
  }

  async startAll(cfg: OpenClawConfig): Promise<void> {
    this.currentCfg = cfg;
    const parsed = this.parseAccounts(cfg);
    for (const [id, account] of parsed) {
      if (!account.enabled) {
        this.deps.logger.info("pilot: account disabled, skipping", { accountId: id });
        continue;
      }
      try {
        await this.startAccount(account);
      } catch (e) {
        this.deps.logger.error("pilot: failed to start account — will retry", {
          accountId: id,
          err: (e as Error).message,
        });
        this.scheduleRetry(account);
      }
    }
  }

  /**
   * If the daemon socket isn't there yet (e.g. the daemon started after
   * openclaw), retry startAccount with exponential backoff. Capped at ~30s
   * between attempts; idempotent — the next successful startAccount records
   * the account in this.accounts and stops retrying.
   */
  private scheduleRetry(account: ResolvedPilotAccount, attempt = 1): void {
    if (this.accounts.has(account.accountId)) return; // already started
    const delayMs = Math.min(30_000, 500 * Math.pow(2, attempt - 1));
    const timer = setTimeout(async () => {
      if (this.accounts.has(account.accountId)) return;
      try {
        await this.startAccount(account);
        this.deps.logger.info("pilot: account started on retry", {
          accountId: account.accountId,
          attempt,
        });
      } catch (e) {
        this.deps.logger.debug?.("pilot: retry attempt failed", {
          accountId: account.accountId,
          attempt,
          err: (e as Error).message,
        });
        this.scheduleRetry(account, attempt + 1);
      }
    }, delayMs);
    if (timer.unref) timer.unref();
  }

  async startAccount(account: ResolvedPilotAccount): Promise<AccountState> {
    if (this.accounts.has(account.accountId)) {
      throw new Error(`pilot: account ${account.accountId} already running`);
    }
    const transport: Transport =
      this.deps.createTransport?.({ socketPath: account.socketPath }) ??
      (await loadDefaultTransport(account.socketPath));

    transport.on("error", (e) => {
      this.deps.logger.error("pilot transport error", {
        accountId: account.accountId,
        err: e.message,
      });
    });

    const info = await transport.start();
    this.deps.logger.info("pilot: transport started", {
      accountId: account.accountId,
      address: info.address,
      nodeId: info.nodeId,
    });

    // Per-account outbox. Persists to disk so messages queued during a pod
    // crash survive the restart. Path is namespaced per account so multiple
    // accounts can't clobber each other.
    const outboxDir =
      this.deps.outboxDir ?? join(homedir(), ".openclaw", "plugins", "claw-pilot");
    const outbox = new Outbox({
      path: join(outboxDir, `outbox-${account.accountId}.json`),
    });

    // Built after the outbox so the dispatch's ReplyDispatcher can fall
    // back to enqueueing when transport.send fails. The getOpenClawConfig
    // closure resolves at call time so a config reload between messages
    // (file-watch path) is picked up without restarting accounts.
    const runtime = getPilotRuntime();
    const dispatch = runtime
      ? runtime.buildDispatch({
          account,
          transport,
          outbox,
          getOpenClawConfig: () => this.currentCfg,
        })
      : async (m: { text: string; senderAddress: string; messageId: string }) => {
          this.deps.logger.warn(
            "pilot: runtime not set — dropping inbound message (will be wired by openclaw at startup)",
            { id: m.messageId, sender: m.senderAddress, textLen: m.text.length },
          );
        };

    const pipeline = new InboundPipeline({
      account,
      dispatch,
      logger: this.deps.logger,
      // Reuse the same transport for ACKs — the sender Driver inside it is
      // the one with permission to send to the peer.
      ackTransport: transport,
      // Drain queued outbound for this peer the moment we see ANY traffic
      // from them — proof of life means they're reachable right now.
      onPeerProofOfLife: (peer) => {
        if (outbox.forPeer(peer).length === 0) return;
        void outbox.drain(peer, (p, port, data) => transport.send(p, port, data)).then((r) => {
          this.deps.logger.info("pilot outbox: drained on proof of life", {
            peer: r.peer,
            sent: r.sent,
            failed: r.failed,
            evictedExpired: r.evictedExpired,
            remaining: r.remaining,
          });
        }).catch((e) => {
          this.deps.logger.warn("pilot outbox: drain on proof of life failed", {
            peer,
            err: (e as Error).message,
          });
        });
      },
    });
    pipeline.attach(transport);

    // Periodic drain — covers peers that haven't sent us anything (so no
    // proof-of-life trigger), e.g. a phone that's been silent for hours.
    const drainIntervalMs = this.deps.outboxDrainIntervalMs ?? 30_000;
    const drainTimer = setInterval(() => {
      const peers = outbox.pendingPeers();
      if (peers.length === 0) return;
      void outbox.drainAll((p, port, data) => transport.send(p, port, data))
        .then((results) => {
          const totalSent = results.reduce((n, r) => n + r.sent, 0);
          const totalRemaining = results.reduce((n, r) => n + r.remaining, 0);
          if (totalSent === 0 && totalRemaining === 0) return;
          this.deps.logger.info("pilot outbox: periodic drain", {
            accountId: account.accountId,
            sent: totalSent,
            remaining: totalRemaining,
            peers: results.length,
          });
        })
        .catch((e) => {
          this.deps.logger.warn("pilot outbox: periodic drain failed", {
            err: (e as Error).message,
          });
        });
    }, drainIntervalMs);
    if (drainTimer.unref) drainTimer.unref();

    const state: AccountState = { account, transport, pipeline, info, outbox, drainTimer };
    this.accounts.set(account.accountId, state);
    return state;
  }

  /** Expose the per-account outbox so the outbound adapter can enqueue. */
  getOutbox(accountId: string): Outbox | undefined {
    return this.accounts.get(accountId)?.outbox;
  }

  async stopAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [id, state] of this.accounts) {
      tasks.push(
        (async () => {
          try {
            if (state.drainTimer) clearInterval(state.drainTimer);
            state.pipeline.stop();
            await state.transport.stop();
          } catch (e) {
            this.deps.logger.warn("pilot: error stopping account", {
              accountId: id,
              err: (e as Error).message,
            });
          }
        })(),
      );
    }
    this.accounts.clear();
    await Promise.all(tasks);
  }

  getAccount(accountId: string): AccountState | undefined {
    return this.accounts.get(accountId);
  }

  getResolvedAccount(accountId: string | null | undefined): ResolvedPilotAccount | undefined {
    return this.accounts.get(accountId ?? DEFAULT_ACCOUNT_ID)?.account;
  }

  getTransportInfo(accountId: string | null | undefined): TransportInfo | null {
    return this.accounts.get(accountId ?? DEFAULT_ACCOUNT_ID)?.info ?? null;
  }
}
