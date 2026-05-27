import { describe, expect, it } from "vitest";

import { PeerAddressCache } from "../src/peer-address.js";
import { buildPilotResolver } from "../src/resolver.js";

function makeResolver(cache?: PeerAddressCache) {
  return buildPilotResolver({ resolvePeerCache: () => cache });
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
