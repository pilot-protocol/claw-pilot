#!/usr/bin/env node
// Emit canonical wire-format fixtures used by Swift cross-language tests.
//
// We use a deterministic xorshift32 pseudo-random source so the bytes are
// reproducible across runs without depending on crypto.
//
// Output: JSON to stdout. Run:
//   node scripts/dump-fixtures.mjs > /tmp/fixtures.json
//
// Or pipe into the Swift fixture generator:
//   node scripts/dump-fixtures.mjs | node scripts/format-swift-fixture.mjs

import { chunkMedia, encodeEnvelope, WIRE_VERSION } from "../dist/wire.js";

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  };
}

function randomBytes(n, seed) {
  const rng = xorshift32(seed);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = rng();
  return out;
}

const fixtures = {};

// 1. Single text envelope.
{
  const env = {
    v: WIRE_VERSION,
    kind: "user",
    id: "abc",
    ts: 1_700_000_000_000,
    text: "hello",
  };
  fixtures["text:user:hello"] = Array.from(encodeEnvelope(env));
}

// 2. Single ack envelope.
{
  const env = { v: WIRE_VERSION, kind: "ack", id: "ack-1", ts: 1_700_000_000_001 };
  fixtures["ack:basic"] = Array.from(encodeEnvelope(env));
}

// 3. Single error envelope.
{
  const env = {
    v: WIRE_VERSION,
    kind: "error",
    id: "err-1",
    ts: 1_700_000_000_002,
    code: "MEDIA_TOO_LARGE",
    text: "attachment exceeded 25 MiB",
  };
  fixtures["error:media-too-large"] = Array.from(encodeEnvelope(env));
}

// 4. Multi-chunk image: 8 KiB of deterministic bytes.
const imageBytes = randomBytes(8 * 1024, 42);
const imageChunks = chunkMedia({
  from: "agent",
  media: "image",
  bytes: imageBytes,
  filename: "shot.png",
  mime: "image/png",
  caption: "here is your shot",
  id: "img-8k",
  ts: 1_700_000_000_003,
});

fixtures["media:image:8k:meta"] = {
  totalBytes: imageBytes.length,
  totalChunks: imageChunks.length,
  filename: "shot.png",
  mime: "image/png",
  from: "agent",
  media: "image",
  // Hash so Swift can confirm reassembly without us shipping the full bytes.
  sha256: await sha256(imageBytes),
};
fixtures["media:image:8k:chunks"] = imageChunks.map((c) => Array.from(encodeEnvelope(c)));

// 5. Multi-chunk file: 4 KiB of deterministic bytes.
const fileBytes = randomBytes(4 * 1024, 7);
const fileChunks = chunkMedia({
  from: "user",
  media: "file",
  bytes: fileBytes,
  filename: "data.bin",
  id: "file-4k",
  ts: 1_700_000_000_004,
});

fixtures["media:file:4k:meta"] = {
  totalBytes: fileBytes.length,
  totalChunks: fileChunks.length,
  filename: "data.bin",
  from: "user",
  media: "file",
  sha256: await sha256(fileBytes),
};
fixtures["media:file:4k:chunks"] = fileChunks.map((c) => Array.from(encodeEnvelope(c)));

process.stdout.write(JSON.stringify(fixtures, null, 2));

async function sha256(buf) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex");
}
