// Load data/seed-chat.json into a chat's memory so you can demo without
// typing a day of messages. Usage:
//   npm run seed:chat                      → terminal chat "terminal:chat-1"
//   npm run seed:chat -- imessage:<chat id> → a real iMessage chat id
import { readFileSync } from "node:fs";
import { z } from "zod";
import { getDb } from "../src/db";
import { flushIndex, storeMessage } from "../src/memory/ingest";

const seedSchema = z.object({
  messages: z.array(z.object({ at: z.string(), from: z.string(), text: z.string() })),
});

const chatId = process.argv[2] ?? "terminal:chat-1";
const seed = seedSchema.parse(JSON.parse(readFileSync("data/seed-chat.json", "utf8")));

const db = await getDb();
for (const [i, m] of seed.messages.entries()) {
  await storeMessage({
    id: `seed-${chatId}-${i}`,
    chatId,
    sender: undefined,
    senderName: m.from,
    body: m.text,
    sentAt: new Date(m.at),
    isAgent: false,
  });
}
console.log(`Stored ${seed.messages.length} messages in ${chatId}. Embedding (first run downloads the model)...`);
await flushIndex(chatId);
const [row] = await db.query<{ n: string | number }>(`select count(*) as n from chunks where chat_id = $1`, [chatId]);
console.log(`Indexed ${row?.n ?? 0} chunks.`);
await db.close();
process.exit(0);
