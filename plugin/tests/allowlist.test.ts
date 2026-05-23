import { describe, expect, it } from "vitest";

import { decideAllowlist } from "../src/allowlist.js";
import { isValidPilotAddress, pilotAddrBase, resolveAccount } from "../src/config.js";

describe("decideAllowlist", () => {
  const allow = new Set(["1:0000.0000.AAAA", "2:1234.5678.9ABC"]);

  it("allows addresses in the set", () => {
    expect(decideAllowlist("1:0000.0000.AAAA", allow)).toEqual({
      allowed: true,
      peer: "1:0000.0000.AAAA",
    });
  });

  it("strips port suffix before checking", () => {
    expect(decideAllowlist("2:1234.5678.9ABC:7777", allow)).toEqual({
      allowed: true,
      peer: "2:1234.5678.9ABC",
    });
  });

  it("rejects addresses not in the allowlist", () => {
    expect(decideAllowlist("3:0000.0000.FFFF", allow)).toEqual({
      allowed: false,
      reason: "not-in-allowlist",
    });
  });

  it("rejects empty / null src addrs", () => {
    expect(decideAllowlist(undefined, allow)).toEqual({
      allowed: false,
      reason: "malformed-src",
    });
    expect(decideAllowlist("", allow)).toEqual({
      allowed: false,
      reason: "malformed-src",
    });
  });

  it("does not silently accept on a typo (case-sensitive net id)", () => {
    // The pattern is hex case-insensitive for the hex parts, but the *exact*
    // form we store should match the configured form. Strict equality here:
    expect(decideAllowlist("1:0000.0000.aaaa", allow).allowed).toBe(false);
  });
});

describe("isValidPilotAddress", () => {
  it("accepts canonical addresses", () => {
    expect(isValidPilotAddress("1:0000.0000.AAAA")).toBe(true);
    expect(isValidPilotAddress("65535:FFFF.FFFF.FFFF")).toBe(true);
    expect(isValidPilotAddress("0:abcd.ef01.2345")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidPilotAddress("1.0000.0000.AAAA")).toBe(false);
    expect(isValidPilotAddress("1:0000-0000-AAAA")).toBe(false);
    expect(isValidPilotAddress("1:00.00.00")).toBe(false);
    expect(isValidPilotAddress("1:GGGG.0000.AAAA")).toBe(false);
    expect(isValidPilotAddress("")).toBe(false);
  });
});

describe("pilotAddrBase", () => {
  it("strips short numeric port", () => {
    expect(pilotAddrBase("1:0000.0000.AAAA:7777")).toBe("1:0000.0000.AAAA");
    expect(pilotAddrBase("1:0000.0000.AAAA:1")).toBe("1:0000.0000.AAAA");
  });
  it("leaves bare address untouched", () => {
    expect(pilotAddrBase("1:0000.0000.AAAA")).toBe("1:0000.0000.AAAA");
  });
  it("does not strip non-port suffix", () => {
    expect(pilotAddrBase("1:0000.0000.AAAA:abc")).toBe("1:0000.0000.AAAA:abc");
  });
});

describe("resolveAccount", () => {
  it("populates sensible defaults", () => {
    const acc = resolveAccount({ allowlist: ["1:0000.0000.AAAA"] });
    expect(acc.accountId).toBe("default");
    expect(acc.enabled).toBe(true);
    expect(acc.socketPath).toBe("/tmp/pilot.sock");
    expect(acc.appPort).toBe(7777);
    expect(acc.handshakeTrustAutoApprove).toBe(true);
    expect(acc.allowlist.has("1:0000.0000.AAAA")).toBe(true);
  });

  it("rejects when both allowlist is empty AND no sharedSecret", () => {
    expect(() => resolveAccount({ allowlist: [] })).toThrow(/allowlist.*sharedSecret/);
  });

  it("rejects malformed addresses in the allowlist", () => {
    expect(() => resolveAccount({ allowlist: ["not-an-addr"] })).toThrow(/invalid allowlist/);
  });

  it("honors explicit fields", () => {
    const acc = resolveAccount(
      {
        enabled: false,
        socketPath: "/var/run/pilot.sock",
        allowlist: ["1:0000.0000.AAAA"],
        appPort: 9999,
        handshakeTrustAutoApprove: false,
      },
      "alice",
    );
    expect(acc).toMatchObject({
      accountId: "alice",
      enabled: false,
      socketPath: "/var/run/pilot.sock",
      appPort: 9999,
      handshakeTrustAutoApprove: false,
    });
  });
});
