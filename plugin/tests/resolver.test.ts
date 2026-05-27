import { describe, expect, it } from "vitest";

import { PeerAddressCache } from "../src/peer-address.js";
import {
  buildPilotMessagingTargetResolver,
  buildPilotResolver,
  resolvePilotTarget,
} from "../src/resolver.js";

function makeResolver(cache?: PeerAddressCache) {
  return buildPilotResolver({ resolvePeerCache: () => cache });
}

function makeMessagingResolver(cache?: PeerAddressCache) {
  return buildPilotMessagingTargetResolver({ resolvePeerCache: () => cache });
}

describe("buildPilotResolver", () => {
  it("resolves a canonical pilot address as itself", async () => {
    const r = makeResolver();
    const out = await r.resolveTargets({
      inputs: ["0:0000.0003.3B23"],
      kind: "user",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      input: "0:0000.0003.3B23",
      resolved: true,
      id: "0:0000.0003.3B23",
    });
  });

  it("strips the `pilot:` provider prefix the agent might add", async () => {
    const r = makeResolver();
    const out = await r.resolveTargets({
      inputs: ["pilot:0:0000.0003.3B23"],
      kind: "user",
    });
    expect(out[0]!.resolved).toBe(true);
    expect(out[0]!.id).toBe("0:0000.0003.3B23");
  });

  it("strips a `:port` suffix — targets are address-only on this surface", async () => {
    const r = makeResolver();
    const out = await r.resolveTargets({
      inputs: ["0:0000.0003.3B23:7777"],
      kind: "user",
    });
    expect(out[0]!.resolved).toBe(true);
    expect(out[0]!.id).toBe("0:0000.0003.3B23");
  });

  it("resolves a node_id we've seen inbound (via the per-account cache)", async () => {
    const cache = new PeerAddressCache();
    cache.remember("0:0000.0003.3B23"); // observed inbound, nodeId 211747
    const r = makeResolver(cache);
    const out = await r.resolveTargets({
      inputs: ["211747"],
      kind: "user",
    });
    expect(out[0]!.resolved).toBe(true);
    expect(out[0]!.id).toBe("0:0000.0003.3B23");
    expect(out[0]!.note).toMatch(/node_id/);
  });

  it("refuses a node_id we've never seen — would otherwise default to network 0 silently", async () => {
    const r = makeResolver(); // no cache hits
    const out = await r.resolveTargets({
      inputs: ["999999"],
      kind: "user",
    });
    expect(out[0]!.resolved).toBe(false);
    expect(out[0]!.note).toMatch(/node_id not seen/);
  });

  it("rejects garbage with a useful explanation", async () => {
    const r = makeResolver();
    const out = await r.resolveTargets({
      inputs: ["not-an-address", "", "??"],
      kind: "user",
    });
    for (const entry of out) {
      expect(entry.resolved).toBe(false);
      expect(entry.note).toBeTruthy();
    }
  });

  it("returns all inputs unresolved with a clear note when asked for a group", async () => {
    const r = makeResolver();
    const out = await r.resolveTargets({
      inputs: ["0:0000.0003.3B23", "anything"],
      kind: "group",
    });
    for (const entry of out) {
      expect(entry.resolved).toBe(false);
      expect(entry.note).toMatch(/groups/);
    }
  });

  it("preserves the original input string verbatim in the result", async () => {
    const r = makeResolver();
    const out = await r.resolveTargets({
      inputs: ["pilot:0:0000.0003.3B23"],
      kind: "user",
    });
    expect(out[0]!.input).toBe("pilot:0:0000.0003.3B23");
    expect(out[0]!.id).toBe("0:0000.0003.3B23"); // canonicalised separately
  });

  it("resolves a batch with mixed valid and invalid inputs", async () => {
    const cache = new PeerAddressCache();
    cache.remember("0:0000.0002.74EE"); // claw, nodeId 161006
    const r = makeResolver(cache);
    const out = await r.resolveTargets({
      inputs: ["0:0000.0003.3B23", "161006", "bogus", "999999"],
      kind: "user",
    });
    expect(out[0]!.resolved).toBe(true);  // canonical address
    expect(out[1]!.resolved).toBe(true);  // node_id via cache
    expect(out[2]!.resolved).toBe(false); // garbage
    expect(out[3]!.resolved).toBe(false); // unknown node_id
  });
});

// MARK: - messaging.targetResolver (the hook openclaw's `message.send`
// agent tool actually calls)

describe("buildPilotMessagingTargetResolver — the real message.send hook", () => {
  it("resolveTarget returns {to,kind:user,display} for a canonical address", async () => {
    const r = makeMessagingResolver();
    const out = await r.resolveTarget({
      input: "0:0000.0003.3B23",
      normalized: "0:0000.0003.3B23",
    });
    expect(out).toEqual({
      to: "0:0000.0003.3B23",
      kind: "user",
      display: "0:0000.0003.3B23",
      source: "address",
    });
  });

  it("looksLikeId is true for addresses and known-shaped node_ids — gates the id-fast-path in openclaw", () => {
    const r = makeMessagingResolver();
    expect(r.looksLikeId("0:0000.0003.3B23")).toBe(true);
    expect(r.looksLikeId("pilot:0:0000.0003.3B23")).toBe(true);
    expect(r.looksLikeId("211747")).toBe(true);
    expect(r.looksLikeId("@some-handle")).toBe(false);
    expect(r.looksLikeId("hello world")).toBe(false);
  });

  it("hint string is set so openclaw's 'Unknown target' message tells the agent how to fix it", () => {
    const r = makeMessagingResolver();
    expect(r.hint).toMatch(/N:NNNN\.HHHH\.LLLL/);
  });

  it("resolveTarget returns undefined for an unknown node_id (lets openclaw emit the hinted error)", async () => {
    const r = makeMessagingResolver();
    const out = await r.resolveTarget({
      input: "999999",
      normalized: "999999",
    });
    expect(out).toBeUndefined();
  });

  it("resolveTarget uses the per-account peer cache for node_ids we've seen inbound", async () => {
    const cache = new PeerAddressCache();
    cache.remember("0:0000.0003.3B23");
    const r = makeMessagingResolver(cache);
    const out = await r.resolveTarget({
      input: "211747",
      normalized: "211747",
    });
    expect(out?.to).toBe("0:0000.0003.3B23");
    expect(out?.kind).toBe("user");
    expect(out?.source).toBe("node_id");
  });
});

describe("resolvePilotTarget (shared core)", () => {
  it("address-form passes through cleanly", () => {
    expect(resolvePilotTarget("0:0000.0003.3B23", undefined)?.to).toBe("0:0000.0003.3B23");
  });
  it("strips pilot: prefix + :port suffix", () => {
    expect(resolvePilotTarget("pilot:0:0000.0003.3B23:7777", undefined)?.to).toBe("0:0000.0003.3B23");
  });
  it("returns undefined for empty / whitespace", () => {
    expect(resolvePilotTarget("", undefined)).toBeUndefined();
    expect(resolvePilotTarget("   ", undefined)).toBeUndefined();
  });
});
