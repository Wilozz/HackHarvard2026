import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChunks, CHUNK_MAX_MESSAGES, CHUNK_OVERLAP, type StoredMessage } from "../src/memory/chunker";

const start = Date.parse("2026-10-15T20:00:00Z");
const msg = (i: number, minutes: number): StoredMessage => ({
  id: `id${i}`,
  senderName: i % 2 ? "Harsh" : "Matias",
  body: `message ${i}`,
  sentAt: new Date(start + minutes * 60_000),
});

test("splits on a 45+ minute gap and carries 3 messages of overlap", () => {
  const messages = [msg(1, 0), msg(2, 1), msg(3, 2), msg(4, 3), msg(5, 60), msg(6, 61)];
  const chunks = buildChunks(messages, "UTC");
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0]!.messageIds, ["id1", "id2", "id3", "id4"]);
  assert.deepEqual(chunks[1]!.messageIds, ["id2", "id3", "id4", "id5", "id6"]);
});

test("caps chunks at 15 messages, each new chunk starting with the overlap", () => {
  const messages = Array.from({ length: 30 }, (_, i) => msg(i, i));
  const chunks = buildChunks(messages, "UTC");
  for (const c of chunks) assert.ok(c.messageIds.length <= CHUNK_MAX_MESSAGES);
  assert.deepEqual(chunks[1]!.messageIds.slice(0, CHUNK_OVERLAP), chunks[0]!.messageIds.slice(-CHUNK_OVERLAP));
  const covered = new Set(chunks.flatMap((c) => c.messageIds));
  assert.equal(covered.size, 30);
});

test("is deterministic, so unchanged chunks keep their hash", () => {
  const messages = [msg(1, 0), msg(2, 1), msg(3, 100)];
  const a = buildChunks(messages, "UTC").map((c) => c.contentHash);
  const b = buildChunks(messages, "UTC").map((c) => c.contentHash);
  assert.deepEqual(a, b);
  const extended = buildChunks([...messages, msg(4, 101)], "UTC").map((c) => c.contentHash);
  assert.equal(extended[0], a[0]);
  assert.notEqual(extended[1], a[1]);
});

test("formats transcript lines with time and speaker", () => {
  const [chunk] = buildChunks([msg(1, 14)], "UTC");
  assert.equal(chunk!.content, "[Oct 15, 8:14 PM] Harsh: message 1");
});

test("no messages, no chunks", () => {
  assert.deepEqual(buildChunks([], "UTC"), []);
});
