// Outbox behavior under the conditions that actually matter in production:
// peer offline → queue → peer comes back → drain. Plus the safety nets
// (TTL eviction, per-peer cap, persistence round-trip, partial drain).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Outbox } from "../src/outbox.js";

const PEER_A = "0:0000.DEAD.BEEF";
const PEER_B = "1:1111.2222.3333";

let workDir: string;
let oboxPath: string;

function envelope(id: string, seq?: number): Parameters<Outbox["enqueue"]>[1] {
  return {
    id,
    seq,
    port: 7777,
    dataB64: Buffer.from(`payload-${id}-${seq ?? "x"}`).toString("base64"),
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "outbox-test-"));
  oboxPath = join(workDir, "outbox.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("Outbox.enqueue", () => {
  it("queues an entry under the peer", () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("m-1"));
    expect(ob.size()).toBe(1);
    expect(ob.forPeer(PEER_A)).toHaveLength(1);
    expect(ob.forPeer(PEER_A)[0]!.id).toBe("m-1");
  });

  it("de-dupes the same (id, seq) for a peer", () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("m-1", 1));
    ob.enqueue(PEER_A, envelope("m-1", 1));
    expect(ob.forPeer(PEER_A)).toHaveLength(1);
  });

  it("treats different seq for the same id as distinct entries", () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("m-1", 1));
    ob.enqueue(PEER_A, envelope("m-1", 2));
    expect(ob.forPeer(PEER_A)).toHaveLength(2);
  });

  it("FIFO-evicts when per-peer cap is exceeded", () => {
    const ob = new Outbox({ path: oboxPath, maxPerPeer: 3 });
    ob.enqueue(PEER_A, envelope("a"));
    ob.enqueue(PEER_A, envelope("b"));
    ob.enqueue(PEER_A, envelope("c"));
    ob.enqueue(PEER_A, envelope("d"));
    expect(ob.forPeer(PEER_A).map((e) => e.id)).toEqual(["b", "c", "d"]);
  });

  it("isolates peers", () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("a-1"));
    ob.enqueue(PEER_B, envelope("b-1"));
    expect(ob.forPeer(PEER_A).map((e) => e.id)).toEqual(["a-1"]);
    expect(ob.forPeer(PEER_B).map((e) => e.id)).toEqual(["b-1"]);
  });
});

describe("Outbox.drain", () => {
  it("removes entries the sender accepts", async () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("m-1"));
    ob.enqueue(PEER_A, envelope("m-2"));

    const send = vi.fn().mockResolvedValue(undefined);
    const r = await ob.drain(PEER_A, send);

    expect(r.sent).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.remaining).toBe(0);
    expect(ob.size()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    // Verify the call shape — peer, port, raw bytes.
    expect(send.mock.calls[0]![0]).toBe(PEER_A);
    expect(send.mock.calls[0]![1]).toBe(7777);
    expect(Buffer.isBuffer(send.mock.calls[0]![2])).toBe(true);
  });

  it("leaves entries that fail to send (and increments attempt counter)", async () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("m-1"));
    ob.enqueue(PEER_A, envelope("m-2"));

    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("no relay"));
    const r = await ob.drain(PEER_A, send);

    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(1);
    const left = ob.forPeer(PEER_A);
    expect(left).toHaveLength(1);
    expect(left[0]!.id).toBe("m-2");
    expect(left[0]!.attempts).toBe(1);
    expect(left[0]!.lastAttemptAt).toBeGreaterThan(0);
  });

  it("evicts TTL-expired entries before sending", async () => {
    const ob = new Outbox({ path: oboxPath, ttlMs: 10 });
    ob.enqueue(PEER_A, envelope("stale"));
    // Wait past TTL.
    await new Promise((r) => setTimeout(r, 25));
    ob.enqueue(PEER_A, envelope("fresh"));

    const send = vi.fn().mockResolvedValue(undefined);
    const r = await ob.drain(PEER_A, send);

    expect(r.evictedExpired).toBe(1);
    expect(r.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // Only "fresh" reached the sender.
    expect(send.mock.calls[0]![2].toString()).toContain("fresh");
  });

  it("noop on an unknown peer", async () => {
    const ob = new Outbox({ path: oboxPath });
    const send = vi.fn();
    const r = await ob.drain(PEER_A, send);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Outbox persistence", () => {
  it("survives process restart (load reads what save wrote)", async () => {
    const ob1 = new Outbox({ path: oboxPath });
    ob1.enqueue(PEER_A, envelope("m-1"));
    ob1.enqueue(PEER_B, envelope("m-2"));
    // file exists with both peers
    const raw = readFileSync(oboxPath, "utf8");
    expect(raw).toContain("m-1");
    expect(raw).toContain("m-2");

    // Fresh instance pointed at the same file should rehydrate.
    const ob2 = new Outbox({ path: oboxPath });
    expect(ob2.pendingPeers().sort()).toEqual([PEER_A, PEER_B].sort());
    expect(ob2.forPeer(PEER_A).map((e) => e.id)).toEqual(["m-1"]);
    expect(ob2.forPeer(PEER_B).map((e) => e.id)).toEqual(["m-2"]);
  });

  it("recovers gracefully from a corrupt outbox file", () => {
    // Pre-write garbage. The constructor must not throw — we'd rather
    // start with an empty backlog than refuse to boot.
    writeFileSync(oboxPath, "not json", "utf8");
    const ob = new Outbox({ path: oboxPath });
    expect(ob.size()).toBe(0);
    // And subsequent enqueues should still work.
    ob.enqueue(PEER_A, envelope("m-after-corrupt"));
    expect(ob.forPeer(PEER_A)).toHaveLength(1);
  });
});

describe("Outbox.drainAll", () => {
  it("drains every peer", async () => {
    const ob = new Outbox({ path: oboxPath });
    ob.enqueue(PEER_A, envelope("a-1"));
    ob.enqueue(PEER_B, envelope("b-1"));

    const send = vi.fn().mockResolvedValue(undefined);
    const results = await ob.drainAll(send);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.sent === 1)).toBe(true);
    expect(ob.size()).toBe(0);
  });
});
