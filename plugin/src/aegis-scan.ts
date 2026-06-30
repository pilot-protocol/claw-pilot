// AEGIS scan-pipe — prompt-injection screening for inbound message text.
//
// Runs the external `aegis scan-pipe` tool, feeding the candidate text on
// stdin. AEGIS signals a verdict via process exit code:
//   0 → clean (allow)
//   2 → flagged (block); the matched rule is printed on stdout
//   * → any other status / spawn error / timeout → treated as inconclusive,
//        and the caller fails OPEN (allows the message). A scanner outage must
//        not silently swallow every inbound DM.
//
// This is intentionally async: the inbound pipeline is fully `await`-based and
// runs one scan per message. A synchronous `spawnSync` here would block the
// Node event loop for the whole subprocess lifetime on every message, starving
// every other connection's I/O. We spawn non-blocking and await the result.

import { execFile } from "node:child_process";

/** Outcome of an AEGIS scan. */
export type AegisScanResult = {
  /** True when AEGIS flagged the text (exit code 2). */
  blocked: boolean;
  /** The matched rule (stdout) when blocked; empty otherwise. */
  rule: string;
};

/** Pluggable scanner signature so the pipeline can be tested without execing. */
export type AegisScan = (text: string) => Promise<AegisScanResult>;

export type AegisScanOptions = {
  /** Subprocess hard timeout in ms. Default 500. */
  timeoutMs?: number;
  /** Binary to invoke. Default "aegis". */
  command?: string;
};

/**
 * Default scanner: spawns `aegis scan-pipe` and writes `text` to its stdin.
 *
 * Non-blocking — resolves once the child exits (or the timeout kills it).
 * Equivalent allow/block contract to the previous spawnSync implementation
 * (exit 2 = block), but without parking the event loop.
 */
export function createAegisScan(opts: AegisScanOptions = {}): AegisScan {
  const timeout = opts.timeoutMs ?? 500;
  const command = opts.command ?? "aegis";

  return (text: string): Promise<AegisScanResult> =>
    new Promise<AegisScanResult>((resolve) => {
      const child = execFile(
        command,
        ["scan-pipe"],
        { timeout, encoding: "utf8", maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          // `err.code` carries the exit status for a non-zero exit; on a
          // timeout the child is killed and `err.killed` is set with no code.
          const status =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? null // spawn error, timeout, or signal — inconclusive
                : 0;

          if (status === 2) {
            resolve({ blocked: true, rule: (stdout ?? "").trim() });
            return;
          }
          // Clean (0) or inconclusive (null / other) → fail open.
          resolve({ blocked: false, rule: "" });
        },
      );

      // Feed the candidate text and close stdin so AEGIS sees EOF.
      child.stdin?.on("error", () => {
        // A write race (e.g. child already exited) must not crash us; the
        // exec callback above still resolves the promise.
      });
      child.stdin?.end(text);
    });
}
