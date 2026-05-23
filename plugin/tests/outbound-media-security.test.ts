import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAccount } from "../src/config.js";
import { buildPilotOutbound } from "../src/outbound.js";
import type { Transport, TransportInfo } from "../src/transport.js";

class FakeTransport extends EventEmitter implements Transport {
  running = true;
  sent: Array<{ peerAddr: string; port: number; data: Buffer }> = [];
  async start(): Promise<TransportInfo> {
    return { address: "1:0000.0000.0001", nodeId: 1 };
  }
  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    this.sent.push({ peerAddr, port, data });
  }
  async stop(): Promise<void> {
    this.running = false;
  }
}

const ALICE = "1:0000.0000.AAAA";

function ctxFor(opts: { mediaUrl?: string; text?: string; mediaReadFile?: (p: string) => Promise<Buffer> }) {
  return {
    cfg: {} as never,
    to: ALICE,
    text: opts.text,
    mediaUrl: opts.mediaUrl,
    mediaReadFile: opts.mediaReadFile,
    accountId: null,
  };
}

describe("outbound media — fallback path security", () => {
  it("refuses to read when no mediaReadFile and no trust roots", async () => {
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => resolveAccount({ allowlist: [ALICE] }),
      resolveTransport: () => transport,
      // No mediaTrustRoots set → fallback disabled.
    });
    const r = (await out.sendMedia!(
      ctxFor({ mediaUrl: "/etc/passwd" }) as never,
    )) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/no mediaTrustRoots/);
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses path-traversal even with a trust root configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-pilot-trust-"));
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => resolveAccount({ allowlist: [ALICE] }),
      resolveTransport: () => transport,
      mediaTrustRoots: [root],
    });

    const r = (await out.sendMedia!(
      ctxFor({ mediaUrl: `${root}/../../../etc/passwd` }) as never,
    )) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/not under any configured trust root/);
  });

  it("allows reads inside a trust root", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-pilot-trust-"));
    const file = join(root, "img.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => resolveAccount({ allowlist: [ALICE] }),
      resolveTransport: () => transport,
      mediaTrustRoots: [root],
    });
    const r = (await out.sendMedia!(ctxFor({ mediaUrl: file }) as never)) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(transport.sent.length).toBeGreaterThan(0);
  });

  it("accepts a file:// prefix and reads correctly", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-pilot-trust-"));
    const file = join(root, "doc.bin");
    writeFileSync(file, Buffer.from("hello"));
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => resolveAccount({ allowlist: [ALICE] }),
      resolveTransport: () => transport,
      mediaTrustRoots: [root],
    });
    const r = (await out.sendMedia!(
      ctxFor({ mediaUrl: `file://${file}` }) as never,
    )) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it("mediaReadFile from runtime bypasses the trust-root check (host already sandboxes)", async () => {
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => resolveAccount({ allowlist: [ALICE] }),
      resolveTransport: () => transport,
      // No trust roots — but runtime mediaReadFile is provided.
    });
    const reads: string[] = [];
    const r = (await out.sendMedia!(
      ctxFor({
        mediaUrl: "/anywhere/x.png",
        mediaReadFile: async (p) => {
          reads.push(p);
          return Buffer.from([1, 2, 3]);
        },
      }) as never,
    )) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(reads).toEqual(["/anywhere/x.png"]);
  });
});
