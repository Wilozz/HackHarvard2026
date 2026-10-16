import { createHash } from "node:crypto";

export interface StoredMessage {
  id: string;
  senderName: string;
  body: string;
  sentAt: Date;
}

export interface Chunk {
  messageIds: string[];
  participants: string[];
  content: string;
  contentHash: string;
  startAt: Date;
  endAt: Date;
}

export const CHUNK_GAP_MS = 45 * 60 * 1000;
export const CHUNK_MAX_MESSAGES = 15;
export const CHUNK_OVERLAP = 3;

export function formatStamp(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** One transcript line per message: `[Dec 3, 8:14 PM] Harsh: I'm free after the 18th`. */
export function transcriptLine(m: StoredMessage, timeZone: string): string {
  return `[${formatStamp(m.sentAt, timeZone)}] ${m.senderName}: ${m.body}`;
}

/**
 * Group consecutive messages into conversation windows. A new chunk starts
 * after a 45-minute gap or once a chunk holds 15 messages; each new chunk
 * repeats the last 3 messages of the previous one so short replies ("same",
 * "im down") keep their context. Input must be sorted by sentAt.
 *
 * Deterministic: the same messages always produce the same chunks, so the
 * index can be rebuilt and only changed chunks get re-embedded.
 */
export function buildChunks(messages: StoredMessage[], timeZone: string): Chunk[] {
  const windows: StoredMessage[][] = [];
  let current: StoredMessage[] = [];

  for (const m of messages) {
    const last = current[current.length - 1];
    const gap = last ? m.sentAt.getTime() - last.sentAt.getTime() > CHUNK_GAP_MS : false;
    if (last && (gap || current.length >= CHUNK_MAX_MESSAGES)) {
      windows.push(current);
      current = current.slice(-CHUNK_OVERLAP);
    }
    current.push(m);
  }
  if (current.length > 0) windows.push(current);

  return windows.map((w) => {
    const content = w.map((m) => transcriptLine(m, timeZone)).join("\n");
    const messageIds = w.map((m) => m.id);
    return {
      messageIds,
      participants: [...new Set(w.map((m) => m.senderName))],
      content,
      contentHash: createHash("sha256").update(messageIds.join("\u0000")).update("\u0001").update(content).digest("hex"),
      startAt: w[0]!.sentAt,
      endAt: w[w.length - 1]!.sentAt,
    };
  });
}
