import { config } from "../config";
import { getDb, toVector } from "../db";
import { formatStamp, type StoredMessage } from "./chunker";
import { embedQuery } from "./embed";
import { loadHumanMessages } from "./ingest";

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

async function vectorSearch(chatId: string, query: string, k: number): Promise<ChunkHit[]> {
  const db = await getDb();
  const vec = toVector(await embedQuery(query));
  const rows = await db.query<{ id: string | number; message_ids: string[]; score: number }>(
    `select id, message_ids, 1 - (embedding <=> $1::vector) as score
     from chunks where chat_id = $2
     order by embedding <=> $1::vector
     limit $3`,
    [vec, chatId, k],
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
 * chunks, merge vector and keyword hits, widen each hit by its neighboring
 * messages, and return one chronological transcript. Sorting by time lets the
 * model treat the latest statement as the truth.
 */
export async function retrieve(
  chatId: string,
  request: string,
  template: TemplateQuestion[] = TRIP_TEMPLATE,
): Promise<RetrievedContext> {
  const questions: TemplateQuestion[] = [
    ...template,
    { slot: "request", question: request, keywords: requestKeywords(request) },
  ];

  const hitsByChunk = new Map<string, ChunkHit>();
  const debug: SlotDebug[] = [];
  for (const q of questions) {
    const hits = [...(await vectorSearch(chatId, q.question, TOP_K)), ...(await keywordSearch(chatId, q.keywords, TOP_K))];
    debug.push({ slot: q.slot, question: q.question, hits: hits.map((h) => ({ chunkId: h.id, score: h.score, via: h.via, preview: "" })) });
    for (const h of hits) if (!hitsByChunk.has(h.id)) hitsByChunk.set(h.id, h);
  }

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

  const picked: StoredMessage[] = [...selected].sort((a, b) => a - b).map((i) => all[i]!);
  return toTranscript(picked, debug);
}

/** Retrieval for a free-form question: the question plus its keywords, no template. */
export async function retrieveForQuestion(chatId: string, question: string): Promise<RetrievedContext> {
  return retrieve(chatId, question, []);
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
