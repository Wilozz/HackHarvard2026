// Memory database tools (Supabase or any Postgres in DATABASE_URL; PGlite otherwise).
//   npm run db:setup     create the extension, tables, indexes and row level security (idempotent)
//   npm run db:check     read-only report: pgvector, tables, RLS, indexes, row counts
//   npm run db:selftest  store → embed → retrieve round trip in a scratch chat, then delete it
import { randomUUID } from "node:crypto";
import pg from "pg";
import { config } from "../src/config";
import { getDb, postgresConnection, TABLES } from "../src/db";
import { flushIndex, storeMessages } from "../src/memory/ingest";
import { contextForRequest } from "../src/memory/retrieve";

const command = process.argv[2];

function where(): string {
  if (!config.DATABASE_URL) return `embedded PGlite (${config.PGLITE_DIR})`;
  const url = new URL(config.DATABASE_URL);
  return `${url.hostname} as ${decodeURIComponent(url.username)}`;
}

async function setup(): Promise<void> {
  const db = await getDb(); // applies the schema
  await db.close();
  console.log(`Schema applied on ${where()}.`);
  await check();
}

/** Read-only: one connection, inside a read-only transaction that is rolled back. */
async function check(): Promise<void> {
  if (!config.DATABASE_URL) {
    console.log(`DATABASE_URL is empty, so memory lives in ${where()}. Nothing to check remotely.`);
    return;
  }
  const client = new pg.Client({ ...postgresConnection(config.DATABASE_URL), connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    await client.query("begin read only");
    const ext = await client.query<{ extversion: string; nspname: string }>(
      `select e.extversion, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector'`,
    );
    const tables = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])`,
      [[...TABLES]],
    );
    const indexes = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'chunks' order by 1`,
    );

    console.log(`Connected to ${where()} (TLS: ${(client as unknown as { connection: { stream: { encrypted?: boolean } } }).connection.stream.encrypted ? "on" : "off"}).`);
    console.log(`pgvector: ${ext.rows[0] ? `${ext.rows[0].extversion} in schema "${ext.rows[0].nspname}"` : "not installed (run npm run db:setup)"}`);
    const found = new Map(tables.rows.map((r) => [r.relname, r.relrowsecurity]));
    for (const table of TABLES) {
      if (!found.has(table)) {
        console.log(`  ${table.padEnd(16)} missing (run npm run db:setup)`);
        continue;
      }
      const { rows } = await client.query<{ n: string }>(`select count(*) as n from public.${table}`);
      console.log(`  ${table.padEnd(16)} ${String(rows[0]?.n ?? 0).padStart(6)} rows   RLS ${found.get(table) ? "on" : "OFF: readable through the Data API"}`);
    }
    if (found.has("chunks")) console.log(`chunks indexes: ${indexes.rows.map((r) => r.indexname).join(", ")}`);
    if (found.has("messages")) {
      const chats = await client.query<{ chat_id: string; messages: string; chunks: string }>(
        `select m.chat_id, count(*) as messages, (select count(*) from chunks c where c.chat_id = m.chat_id) as chunks
         from messages m group by m.chat_id order by count(*) desc limit 10`,
      );
      for (const c of chats.rows) console.log(`  chat ${c.chat_id}: ${c.messages} messages, ${c.chunks} chunks`);
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

/** Write path end to end, in a chat id nothing else uses, removed afterwards even on failure. */
async function selftest(): Promise<void> {
  const chatId = `selftest:${randomUUID()}`;
  const db = await getDb();
  const t0 = Date.now();
  try {
    const base = Date.parse("2026-10-15T00:00:00Z");
    const said = [
      ["Harsh", "I have finals until the 18th so anything after that works"],
      ["wiloz", "budget wise I can do $300 max for the whole trip"],
      ["Matias", "Montreal would be sick, the bagels alone"],
      ["Hetarth", "I'm vegetarian, so somewhere with real food options"],
    ] as const;
    await storeMessages(
      said.map(([senderName, body], i) => ({
        id: `${chatId}:${i}`,
        chatId,
        sender: undefined,
        senderName,
        body,
        sentAt: new Date(base + i * 60_000),
        isAgent: false,
      })),
    );
    await flushIndex(chatId);
    const [chunks] = await db.query<{ n: string }>(`select count(*) as n from chunks where chat_id = $1`, [chatId]);
    const ctx = await contextForRequest(chatId, "where should we go and what's the budget?");
    const ok = said.every(([, body]) => ctx.transcript.includes(body));
    console.log(`Stored ${said.length} messages, indexed ${chunks?.n ?? 0} chunk(s), retrieved ${ctx.messageCount} message(s) across ${ctx.debug.length} questions in ${Date.now() - t0} ms.`);
    if (!ok) throw new Error("retrieval did not return the stored messages");
    console.log(`Self-test passed on ${where()}.`);
  } finally {
    await db.query(`delete from chunks where chat_id = $1`, [chatId]);
    await db.query(`delete from messages where chat_id = $1`, [chatId]);
    await db.query(`delete from forgotten_chats where chat_id = $1`, [chatId]);
    await db.close();
  }
}

const commands: Record<string, () => Promise<void>> = { setup, check, selftest };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error("Usage: tsx scripts/db.ts setup | check | selftest");
  process.exit(2);
}
run().then(
  () => process.exit(0),
  (err) => {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
