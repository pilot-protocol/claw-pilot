import { describe, expect, it } from "vitest";

import {
  addressToNodeId,
  isPilotAddress,
  looksLikeNodeId,
  nodeIdToAddress,
  PeerAddressCache,
} from "../src/peer-address.js";

describe("isPilotAddress", () => {
  it("accepts canonical addresses", () => {
    expect(isPilotAddress("0:0000.0003.3B23")).toBe(true);
    expect(isPilotAddress("65535:FFFF.FFFF.FFFF")).toBe(true);
    expect(isPilotAddress("12:abcd.ef01.2345")).toBe(true);
  });
  it("accepts addresses with a :port suffix", () => {
    expect(isPilotAddress("0:0000.0003.3B23:7777")).toBe(true);
  });
  it("rejects malformed inputs", () => {
    expect(isPilotAddress("211747")).toBe(false);            // bare node_id
    expect(isPilotAddress("0:0000.0003")).toBe(false);       // too few groups
    expect(isPilotAddress("0:0000.0003.3B2")).toBe(false);   // group < 4 hex
    expect(isPilotAddress("0:GGGG.0003.3B23")).toBe(false);  // non-hex
    expect(isPilotAddress("")).toBe(false);
  });
});

describe("looksLikeNodeId", () => {
  it("matches positive decimal integers", () => {
    expect(looksLikeNodeId("211747")).toBe(true);
    expect(looksLikeNodeId("0")).toBe(true);
    expect(looksLikeNodeId("1")).toBe(true);
  });
  it("rejects anything that isn't purely digits", () => {
    expect(looksLikeNodeId("0:0000.0003.3B23")).toBe(false);
    expect(looksLikeNodeId("-1")).toBe(false);
    expect(looksLikeNodeId("3.14")).toBe(false);
    expect(looksLikeNodeId("0x1234")).toBe(false);
    expect(looksLikeNodeId("")).toBe(false);
  });
});

describe("nodeIdToAddress", () => {
  it("converts the real-world phone node_id back to its address", () => {
    // From the deploy log: node_id=211747 addr=0:0000.0003.3B23
    expect(nodeIdToAddress(211747)).toBe("0:0000.0003.3B23");
    expect(nodeIdToAddress("211747")).toBe("0:0000.0003.3B23");
  });
  it("converts the claw node_id back too", () => {
    // node_id=161006 addr=0:0000.0002.74EE
    expect(nodeIdToAddress(161006)).toBe("0:0000.0002.74EE");
  });
  it("respects the network prefix", () => {
    expect(nodeIdToAddress(211747, 5)).toBe("5:0000.0003.3B23");
  });
  it("handles the boundary cases — zero and the 48-bit ceiling", () => {
    expect(nodeIdToAddress(0)).toBe("0:0000.0000.0000");
    expect(nodeIdToAddress((1n << 48n) - 1n)).toBe("0:FFFF.FFFF.FFFF");
  });
  it("returns undefined for out-of-range or malformed input", () => {
    expect(nodeIdToAddress(-1)).toBeUndefined();
    expect(nodeIdToAddress(1n << 48n)).toBeUndefined();      // exactly 48 bits → out
    expect(nodeIdToAddress("not-a-number")).toBeUndefined();
  });
});

describe("addressToNodeId", () => {
  it("is the inverse of nodeIdToAddress for known peers", () => {
    expect(addressToNodeId("0:0000.0003.3B23")).toEqual({ nodeId: 211747, network: 0 });
    expect(addressToNodeId("0:0000.0002.74EE")).toEqual({ nodeId: 161006, network: 0 });
  });
  it("preserves non-zero network", () => {
    expect(addressToNodeId("7:0001.0002.0003")).toEqual({ nodeId: 0x100020003, network: 7 });
  });
  it("returns undefined for malformed input", () => {
    expect(addressToNodeId("211747")).toBeUndefined();
    expect(addressToNodeId("not an address")).toBeUndefined();
  });
});

describe("PeerAddressCache", () => {
  it("resolves a known peer back to its observed-network address", () => {
    const cache = new PeerAddressCache();
    cache.remember("7:0000.0003.3B23");
    expect(cache.resolve("211747")).toBe("7:0000.0003.3B23");
  });

  it("falls back to network 0 for never-seen node_ids", () => {
    const cache = new PeerAddressCache();
    expect(cache.resolve("211747")).toBe("0:0000.0003.3B23");
  });

  it("passes addresses straight through", () => {
    const cache = new PeerAddressCache();
    expect(cache.resolve("0:0000.0003.3B23")).toBe("0:0000.0003.3B23");
  });

  it("returns undefined for inputs that are neither", () => {
    const cache = new PeerAddressCache();
    expect(cache.resolve("hello")).toBeUndefined();
    expect(cache.resolve("-1")).toBeUndefined();
  });

  it("remembering a bad address is a no-op (no throw)", () => {
    const cache = new PeerAddressCache();
    cache.remember("not-an-address");
    cache.remember("");
    expect(cache.resolve("211747")).toBe("0:0000.0003.3B23");
  });

  it("a later remember updates the network for the same node_id", () => {
    const cache = new PeerAddressCache();
    cache.remember("0:0000.0003.3B23");
    expect(cache.resolve("211747")).toBe("0:0000.0003.3B23");
    cache.remember("9:0000.0003.3B23");
    expect(cache.resolve("211747")).toBe("9:0000.0003.3B23");
  });
});
