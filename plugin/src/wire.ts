// Wire format for Pilot ↔ OpenClaw messages.
//
// One JSON object per UDP datagram. Keep it small — typical Pilot MTU is
// ~1200 bytes after framing, so the envelope must fit in one packet to avoid
// fragmentation. If text exceeds that, the sender splits into N envelopes
// sharing the same `id` and assembles via (`seq`, `total`).

export const WIRE_VERSION = 1 as const;

/** Maximum bytes for a single envelope's JSON encoding. */
export const MAX_ENVELOPE_BYTES = 1024;

/** Direction-agnostic media kinds. */
export type MediaKind = "image" | "file" | "audio";

/** A message from the user to the claw (mobile → claw). */
export type UserMessage = {
  v: typeof WIRE_VERSION;
  kind: "user";
  id: string;
  ts: number;
  text: string;
  seq?: number;
  total?: number;
  /**
   * Optional HMAC-SHA256 over canonicalized envelope (no `hmac` field), base64.
   * If the receiver has a shared secret configured, a valid HMAC bypasses the
   * pilot-address allowlist — letting any peer with the secret authenticate
   * without per-device address pinning.
   */
  hmac?: string;
};

/** A reply from the claw to the user (claw → mobile). */
export type AgentMessage = {
  v: typeof WIRE_VERSION;
  kind: "agent";
  id: string;
  ts: number;
  text: string;
  seq?: number;
  total?: number;
  hmac?: string;
};

/**
 * Media envelope — image / file / audio attachment.
 *
 * Binary payload travels as `data` (base64) and is chunked across N envelopes
 * sharing the same `id`. Metadata (filename, mime, totalBytes) lives ONLY in
 * the first envelope (seq=1) to keep subsequent chunks lean.
 *
 * On the wire, an image upload looks like:
 *   { v:1, kind:"media", media:"image", id:"abc", ts:..., seq:1, total:8,
 *     filename:"cat.jpg", mime:"image/jpeg", totalBytes:6543, caption:"my cat",
 *     data:"<base64>" }
 *   { v:1, kind:"media", id:"abc", ts:..., seq:2, total:8, data:"<base64>" }
 *   ...
 */
export type MediaMessage = {
  v: typeof WIRE_VERSION;
  kind: "media";
  /** Sender role — same semantics as user/agent for text. */
  from: "user" | "agent";
  /** What this is. Receivers may render differently per kind. */
  media: MediaKind;
  id: string;
  ts: number;
  /** Base64-encoded chunk payload. */
  data: string;
  seq: number;
  total: number;
  /** First-chunk-only fields. */
  filename?: string;
  mime?: string;
  totalBytes?: number;
  caption?: string;
  hmac?: string;
};

/** Delivery acknowledgement (either direction). */
export type Ack = {
  v: typeof WIRE_VERSION;
  kind: "ack";
  id: string;
  ts: number;
};

/** Error signal (either direction). */
export type WireError = {
  v: typeof WIRE_VERSION;
  kind: "error";
  id: string;
  ts: number;
  code: string;
  text: string;
};

export type Envelope = UserMessage | AgentMessage | MediaMessage | Ack | WireError;

export function encodeEnvelope(env: Envelope): Buffer {
  const json = JSON.stringify(env);
  const buf = Buffer.from(json, "utf8");
  if (buf.length > MAX_ENVELOPE_BYTES) {
    throw new Error(
      `envelope ${buf.length}B exceeds MAX_ENVELOPE_BYTES (${MAX_ENVELOPE_BYTES}); chunk before encoding`,
    );
  }
  return buf;
}

export function decodeEnvelope(buf: Buffer | Uint8Array): Envelope {
  const text = Buffer.isBuffer(buf)
    ? buf.toString("utf8")
    : Buffer.from(buf).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`envelope not JSON: ${(e as Error).message}`);
  }
  if (!isEnvelope(parsed)) {
    throw new Error(`envelope failed schema check: ${text.slice(0, 200)}`);
  }
  return parsed;
}

function isEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.v !== WIRE_VERSION) return false;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (typeof o.ts !== "number") return false;
  switch (o.kind) {
    case "user":
    case "agent":
      return typeof o.text === "string";
    case "media":
      return (
        typeof o.data === "string" &&
        typeof o.seq === "number" &&
        typeof o.total === "number" &&
        (o.media === "image" || o.media === "file" || o.media === "audio") &&
        (o.from === "user" || o.from === "agent")
      );
    case "ack":
      return true;
    case "error":
      return typeof o.code === "string" && typeof o.text === "string";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// HMAC signing / verification — shared-secret authorization layer.
// ---------------------------------------------------------------------------

/**
 * Canonicalize an envelope for HMAC. We strip the `hmac` field itself, then
 * JSON.stringify with sorted keys for stable output across encoders.
 */
function canonicalForHmac(env: Envelope): string {
  const copy = { ...(env as Record<string, unknown>) };
  delete copy["hmac"];
  const keys = Object.keys(copy).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = copy[k];
  return JSON.stringify(ordered);
}

/**
 * Compute an HMAC-SHA256 over the canonicalized envelope (without `hmac`),
 * returning base64. Both sides MUST use the same canonicalization, so always
 * route through this function.
 */
export async function signEnvelope(env: Envelope, secret: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const h = createHmac("sha256", secret);
  h.update(canonicalForHmac(env));
  return h.digest("base64");
}

/**
 * Verify an envelope's HMAC against a secret. Returns true iff the hmac field
 * is present AND matches the computed value (constant-time compare).
 */
export async function verifyEnvelope(env: Envelope, secret: string): Promise<boolean> {
  const provided = (env as { hmac?: string }).hmac;
  if (!provided) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const h = createHmac("sha256", secret);
  h.update(canonicalForHmac(env));
  const expected = h.digest();
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "base64");
  } catch {
    return false;
  }
  if (providedBuf.length !== expected.length) return false;
  return timingSafeEqual(providedBuf, expected);
}

/** Generate a short, monotonically-tending message id (24 base36 chars). */
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = Math.floor(Math.random() * 36 ** 12)
    .toString(36)
    .padStart(12, "0");
  return `${t}${r}`;
}

/**
 * Split text into N user envelopes that each fit MAX_ENVELOPE_BYTES.
 * All chunks share the same `id`; assembly uses (`seq`, `total`).
 */
export function chunkUserText(text: string, id = newId()): UserMessage[] {
  return chunkText(text, id, "user") as UserMessage[];
}

export function chunkAgentText(text: string, id = newId()): AgentMessage[] {
  return chunkText(text, id, "agent") as AgentMessage[];
}

function chunkText(
  text: string,
  id: string,
  kind: "user" | "agent",
): Envelope[] {
  const ts = Date.now();
  // First try unsplit.
  const single = { v: WIRE_VERSION, kind, id, ts, text } as Envelope;
  if (Buffer.byteLength(JSON.stringify(single), "utf8") <= MAX_ENVELOPE_BYTES) {
    return [single];
  }
  // Binary search a chunk size that fits.
  const envOverhead = Buffer.byteLength(
    JSON.stringify({ v: WIRE_VERSION, kind, id, ts, text: "", seq: 1, total: 99 }),
    "utf8",
  );
  const room = MAX_ENVELOPE_BYTES - envOverhead - 8; // safety
  const slices: string[] = [];
  let i = 0;
  while (i < text.length) {
    let lo = 1;
    let hi = Math.min(text.length - i, room);
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const piece = text.slice(i, i + mid);
      if (Buffer.byteLength(piece, "utf8") <= room) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    slices.push(text.slice(i, i + best));
    i += best;
  }
  return slices.map((piece, idx) => ({
    v: WIRE_VERSION,
    kind,
    id,
    ts,
    text: piece,
    seq: idx + 1,
    total: slices.length,
  })) as Envelope[];
}

// ---------------------------------------------------------------------------
// Media envelopes — chunk and reassemble binary payloads.
// ---------------------------------------------------------------------------

export type ChunkMediaInput = {
  from: "user" | "agent";
  media: MediaKind;
  bytes: Buffer | Uint8Array;
  filename?: string;
  mime?: string;
  caption?: string;
  id?: string;
  ts?: number;
};

/**
 * Split a binary payload into media envelopes that each encode within
 * MAX_ENVELOPE_BYTES. Header fields (filename, mime, totalBytes, caption)
 * are placed ONLY on seq=1 to keep subsequent chunks lean.
 */
export function chunkMedia(input: ChunkMediaInput): MediaMessage[] {
  const id = input.id ?? newId();
  const ts = input.ts ?? Date.now();
  const totalBytes = input.bytes.length;

  // Estimate first-chunk overhead with all metadata fields populated.
  const firstSample: MediaMessage = {
    v: WIRE_VERSION,
    kind: "media",
    from: input.from,
    media: input.media,
    id,
    ts,
    data: "",
    seq: 1,
    total: 999,
    filename: input.filename,
    mime: input.mime,
    totalBytes,
    caption: input.caption,
  };
  const firstOverhead = Buffer.byteLength(JSON.stringify(firstSample), "utf8");
  const firstDataRoom = MAX_ENVELOPE_BYTES - firstOverhead - 8;

  // Subsequent chunks omit the metadata fields → smaller overhead.
  const restSample: MediaMessage = {
    v: WIRE_VERSION,
    kind: "media",
    from: input.from,
    media: input.media,
    id,
    ts,
    data: "",
    seq: 999,
    total: 999,
  };
  const restOverhead = Buffer.byteLength(JSON.stringify(restSample), "utf8");
  const restDataRoom = MAX_ENVELOPE_BYTES - restOverhead - 8;

  // Each base64 char encodes 6 bits → 4 base64 chars per 3 source bytes.
  // Convert "room for base64 string" to "room for source bytes".
  const firstSrcBytes = Math.max(3, Math.floor(firstDataRoom / 4) * 3);
  const restSrcBytes = Math.max(3, Math.floor(restDataRoom / 4) * 3);

  const src = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const chunks: Buffer[] = [];
  let offset = 0;

  // First chunk (smaller, due to metadata)
  const firstSlice = src.subarray(offset, Math.min(offset + firstSrcBytes, src.length));
  chunks.push(firstSlice);
  offset += firstSlice.length;

  while (offset < src.length) {
    const slice = src.subarray(offset, Math.min(offset + restSrcBytes, src.length));
    chunks.push(slice);
    offset += slice.length;
  }

  const total = chunks.length;
  return chunks.map((chunk, idx) => {
    const env: MediaMessage = {
      v: WIRE_VERSION,
      kind: "media",
      from: input.from,
      media: input.media,
      id,
      ts,
      data: chunk.toString("base64"),
      seq: idx + 1,
      total,
    };
    if (idx === 0) {
      if (input.filename !== undefined) env.filename = input.filename;
      if (input.mime !== undefined) env.mime = input.mime;
      env.totalBytes = totalBytes;
      if (input.caption !== undefined) env.caption = input.caption;
    }
    return env;
  });
}

export type ReassembledMedia = {
  id: string;
  ts: number;
  from: "user" | "agent";
  media: MediaKind;
  bytes: Buffer;
  filename?: string;
  mime?: string;
  caption?: string;
};

/** Reassembler for media envelopes — collects binary chunks into a Buffer. */
export class MediaReassembler {
  private parts = new Map<
    string,
    {
      received: Map<number, MediaMessage>;
      total: number;
      firstTs: number;
      header?: {
        from: "user" | "agent";
        media: MediaKind;
        filename?: string;
        mime?: string;
        caption?: string;
        totalBytes?: number;
      };
    }
  >();

  gc(now = Date.now(), maxAgeMs = 60_000): void {
    for (const [id, st] of this.parts) {
      if (now - st.firstTs > maxAgeMs) this.parts.delete(id);
    }
  }

  push(env: MediaMessage): ReassembledMedia | null {
    const { id, seq, total } = env;
    if (seq < 1 || seq > total) return null;
    let st = this.parts.get(id);
    if (!st) {
      st = { received: new Map(), total, firstTs: env.ts };
      this.parts.set(id, st);
    }
    if (st.total !== total) return null;

    st.received.set(seq, env);
    if (seq === 1) {
      st.header = {
        from: env.from,
        media: env.media,
        filename: env.filename,
        mime: env.mime,
        caption: env.caption,
        totalBytes: env.totalBytes,
      };
    }
    if (st.received.size < total) return null;
    if (!st.header) return null; // never got the metadata; drop

    const parts: Buffer[] = [];
    for (let i = 1; i <= total; i++) {
      const part = st.received.get(i);
      if (!part) return null;
      parts.push(Buffer.from(part.data, "base64"));
    }
    const bytes = Buffer.concat(parts);
    if (st.header.totalBytes !== undefined && bytes.length !== st.header.totalBytes) {
      // Size mismatch — drop and let the sender retry. This is the most likely
      // tampering signal at the wire layer.
      this.parts.delete(id);
      return null;
    }
    this.parts.delete(id);
    return {
      id,
      ts: env.ts,
      from: st.header.from,
      media: st.header.media,
      bytes,
      filename: st.header.filename,
      mime: st.header.mime,
      caption: st.header.caption,
    };
  }
}

/** State for reassembling chunked messages keyed by envelope id. */
export class Reassembler<T extends UserMessage | AgentMessage> {
  private parts = new Map<
    string,
    { received: Map<number, T>; total: number; firstTs: number }
  >();

  /** Drop reassembly state for ids older than `maxAgeMs`. */
  gc(now: number = Date.now(), maxAgeMs = 60_000): void {
    for (const [id, state] of this.parts) {
      if (now - state.firstTs > maxAgeMs) this.parts.delete(id);
    }
  }

  /**
   * Feed one envelope. If the full message has now arrived, returns it
   * (with `text` concatenated). Otherwise returns null.
   */
  push(env: T): T | null {
    if (env.total === undefined || env.total === 1) {
      return env;
    }
    const seq = env.seq;
    const total = env.total;
    if (seq === undefined || seq < 1 || seq > total) return null;
    let st = this.parts.get(env.id);
    if (!st) {
      st = { received: new Map(), total, firstTs: env.ts };
      this.parts.set(env.id, st);
    }
    if (st.total !== total) return null; // contradictory total → drop
    st.received.set(seq, env);
    if (st.received.size < total) return null;
    let combined = "";
    for (let i = 1; i <= total; i++) {
      const part = st.received.get(i);
      if (!part) return null;
      combined += part.text;
    }
    this.parts.delete(env.id);
    return { ...env, text: combined, seq: undefined, total: undefined } as T;
  }
}
