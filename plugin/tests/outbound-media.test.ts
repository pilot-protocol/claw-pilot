import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { resolveAccount } from "../src/config.js";
import { buildPilotOutbound } from "../src/outbound.js";
import type { Transport, TransportInfo } from "../src/transport.js";
import { MAX_ENVELOPE_BYTES, MediaReassembler, decodeEnvelope } from "../src/wire.js";

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

function ctxFor(opts: {
  to?: string;
  text?: string;
  mediaUrl?: string;
  mediaReadFile?: (p: string) => Promise<Buffer>;
  accountId?: string | null;
}) {
  return {
    cfg: {} as never,
    to: opts.to ?? ALICE,
    text: opts.text,
    mediaUrl: opts.mediaUrl,
    mediaReadFile: opts.mediaReadFile,
    accountId: opts.accountId ?? null,
  };
}

function randomBytes(n: number, seed = 1): Buffer {
  let state = seed >>> 0;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

describe("buildPilotOutbound — sendMedia", () => {
  it("rejects when mediaUrl is missing", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const r = (await out.sendMedia!(ctxFor({}) as never)) as {
      ok: boolean;
      error?: Error;
    };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/without mediaUrl/);
  });

  it("rejects when account is unresolved", async () => {
    const transport = new FakeTransport();
    const out = buildPilotOutbound({
      resolveAccount: () => undefined,
      resolveTransport: () => transport,
    });
    const r = (await out.sendMedia!(
      ctxFor({ mediaUrl: "/tmp/x.png", mediaReadFile: async () => Buffer.from("x") }) as never,
    )) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/no resolved account/);
  });

  it("sends an image as media envelopes that reassemble to the source bytes", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const src = randomBytes(8_000, 42);
    const r = (await out.sendMedia!(
      ctxFor({
        mediaUrl: "screenshot.png",
        text: "here is your screenshot",
        mediaReadFile: async () => src,
      }) as never,
    )) as { ok: boolean; messageId?: string };
    expect(r.ok).toBe(true);
    expect(transport.sent.length).toBeGreaterThan(1);

    // Each envelope respects size budget.
    for (const s of transport.sent) {
      expect(s.data.length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    }

    // Reassemble.
    const reassembler = new MediaReassembler();
    let result: ReturnType<MediaReassembler["push"]> = null;
    for (const s of transport.sent) {
      const env = decodeEnvelope(s.data);
      expect(env.kind).toBe("media");
      if (env.kind === "media") {
        result = reassembler.push(env) ?? result;
      }
    }
    expect(result).not.toBeNull();
    expect(result!.bytes.equals(src)).toBe(true);
    expect(result!.media).toBe("image");
    expect(result!.mime).toBe("image/png");
    expect(result!.caption).toBe("here is your screenshot");
    expect(result!.from).toBe("agent");
    expect(result!.filename).toBe("screenshot.png");
  });

  it("classifies extension → media kind", async () => {
    const cases: Array<[string, "image" | "audio" | "file"]> = [
      ["a.png", "image"],
      ["b.jpeg", "image"],
      ["c.webp", "image"],
      ["clip.m4a", "audio"],
      ["track.mp3", "audio"],
      ["doc.pdf", "file"],
      ["arbitrary.bin", "file"],
    ];
    for (const [name, expectedKind] of cases) {
      const transport = new FakeTransport();
      const account = resolveAccount({ allowlist: [ALICE] });
      const out = buildPilotOutbound({
        resolveAccount: () => account,
        resolveTransport: () => transport,
      });
      await out.sendMedia!(
        ctxFor({
          mediaUrl: `/tmp/${name}`,
          mediaReadFile: async () => Buffer.from("x"),
        }) as never,
      );
      const env = decodeEnvelope(transport.sent[0]!.data);
      expect(env.kind).toBe("media");
      if (env.kind === "media") {
        expect(env.media).toBe(expectedKind);
      }
    }
  });

  it("returns ok:false when mediaReadFile throws", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    const r = (await out.sendMedia!(
      ctxFor({
        mediaUrl: "/nope.png",
        mediaReadFile: async () => {
          throw new Error("read failed");
        },
      }) as never,
    )) as { ok: boolean; error?: Error };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/read failed/);
  });

  it("strips port suffix from target", async () => {
    const transport = new FakeTransport();
    const account = resolveAccount({ allowlist: [ALICE] });
    const out = buildPilotOutbound({
      resolveAccount: () => account,
      resolveTransport: () => transport,
    });
    await out.sendMedia!(
      ctxFor({
        to: `${ALICE}:1234`,
        mediaUrl: "x.png",
        mediaReadFile: async () => Buffer.from("x"),
      }) as never,
    );
    expect(transport.sent[0]!.peerAddr).toBe(ALICE);
  });
});
