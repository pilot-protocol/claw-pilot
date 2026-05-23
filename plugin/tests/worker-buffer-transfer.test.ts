// Regression test for the pilot-worker postMessage transferList bug
// (2026-05-21).
//
// Symptom in the wild: the claw plugin logged
//   "pilot transport error: recvFrom failed: Cannot transfer object of
//   unsupported type."
// on EVERY inbound datagram from the iOS app, dropping all messages silently
// at the worker boundary (no "pilot inbound: datagram" trace ever fired).
//
// Root cause: pilot-worker.ts received datagrams from the FFI as objects with
// `data` as a string (Go's encoding/json renders []byte as base64). The worker
// did `Buffer.from(rawData, "base64")` to get a Uint8Array, then passed the
// underlying ArrayBuffer in postMessage's transferList:
//
//   parentPort.postMessage({ ..., data }, [data.buffer]);
//
// Buffer.from(string, "base64") returns a Buffer backed by Node's internal
// pool ArrayBuffer. That pooled buffer is NOT in the structured-clone
// transferable list, so postMessage throws synchronously with exactly the
// message above. The outer try/catch in the worker wrapped that as
// "recvFrom failed: ..." — extremely misleading, because recvFrom itself
// had succeeded.
//
// Fix: copy into a fresh, owned Uint8Array and post WITHOUT a transferList
// (structured clone copies it, which is ~free for typical 1KB UDP datagrams).

import { describe, expect, it } from "vitest";
import { MessageChannel } from "node:worker_threads";

describe("pilot-worker: Buffer transfer hazard", () => {
  it("transferring Buffer.from(base64).buffer throws (this is the bug)", () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const data = Buffer.from("aGVsbG8gd29ybGQ=", "base64"); // "hello world"
      expect(() => {
        port1.postMessage({ kind: "datagram", data }, [data.buffer]);
      }).toThrow(/transfer object of unsupported type/i);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("posting an owned Uint8Array WITHOUT a transferList works", async () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const src = Buffer.from("aGVsbG8gd29ybGQ=", "base64");
      // This is the fix in pilot-worker.ts.
      const owned = new Uint8Array(src.byteLength);
      owned.set(src);

      const received = await new Promise<{ kind: string; data: Uint8Array }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no message")), 500);
          port2.once("message", (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          port1.postMessage({ kind: "datagram", data: owned });
        },
      );

      expect(received.kind).toBe("datagram");
      expect(Array.from(received.data)).toEqual(Array.from(owned));
      expect(new TextDecoder().decode(received.data)).toBe("hello world");
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("the compiled worker uses the safe path (no [data.buffer] transfer)", async () => {
    // Lock the source-level shape so a future refactor can't silently
    // reintroduce the transferList without tripping this test.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/pilot-worker.ts", import.meta.url),
      "utf8",
    );
    // The bug pattern: postMessage(...{ kind: "datagram"...}..., [data.buffer]).
    expect(src).not.toMatch(/postMessage\([^)]*\[\s*data\.buffer/);
    // The fix pattern: an owned Uint8Array followed by postMessage with no
    // transferList. Looser check — at least confirm an owned copy is made.
    expect(src).toMatch(/new Uint8Array\(data\.byteLength\)/);
  });
});
