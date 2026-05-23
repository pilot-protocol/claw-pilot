// Transport interface — abstracts the Pilot Driver so the rest of the plugin
// can be unit-tested without a running daemon.

import { EventEmitter } from "node:events";

export type IncomingDatagram = {
  srcAddr: string;
  srcPort: number;
  dstPort: number;
  data: Buffer;
};

export type TransportInfo = {
  address: string;
  nodeId: number;
};

export interface Transport extends EventEmitter {
  /** Boot the transport. Resolves with this node's pilot identity. */
  start(): Promise<TransportInfo>;

  /** Send a datagram to a peer pilot address (no port — appended internally). */
  send(peerAddr: string, port: number, data: Buffer): Promise<void>;

  /** Stop the transport. Idempotent. */
  stop(): Promise<void>;

  /** True once start() has resolved. */
  readonly running: boolean;

  // Events:
  //   "datagram" — fires with an IncomingDatagram
  //   "error"    — fires with an Error (transport-level only)
  //   "closed"   — fires once stop() completes
  on(event: "datagram", listener: (dg: IncomingDatagram) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "closed", listener: () => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}
