// Real Transport implementation backed by `pilotprotocol`.
//
// recvFrom() blocks the event loop, so we delegate it to a worker_thread.
// sendTo() is non-blocking enough to call from the main thread on a separate
// Driver handle.

import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Driver } from "pilotprotocol";

import type { IncomingDatagram, Transport, TransportInfo } from "./transport.js";

type WorkerMsg =
  | { kind: "ready"; info: TransportInfo }
  | {
      kind: "datagram";
      srcAddr: string;
      srcPort: number;
      dstPort: number;
      data: Uint8Array;
    }
  | { kind: "error"; fatal: boolean; message: string }
  | { kind: "closed" };

export type PilotTransportOptions = {
  socketPath?: string;
  /** Override the worker script path (mainly for tests). */
  workerPath?: string;
};

export class PilotTransport extends EventEmitter implements Transport {
  private readonly opts: PilotTransportOptions;
  private worker: Worker | null = null;
  private sender: Driver | null = null;
  private _running = false;
  private startPromise: Promise<TransportInfo> | null = null;

  constructor(opts: PilotTransportOptions = {}) {
    super();
    this.opts = opts;
  }

  get running(): boolean {
    return this._running;
  }

  start(): Promise<TransportInfo> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolveReady, reject) => {
      try {
        this.sender = this.opts.socketPath
          ? new Driver(this.opts.socketPath)
          : new Driver();
      } catch (e) {
        reject(new Error(`sender Driver connect failed: ${(e as Error).message}`));
        return;
      }

      const workerPath = this.opts.workerPath ?? defaultWorkerPath();
      const worker = new Worker(workerPath, {
        workerData: { socketPath: this.opts.socketPath },
      });
      this.worker = worker;

      const onReady = (msg: WorkerMsg) => {
        if (msg.kind === "ready") {
          worker.off("message", onReady);
          this._running = true;
          worker.on("message", (m: WorkerMsg) => this.handleMsg(m));
          resolveReady(msg.info);
        } else if (msg.kind === "error" && msg.fatal) {
          worker.off("message", onReady);
          reject(new Error(msg.message));
        }
      };
      worker.on("message", onReady);
      worker.on("error", (e) => reject(e));
      worker.on("exit", (code) => {
        this._running = false;
        if (code !== 0 && !this.startPromise) {
          this.emit("error", new Error(`pilot worker exited with code ${code}`));
        }
        this.emit("closed");
      });
    });
    return this.startPromise;
  }

  private handleMsg(msg: WorkerMsg): void {
    switch (msg.kind) {
      case "datagram": {
        const dg: IncomingDatagram = {
          srcAddr: msg.srcAddr,
          srcPort: msg.srcPort,
          dstPort: msg.dstPort,
          data: Buffer.from(msg.data),
        };
        this.emit("datagram", dg);
        return;
      }
      case "error":
        this.emit("error", new Error(msg.message));
        return;
      case "closed":
        return;
      default:
        return;
    }
  }

  async send(peerAddr: string, port: number, data: Buffer): Promise<void> {
    if (!this.sender) throw new Error("transport not started");
    const target = `${peerAddr}:${port}`;
    this.sender.sendTo(target, data);
  }

  async stop(): Promise<void> {
    if (!this._running && !this.worker) return;
    this._running = false;
    try {
      this.sender?.close();
    } catch {
      // ignore
    }
    this.sender = null;
    if (this.worker) {
      this.worker.postMessage({ kind: "stop" });
      try {
        await this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }
}

function defaultWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "pilot-worker.js");
}
