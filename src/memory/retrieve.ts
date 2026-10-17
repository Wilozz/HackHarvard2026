import { config } from "../config";
import { getDb, toVector } from "../db";
import { formatStamp, transcriptLine, type StoredMessage } from "./chunker";
import { embedQueries } from "./embed";
import { loadHumanMessages, loadRecentMessages } from "./ingest";

export interface TemplateQuestion {
  slot: string;
  question: string;
  /** websearch_to_tsquery terms for the keyword pass (exact words embed poorly). */
  keywords: string;
}

export const TRIP_TEMPLATE: TemplateQuestion[] = [
  {
    slot: "availability",
    question: "When is each person free or busy? Which dates or weekends work or don't work?",
    keywords:
      "free or busy or available or dates or weekend or work or off or jan or feb or mar or apr or may or jun or jul or aug or sep or oct or nov or dec",
  },
  {
    slot: "destination",
    question: "Where does everyone want to go, and which places were ruled out?",
    keywords: "go or trip or visit or city or beach or mountains or skiing or abroad or drive",
  },
  {
    slot: "budget",
    question: "How much is each person willing to spend? Any money concerns?",
    keywords: "budget or spend or cost or price or afford or cheap or expensive or money or broke",
  },
  {
    slot: "lodging",
    question: "Hotel, Airbnb, or hostel? Room-sharing preferences?",
    keywords: "hotel or airbnb or hostel or room or rooms or bed or share or stay",
  },
  {
    slot: "activities",
    question: "What does everyone want to do on the trip?",
    keywords: "ski or hike or eat or food or bar or club or museum or show or tour or beach",
  },
  {
    slot: "constraints",
    question: "Dietary restrictions, allergies, accessibility, or anything someone can't do?",
    keywords: "vegetarian or vegan or allergic or allergy or gluten or halal or kosher or wheelchair or accessible",
  },
  {
    slot: "logistics",
    question: "Where is everyone traveling from? Who has a car or is driving?",
    keywords: "car or drive or driving or flight or fly or train or bus or from or pick",
  },
  {
    slot: "commitment",
    question: "Who's in, who's out, and who's a maybe?",
    keywords: "in or out or maybe or down or cannot or coming or bail or skip",
  },
];

interface ChunkHit {
  id: string;
  messageIds: string[];
  score: number;
  via: "vector" | "keyword";
}

export interface SlotDebug {
  slot: string;
  question: string;
  hits: { chunkId: string; score: number; via: string; preview: string }[];
}

export interface RetrievedContext {
  /** Chronological transcript with [mN] refs the model can cite. */
  transcript: string;
  /** mN → message id. */
  refs: Map<string, string>;
  /** mN → speaker name. */
  speakers: Map<string, string>;
  debug: SlotDebug[];
  messageCount: number;
}

const TOP_K = 5;
const NEIGHBORS = 2;

async function vectorSearch(chatId: string, embedding: number[], k: number): Promise<ChunkHit[]> {
  const db = await getDb();
  const rows = await db.query<{ id: string | number; message_ids: string[]; score: number }>(
    `select id, message_ids, 1 - (embedding <=> $1::vector) as score
     from chunks where chat_id = $2
     order by embedding <=> $1::vector
     limit $3`,
    [toVector(embedding), chatId, k],
  );
  return rows.map((r) => ({ id: String(r.id), messageIds: r.message_ids, score: Number(r.score), via: "vector" }));
}

async function keywordSearch(chatId: string, terms: string, k: number): Promise<ChunkHit[]> {
  if (!terms.trim()) return [];
  const db = await getDb();
  const rows = await db.query<{ id: string | number; message_ids: string[]; score: number }>(
    `select id, message_ids, ts_rank(fts, q) as score
     from chunks, websearch_to_tsquery('english', $2) q
     where chat_id = $1 and fts @@ q
     order by score desc
     limit $3`,
    [chatId, terms, k],
  );
  return rows.map((r) => ({ id: String(r.id), messageIds: r.message_ids, score: Number(r.score), via: "keyword" }));
}

/** Pull distinctive tokens (numbers, $amounts, dates, capitalized words) out of a request. */
export function requestKeywords(text: string): string {
  const tokens = text.match(/\$?\d[\d,.]*|[A-Z][a-z]{2,}/g) ?? [];
  const cleaned = tokens.map((t) => t.replace(/[$,]/g, "")).filter((t) => t.length > 1);
  return [...new Set(cleaned)].join(" or ");
}

async function chunkPreviews(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = await getDb();
  const rows = await db.query<{ id: string | number; content: string }>(
    `select id, content from chunks where id = any($1::bigint[])`,
    [ids],
  );
  return new Map(rows.map((r) => [String(r.id), r.content.slice(0, 160)]));
}

/**
 * Run the template questions (plus the raw request) against this chat's
 * chunks, merge vector and keyword hits, and widen each hit by its
 * neighboring messages. Returns the matched messages oldest first, so the
 * latest statement reads as the truth.
 */
async function retrieveMessages(
  chatId: string,
  request: string,
  template: TemplateQuestion[],
): Promise<{ messages: StoredMessage[]; debug: SlotDebug[] }> {
  const questions: TemplateQuestion[] = [
    ...template,
    { slot: "request", question: request || "trip plans", keywords: requestKeywords(request) },
  ];

  // One model call for every question, then all searches in parallel: each
  // query is a network round trip when the database is Supabase.
  const embeddings = await embedQueries(questions.map((q) => q.question));
  const perQuestion = await Promise.all(
    questions.map(async (q, i) => [
      ...(await vectorSearch(chatId, embeddings[i]!, TOP_K)),
      ...(await keywordSearch(chatId, q.keywords, TOP_K)),
    ]),
  );

  const hitsByChunk = new Map<string, ChunkHit>();
  const debug: SlotDebug[] = questions.map((q, i) => {
    const hits = perQuestion[i]!;
    for (const h of hits) if (!hitsByChunk.has(h.id)) hitsByChunk.set(h.id, h);
    return { slot: q.slot, question: q.question, hits: hits.map((h) => ({ chunkId: h.id, score: h.score, via: h.via, preview: "" })) };
  });

  const previews = await chunkPreviews([...hitsByChunk.keys()]);
  for (const d of debug) for (const h of d.hits) h.preview = previews.get(h.chunkId) ?? "";

  const all = await loadHumanMessages(chatId);
  const position = new Map(all.map((m, i) => [m.id, i]));
  const selected = new Set<number>();
  for (const hit of hitsByChunk.values()) {
    for (const id of hit.messageIds) {
      const i = position.get(id);
      if (i === undefined) continue;
      for (let j = Math.max(0, i - NEIGHBORS); j <= Math.min(all.length - 1, i + NEIGHBORS); j++) selected.add(j);
    }
  }
  return { messages: [...selected].sort((a, b) => a - b).map((i) => all[i]!), debug };
}

/** Template retrieval with [mN] refs, for the planner. */
export async function retrieve(
  chatId: string,
  request: string,
  template: TemplateQuestion[] = TRIP_TEMPLATE,
): Promise<RetrievedContext> {
  const { messages, debug } = await retrieveMessages(chatId, request, template);
  return toTranscript(messages, debug);
}

/** Retrieval for a free-form question: the question plus its keywords, no template. */
export async function retrieveForQuestion(chatId: string, question: string): Promise<RetrievedContext> {
  return retrieve(chatId, question, []);
}

export interface ChatContext {
  /** Transcript lines (`[Oct 16, 8:14 PM] Harsh: ...`), oldest first. */
  transcript: string;
  debug: SlotDebug[];
  messageCount: number;
}

/**
 * Context for answering a mention: the passages the trip template and the
 * request retrieve from the whole history, plus the latest `recent` messages
 * (the agent's own replies included) so the conversation in progress reads
 * naturally. Merged and sorted by time, capped at `maxMessages` newest.
 */
export async function contextForRequest(
  chatId: string,
  request: string,
  opts: { recent?: number; maxMessages?: number } = {},
): Promise<ChatContext> {
  const [{ messages: retrieved, debug }, recent] = await Promise.all([
    retrieveMessages(chatId, request, TRIP_TEMPLATE),
    loadRecentMessages(chatId, opts.recent ?? 20),
  ]);
  const byId = new Map<string, StoredMessage>();
  for (const m of [...retrieved, ...recent]) byId.set(m.id, m);
  const merged = [...byId.values()]
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-(opts.maxMessages ?? 300));
  return {
    transcript: merged.map((m) => transcriptLine(m, config.TRIP_TIMEZONE)).join("\n"),
    debug,
    messageCount: merged.length,
  };
}

function toTranscript(messages: StoredMessage[], debug: SlotDebug[]): RetrievedContext {
  const refs = new Map<string, string>();
  const speakers = new Map<string, string>();
  const lines = messages.map((m, i) => {
    const ref = `m${i + 1}`;
    refs.set(ref, m.id);
    speakers.set(ref, m.senderName);
    return `[${ref}] ${formatStamp(m.sentAt, config.TRIP_TIMEZONE)} ${m.senderName}: ${m.body}`;
  });
  return { transcript: lines.join("\n"), refs, speakers, debug, messageCount: messages.length };
}
