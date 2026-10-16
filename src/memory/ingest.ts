import { config } from "../config";
import { getDb, toVector } from "../db";
import { log } from "../log";
import { buildChunks, type StoredMessage } from "./chunker";
import { embedPassages } from "./embed";

export interface IncomingMessage {
  id: string;
  chatId: string;
  sender: string | undefined;
  senderName: string;
  body: string;
  sentAt: Date;
  isAgent: boolean;
}

const REINDEX_DEBOUNCE_MS = 4000;
const EMBED_BATCH = 16;

/** Save the raw message. Embeddings can always be rebuilt from this table. */
export async function storeMessage(m: IncomingMessage): Promise<void> {
  const db = await getDb();
  await db.query(
    `insert into messages (id, chat_id, sender, sender_name, body, sent_at, is_agent)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [m.id, m.chatId, m.sender ?? null, m.senderName, m.body, m.sentAt, m.isAgent],
  );
  if (!m.isAgent) scheduleReindex(m.chatId);
}

export async function loadHumanMessages(chatId: string): Promise<StoredMessage[]> {
  const db = await getDb();
  const rows = await db.query<{ id: string; sender_name: string | null; body: string | null; sent_at: Date }>(
    `select id, sender_name, body, sent_at from messages
     where chat_id = $1 and not is_agent and body is not null and body <> ''
     order by sent_at, id`,
    [chatId],
  );
  return rows.map((r) => ({
    id: r.id,
    senderName: r.sender_name ?? "Someone",
    body: r.body ?? "",
    sentAt: new Date(r.sent_at),
  }));
}

/**
 * Rebuild this chat's chunks from the messages table. Chunks whose content is
 * unchanged keep their embedding; only new or changed chunks are embedded.
 */
async function reindex(chatId: string): Promise<void> {
  const db = await getDb();
  const chunks = buildChunks(await loadHumanMessages(chatId), config.TRIP_TIMEZONE);
  const existing = new Set(
    (await db.query<{ content_hash: string }>(`select content_hash from chunks where chat_id = $1`, [chatId])).map(
      (r) => r.content_hash,
    ),
  );
  const wanted = new Set(chunks.map((c) => c.contentHash));
  const stale = [...existing].filter((h) => !wanted.has(h));
  const missing = chunks.filter((c) => !existing.has(c.contentHash));

  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vectors = await embedPassages(batch.map((c) => c.content));
    for (const [j, c] of batch.entries()) {
      await db.query(
        `insert into chunks (chat_id, content, content_hash, message_ids, participants, start_at, end_at, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8::vector)
         on conflict (chat_id, content_hash) do nothing`,
        [chatId, c.content, c.contentHash, c.messageIds, c.participants, c.startAt, c.endAt, toVector(vectors[j]!)],
      );
    }
  }
  if (stale.length > 0) {
    await db.query(`delete from chunks where chat_id = $1 and content_hash = any($2::text[])`, [chatId, stale]);
  }
  if (missing.length > 0 || stale.length > 0) {
    log.info("reindex", { chatId, chunks: chunks.length, embedded: missing.length, removed: stale.length });
  }
}

// One reindex at a time per chat; bursts of messages collapse into one run.
const timers = new Map<string, NodeJS.Timeout>();
const running = new Map<string, Promise<void>>();

function runReindex(chatId: string): Promise<void> {
  const previous = running.get(chatId) ?? Promise.resolve();
  const next = previous
    .then(() => reindex(chatId))
    .catch((err) => log.error("reindex_failed", err, { chatId }));
  running.set(chatId, next);
  return next;
}

export function scheduleReindex(chatId: string): void {
  const t = timers.get(chatId);
  if (t) clearTimeout(t);
  timers.set(
    chatId,
    setTimeout(() => {
      timers.delete(chatId);
      void runReindex(chatId);
    }, REINDEX_DEBOUNCE_MS),
  );
}

/** Make sure every stored message is searchable before planning or answering. */
export async function flushIndex(chatId: string): Promise<void> {
  const t = timers.get(chatId);
  if (t) clearTimeout(t);
  timers.delete(chatId);
  await runReindex(chatId);
}

/** `@Tripchat forget`: delete everything stored for this chat. */
export async function forgetChat(chatId: string): Promise<void> {
  const t = timers.get(chatId);
  if (t) clearTimeout(t);
  timers.delete(chatId);
  await (running.get(chatId) ?? Promise.resolve());
  const db = await getDb();
  await db.query(`delete from chunks where chat_id = $1`, [chatId]);
  await db.query(`delete from messages where chat_id = $1`, [chatId]);
  await db.query(`delete from trips where chat_id = $1`, [chatId]);
}
