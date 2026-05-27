// Coverage for status.ts (the "disabled" / "starting" / "missing" branches)
// and directory.ts listEntries — both are tiny adapter functions with
// branches the existing tests touch only partially.

import { describe, expect, it } from "vitest";

import { resolveAccount } from "../src/config.js";
import { buildPilotDirectory } from "../src/directory.js";
import { buildPilotStatus } from "../src/status.js";
import type { TransportInfo } from "../src/transport.js";

const ALICE = "1:0000.0000.AAAA";
const BOB = "1:0000.0000.BBBB";

const STARTED_INFO: TransportInfo = {
  address: "1:0000.0000.0001",
  nodeId: 42,
};

describe("buildPilotStatus", () => {
  it("returns 'missing' when the account is not configured", () => {
    const status = buildPilotStatus({
      resolveAccount: () => undefined,
      getTransportInfo: () => null,
    });
    const s = status.summarize?.({ accountId: "default" });
    expect(s).toEqual({
      configured: false,
      enabled: false,
      state: "missing",
      detail: "no account",
    });
  });

  it("returns 'disabled' when account exists but enabled=false", () => {
    const acct = resolveAccount({ allowlist: [ALICE], enabled: false });
    const status = buildPilotStatus({
      resolveAccount: () => acct,
      getTransportInfo: () => STARTED_INFO,
    });
    const s = status.summarize?.({ accountId: "default" });
    expect(s).toMatchObject({
      configured: true,
      enabled: false,
      state: "disabled",
    });
  });

  it("returns 'starting' when enabled but transport hasn't started yet", () => {
    const acct = resolveAccount({ allowlist: [ALICE] });
    const status = buildPilotStatus({
      resolveAccount: () => acct,
      getTransportInfo: () => null,
    });
    const s = status.summarize?.({ accountId: "default" });
    expect(s).toMatchObject({
      configured: true,
      enabled: true,
      state: "starting",
    });
  });

  it("returns 'ok' with peer count once running", () => {
    const acct = resolveAccount({ allowlist: [ALICE, BOB] });
    const status = buildPilotStatus({
      resolveAccount: () => acct,
      getTransportInfo: () => STARTED_INFO,
    });
    const s = status.summarize?.({ accountId: "default" }) as {
      state: string;
      detail: string;
    };
    expect(s.state).toBe("ok");
    expect(s.detail).toMatch(/peers=2/);
    expect(s.detail).toMatch(/node_id=42/);
  });

  it("accepts an accountId of null/undefined", () => {
    const acct = resolveAccount({ allowlist: [ALICE] });
    const status = buildPilotStatus({
      resolveAccount: () => acct,
      getTransportInfo: () => STARTED_INFO,
    });
    const sNull = status.summarize?.({ accountId: null }) as { state: string };
    const sUndef = status.summarize?.({}) as { state: string };
    expect(sNull.state).toBe("ok");
    expect(sUndef.state).toBe("ok");
  });
});

describe("buildPilotDirectory", () => {
  it("listEntries returns one entry per allowlist member", async () => {
    const acct = resolveAccount({ allowlist: [ALICE, BOB] });
    const dir = buildPilotDirectory({ resolveAccount: () => acct });
    const entries = await dir.listEntries({ accountId: "default" });
    expect(entries).toHaveLength(2);
    const ids = entries.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual([ALICE, BOB].sort());
    for (const e of entries) {
      expect((e as { kind: string }).kind).toBe("direct");
      expect((e as { label: string }).label).toBe((e as { id: string }).id);
    }
  });

  it("listEntries returns [] when account is missing", async () => {
    const dir = buildPilotDirectory({ resolveAccount: () => undefined });
    const entries = await dir.listEntries({ accountId: "nope" });
    expect(entries).toEqual([]);
  });

  it("resolveTarget rejects when account is missing", async () => {
    const dir = buildPilotDirectory({ resolveAccount: () => undefined });
    const r = (await dir.resolveTarget({
      accountId: "default",
      query: ALICE,
    })) as { ok: boolean; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account-not-configured");
  });

  it("resolveTarget rejects malformed-but-allowlisted-looking input", async () => {
    const acct = resolveAccount({ allowlist: [ALICE] });
    const dir = buildPilotDirectory({ resolveAccount: () => acct });
    const r = (await dir.resolveTarget({
      accountId: "default",
      query: "not-a-pilot-address",
    })) as { ok: boolean; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-in-allowlist");
  });

  it("resolveTarget accepts an allowlisted address with surrounding whitespace", async () => {
    const acct = resolveAccount({ allowlist: [ALICE] });
    const dir = buildPilotDirectory({ resolveAccount: () => acct });
    const r = (await dir.resolveTarget({
      accountId: "default",
      query: `  ${ALICE}  `,
    })) as { ok: boolean; id?: string };
    expect(r.ok).toBe(true);
    expect(r.id).toBe(ALICE);
  });
});
