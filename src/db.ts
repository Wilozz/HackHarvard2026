import { config } from "./config";
import { log } from "./log";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements with no parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// Applied on every start; every statement is idempotent. The same SQL runs on
// Supabase (or any Postgres with pgvector) and on embedded PGlite.
export const SCHEMA = `
-- Supabase keeps extensions in the "extensions" schema (on the default
-- search_path); plain Postgres and PGlite don't have one.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension if not exists vector with schema extensions;
  else
    create extension if not exists vector;
  end if;
end
$$;

create table if not exists messages (
  id          text primary key,
  chat_id     text not null,
  sender      text,
  sender_name text,
  body        text,
  sent_at     timestamptz not null,
  is_agent    boolean not null default false
);
create index if not exists messages_chat_time on messages (chat_id, sent_at);

create table if not exists chunks (
  id           bigserial primary key,
  chat_id      text not null,
  content      text not null,
  content_hash text not null,
  message_ids  text[] not null,
  participants text[] not null,
  start_at     timestamptz not null,
  end_at       timestamptz not null,
  embedding    vector(${config.embedDim}) not null,
  fts          tsvector generated always as (to_tsvector('english', content)) stored,
  unique (chat_id, content_hash)
);
create index if not exists chunks_embedding on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts on chunks using gin (fts);

create table if not exists trips (
  chat_id    text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Balance adjustments we made through the bank. The Nessie sandbox records
-- withdrawals and deposits but never updates an account's balance field, so
-- balance = opening balance + sum(delta).
create table if not exists ledger (
  id         bigserial primary key,
  account_id text not null,
  delta      numeric not null,
  ref        text not null,
  created_at timestamptz not null default now(),
  unique (account_id, ref)
);

-- "@Tripchat forget" cutoffs: messages sent at or before this time are never
-- stored again, even when a backfill re-reads them from Photon.
create table if not exists forgotten_chats (
  chat_id      text primary key,
  forgotten_at timestamptz not null
);

-- Supabase exposes the public schema through its Data API (anon and
-- authenticated keys). Row level security with no policies blocks that API
-- entirely; Tripchat connects as the table owner, which RLS doesn't restrict.
alter table messages enable row level security;
alter table chunks enable row level security;
alter table trips enable row level security;
alter table ledger enable row level security;
alter table forgotten_chats enable row level security;
`;

export const TABLES = ["messages", "chunks", "trips", "ledger", "forgotten_chats"] as const;

async function openPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const pg = await PGlite.create({ dataDir: config.PGLITE_DIR, extensions: { vector } });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params);
      return res.rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
}

/**
 * Connection settings for a Postgres URL. Supabase accepts plaintext
 * connections, so TLS is turned on explicitly there. Its certificates chain to
 * Supabase's own CA, which Node doesn't ship, so the connection is encrypted
 * without verifying that chain. Other hosts follow the URL's sslmode.
 */
export function postgresConnection(url: string): { connectionString: string; ssl?: { rejectUnauthorized: false } } {
  const supabase = /\.supabase\.(co|com)$/.test(new URL(url).hostname);
  return { connectionString: url, ...(supabase ? { ssl: { rejectUnauthorized: false } } : {}) };
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    ...postgresConnection(url),
    // Supabase's session pooler allows a limited number of connections per project.
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  // The pooler can drop idle connections; without a listener that error would crash the process.
  pool.on("error", (err) => log.error("db_pool_error", err));
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

let dbPromise: Promise<Db> | undefined;

export function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const db = config.DATABASE_URL ? await openPostgres(config.DATABASE_URL) : await openPglite();
    await db.exec(SCHEMA);
    return db;
  })();
  return dbPromise;
}

/** pgvector literal for a float array, passed as a `$n::vector` parameter. */
export function toVector(v: Float32Array | number[]): string {
  return `[${Array.from(v).join(",")}]`;
}
