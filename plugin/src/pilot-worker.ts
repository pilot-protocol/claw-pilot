// Worker thread that owns a Pilot Driver and runs the blocking recvFrom() loop.
// The main thread is kept responsive by isolating this call here.
//
// Messages from worker → main:
//   { kind: "ready",     info: { address, nodeId } }
//   { kind: "datagram",  srcAddr, srcPort, dstPort, data: Uint8Array }
//   { kind: "error",     fatal: boolean, message: string }
//   { kind: "closed" }
//
// Messages from main → worker:
//   { kind: "stop" }

import { parentPort, workerData } from "node:worker_threads";
import { Driver } from "pilotprotocol";

type WorkerInit = {
  socketPath?: string;
};

const init = (workerData ?? {}) as WorkerInit;

if (!parentPort) {
  throw new Error("pilot-worker must run inside a Worker thread");
}

let stopping = false;

parentPort.on("message", (msg: { kind: string }) => {
  if (msg.kind === "stop") {
    stopping = true;
    try {
      driver?.close();
    } catch {
      // best-effort; close races the blocked recvFrom by design
    }
  }
});

let driver: Driver | null = null;

try {
  driver = init.socketPath ? new Driver(init.socketPath) : new Driver();
} catch (e) {
  parentPort.postMessage({
    kind: "error",
    fatal: true,
    message: `failed to connect to pilot daemon: ${(e as Error).message}`,
  });
  process.exit(1);
}

try {
  const info = driver.info() as Record<string, unknown>;
  const address = String(info["address"] ?? "");
  const nodeIdRaw = info["node_id"];
  const nodeId =
    typeof nodeIdRaw === "number"
      ? nodeIdRaw
      : typeof nodeIdRaw === "string"
        ? Number(nodeIdRaw)
        : 0;
  parentPort.postMessage({ kind: "ready", info: { address, nodeId } });
} catch (e) {
  parentPort.postMessage({
    kind: "error",
    fatal: true,
    message: `pilot info() failed: ${(e as Error).message}`,
  });
  process.exit(1);
}

// Blocking recv loop.
while (!stopping) {
  try {
    const dg = driver.recvFrom() as Record<string, unknown>;
    const srcAddr = String(dg["src_addr"] ?? "");
    const srcPort = Number(dg["src_port"] ?? 0);
    const dstPort = Number(dg["dst_port"] ?? 0);
    let data: Uint8Array;
    const rawData = dg["data"];
    if (rawData instanceof Uint8Array) {
      data = rawData;
    } else if (typeof rawData === "string") {
      // Go's encoding/json renders []byte as base64.
      data = Buffer.from(rawData, "base64");
    } else if (Array.isArray(rawData)) {
      data = Buffer.from(rawData as number[]);
    } else {
      data = new Uint8Array(0);
    }
    // Don't transfer data.buffer — when `data` came from Buffer.from(string,
    // 'base64') it's backed by Node's internal pooled ArrayBuffer, which is
    // NOT in the transferable type list and makes postMessage throw
    // "Cannot transfer object of unsupported type". The outer catch wraps
    // that as "recvFrom failed: ..." which is misleading. Copy into a fresh,
    // owned ArrayBuffer so postMessage uses structured clone — small (~1KB)
    // UDP datagrams make the copy free.
    const owned = new Uint8Array(data.byteLength);
    owned.set(data);
    parentPort.postMessage({ kind: "datagram", srcAddr, srcPort, dstPort, data: owned });
  } catch (e) {
    if (stopping) break;
    parentPort.postMessage({
      kind: "error",
      fatal: false,
      message: `recvFrom failed: ${(e as Error).message}`,
    });
    // Small backoff then continue — transient errors shouldn't kill the worker.
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, 250);
  }
}

parentPort.postMessage({ kind: "closed" });
