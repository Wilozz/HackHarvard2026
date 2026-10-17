import { findMention } from "../agent/commands";
import { suggestTrip } from "../agent/suggest";
import { config } from "../config";
import { getDb } from "../db";
import { startDebugServer } from "../debug";
import { log } from "../log";
import { findMemberByHandle, guestName, type Member } from "../members";
import { transcriptLine } from "../memory/chunker";
import { flushIndex, forgetChat, storeMessages, type IncomingMessage } from "../memory/ingest";
import { contextForRequest, type SlotDebug } from "../memory/retrieve";
import { createPhotonClient, type PhotonApi, type PhotonContent, type PhotonMessage, type PhotonUser } from "./api";

/** Each poll re-lists this far back, since createdAt order can lag arrival order. Seen ids dedupe the overlap. */
const LOOKBACK_MS = 10_000;
/** Upper bound on the fallback transcript sent to Claude, newest messages kept. */
const MAX_TRANSCRIPT_MESSAGES = 2000;
/** A 202 from Photon only means accepted; check the real status this long after sending. */
const DELIVERY_CHECK_MS = 20_000;
/** Messages per database write during the startup backfill. */
const BACKFILL_BATCH = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain text for a message, or undefined for content with nothing to read (typing, read receipts). */
export function messageText(content: PhotonContent): string | undefined {
  if (content.type === "text") return content.text?.replace(/￼/g, "").trim() || undefined;
  if (content.type === "attachment") return "[shared a file]";
  if (content.type === "group") {
    const parts = (content.parts ?? []).map(messageText).filter((t): t is string => !!t);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

/**
 * Only an explicit "forget" (after the mention is removed) wipes memory. DMs
 * need no mention, so a looser match would let "delete the hotel idea" erase
 * the chat.
 */
export function isForgetCommand(body: string): boolean {
  return /^(?:please\s+)?(?:forget|wipe)(?:\s+(?:everything|it all|all of it|this chat|this conversation|us|me))?[.!]*$/i.test(body.trim());
}

/** The LLM step, injectable so the loop can be tested without API calls. */
export interface PhotonBrain {
  suggestTrip: typeof suggestTrip;
}

/** Long-term chat memory (Postgres/Supabase + pgvector), injectable for tests. */
export interface PhotonMemory {
  store(messages: IncomingMessage[]): Promise<void>;
  /** Retrieved and recent messages for answering `request`, as transcript lines. */
  context(chatId: string, request: string): Promise<{ transcript: string; debug: SlotDebug[] }>;
  forget(chatId: string, at: Date): Promise<void>;
  /** Every chat's "forget" cutoff. */
  cutoffs(): Promise<Map<string, Date>>;
}

export const databaseMemory: PhotonMemory = {
  store: storeMessages,
  async context(chatId, request) {
    await flushIndex(chatId);
    return contextForRequest(chatId, request);
  },
  forget: forgetChat,
  async cutoffs() {
    const db = await getDb();
    const rows = await db.query<{ chat_id: string; forgotten_at: Date }>(`select chat_id, forgotten_at from forgotten_chats`);
    return new Map(rows.map((r) => [r.chat_id, new Date(r.forgotten_at)]));
  },
};

/**
 * Tripchat on Photon 2.0 beta: polls for received iMessages, saves every
 * message to the memory database (with a full backfill from Photon on
 * start), and answers mentions (every message in a DM) with a trip
 * suggestion built from retrieved and recent messages.
 */
export class PhotonAgent {
  private agentIds = new Set<string>();
  /** Newest createdAt seen, in ms. Polls list from here minus LOOKBACK_MS. */
  private cursorMs = 0;
  /** Message id → createdAt ms, for ids still inside the lookback window. */
  private readonly seen = new Map<string, number>();
  /** Replies for one Space run in order; different Spaces run in parallel. */
  private readonly queues = new Map<string, Promise<void>>();
  /** chatId → "forget" cutoff, so the no-database fallback never reads forgotten messages either. */
  private readonly forgotten = new Map<string, Date>();
  /** Latest retrieval per chat, for the local debug page. */
  readonly recent = new Map<string, { chatId: string; phase: string; lastRetrieval?: SlotDebug[] }>();

  private readonly brain: PhotonBrain;
  private readonly memory: PhotonMemory;
  private readonly replySpaces: ReadonlyMap<string, string>;

  constructor(
    private readonly api: PhotonApi,
    private readonly roster: Member[],
    opts: { brain?: PhotonBrain; memory?: PhotonMemory; replySpaces?: ReadonlyMap<string, string> } = {},
  ) {
    this.brain = opts.brain ?? { suggestTrip };
    this.memory = opts.memory ?? databaseMemory;
    this.replySpaces = opts.replySpaces ?? config.photonReplySpaces;
  }

  /**
   * Learn which Users are ours, copy the chat history into memory, then mark
   * everything already in Photon as seen so old messages never get answers.
   */
  async start(): Promise<void> {
    const ids = config.PHOTON_AGENT_USER_ID ? [config.PHOTON_AGENT_USER_ID] : await this.api.listAgentUserIds();
    if (ids.length === 0) throw new Error("This Photon project has no agent User. Set PHOTON_AGENT_USER_ID.");
    this.agentIds = new Set(ids);

    try {
      for (const [chatId, at] of await this.memory.cutoffs()) this.forgotten.set(chatId, at);
      await this.backfill();
    } catch (err) {
      // The agent still answers without memory (see transcript()), so don't stop here.
      log.error("photon_backfill_failed", err);
    }

    // Start from the newest message's server timestamp, not this machine's clock.
    this.cursorMs = Date.now();
    for await (const m of this.api.listMessages({ platform: "imessage", direction: "received", order: "desc", pageSize: 1 })) {
      this.cursorMs = Date.parse(m.createdAt);
      break;
    }
    await this.poll({ prime: true });
    log.info("photon_ready", { agents: ids.length, members: this.roster.length });
  }

  /** Copy every iMessage in the project, both directions, into memory. Already-stored ones are skipped by id. */
  private async backfill(): Promise<void> {
    let batch: IncomingMessage[] = [];
    let total = 0;
    for await (const m of this.api.listMessages({ platform: "imessage", order: "asc" })) {
      const incoming = this.toIncoming(m);
      if (!incoming) continue;
      batch.push(incoming);
      if (batch.length >= BACKFILL_BATCH) {
        await this.memory.store(batch);
        total += batch.length;
        batch = [];
      }
    }
    await this.memory.store(batch);
    total += batch.length;
    log.info("photon_backfill", { messages: total });
  }

  /** One pass over recently received messages. New ones are saved, then each is queued on its Space. */
  async poll(opts: { prime?: boolean } = {}): Promise<void> {
    const since = new Date(this.cursorMs - LOOKBACK_MS).toISOString();
    const fresh: PhotonMessage[] = [];
    for await (const m of this.api.listMessages({ platform: "imessage", direction: "received", order: "asc", createdSince: since })) {
      if (this.seen.has(m.id)) continue;
      const at = Date.parse(m.createdAt);
      this.seen.set(m.id, at);
      this.cursorMs = Math.max(this.cursorMs, at);
      fresh.push(m);
    }
    for (const [id, at] of this.seen) if (at < this.cursorMs - LOOKBACK_MS) this.seen.delete(id);

    // Save before answering, so a reply can retrieve the message that asked for it.
    const incoming = fresh.map((m) => this.toIncoming(m)).filter((m): m is IncomingMessage => !!m);
    try {
      await this.memory.store(incoming);
    } catch (err) {
      log.error("photon_store_failed", err, { messages: incoming.length });
    }
    if (!opts.prime) for (const m of fresh) this.enqueue(m.space.id, () => this.handle(m));
  }

  /** Poll forever, backing off after failures. */
  async run(): Promise<never> {
    let failures = 0;
    for (;;) {
      try {
        await this.poll();
        failures = 0;
      } catch (err) {
        failures++;
        log.error("photon_poll_failed", err, { failures });
      }
      await sleep(failures === 0 ? config.PHOTON_POLL_MS : Math.min(60_000, config.PHOTON_POLL_MS * 2 ** failures));
    }
  }

  /** Resolves once every queued reply has finished. */
  async idle(): Promise<void> {
    await Promise.all(this.queues.values());
  }

  private enqueue(spaceId: string, task: () => Promise<void>): void {
    const next = (this.queues.get(spaceId) ?? Promise.resolve())
      .then(task)
      .catch((err) => log.error("photon_reply_failed", err, { spaceId }));
    this.queues.set(spaceId, next);
  }

  /** One memory chat per conversation: a Space and the Space its replies are redirected to share an id. */
  chatIdFor(spaceId: string): string {
    return `imessage:${this.replySpaces.get(spaceId) ?? spaceId}`;
  }

  /** The memory row for a Photon message, or undefined for failed sends and content with no text. */
  private toIncoming(m: PhotonMessage): IncomingMessage | undefined {
    if (m.status === "failed") return undefined;
    const body = messageText(m.content);
    if (!body) return undefined;
    const isAgent = m.sentBy.kind === "agent" || this.agentIds.has(m.sentBy.id);
    return {
      id: m.id,
      chatId: this.chatIdFor(m.space.id),
      sender: isAgent ? undefined : m.sentBy.handle,
      senderName: this.nameOf(m.sentBy),
      body,
      sentAt: new Date(m.createdAt),
      isAgent,
    };
  }

  private async handle(m: PhotonMessage): Promise<void> {
    if (m.sentBy.kind === "agent" || this.agentIds.has(m.sentBy.id)) return;
    if (m.content.type === "attachment") return;
    const text = messageText(m.content);
    if (!text) return;
    const isGroup = m.space.kind === "group";
    const { mentioned, body } = findMention(text, config.AGENT_NAME);
    if (isGroup && !mentioned) return;

    const senderId = this.replyAgent(m);
    if (!senderId) {
      log.warn("photon_no_agent_in_space", { messageId: m.id, spaceId: m.space.id });
      return;
    }
    const replySpace = this.replySpaces.get(m.space.id) ?? m.space.id;
    const redirected = replySpace !== m.space.id;
    const chatId = this.chatIdFor(m.space.id);
    log.info("photon_mention", { messageId: m.id, spaceId: m.space.id, replySpaceId: redirected ? replySpace : undefined, kind: m.space.kind });

    if (isForgetCommand(body)) {
      await this.forget(m, chatId, senderId, replySpace);
      return;
    }

    void this.api.setTyping(replySpace, senderId, true).catch(() => undefined);
    let reply: string;
    try {
      const transcript = await this.chatContext(chatId, body, this.chatSpaces(m.space.id, replySpace));
      reply = await this.brain.suggestTrip({ transcript, askedBy: this.nameOf(m.sentBy), request: body });
    } catch (err) {
      log.error("photon_suggest_failed", err, { messageId: m.id });
      reply = "Sorry, I couldn't come up with anything just now. Try asking again in a minute.";
    }
    await this.send(m, chatId, senderId, replySpace, reply);
  }

  /** `@Tripchat forget`: drop this chat from memory up to the asking message, and never store those messages again. */
  private async forget(m: PhotonMessage, chatId: string, senderId: string, replySpace: string): Promise<void> {
    const at = new Date(m.createdAt);
    let reply: string;
    try {
      await this.memory.forget(chatId, at);
      this.forgotten.set(chatId, at);
      this.recent.delete(chatId);
      log.info("photon_forgot", { chatId });
      reply = "Done. I deleted everything I had stored from this chat, and I won't use those messages again.";
    } catch (err) {
      log.error("photon_forget_failed", err, { chatId });
      reply = "Sorry, I couldn't delete my memory of this chat just now. Please try again in a minute.";
    }
    await this.send(m, chatId, senderId, replySpace, reply);
  }

  private async send(m: PhotonMessage, chatId: string, senderId: string, replySpace: string, text: string): Promise<void> {
    // No parentMessageId: Photon rejects threaded replies on our iMessage
    // Spaces (409 SPACE_NOT_SENDABLE "Replies are not supported for this Space").
    const sent = await this.api.sendText({
      spaceId: replySpace,
      senderId,
      text,
      // One reply per incoming message, even across retries and restarts.
      idempotencyKey: `reply:${m.id}`,
    });
    log.info("photon_replied", { messageId: m.id, replyId: sent.id, status: sent.status });
    // Remember what we said, so later answers can build on it.
    await this.memory
      .store([{ id: sent.id, chatId, sender: undefined, senderName: config.AGENT_NAME, body: text, sentAt: new Date(sent.createdAt), isAgent: true }])
      .catch((err) => log.error("photon_store_reply_failed", err, { replyId: sent.id }));
    this.checkDelivery(sent.id);
  }

  /**
   * What Claude sees: the passages retrieved from memory plus the latest
   * messages. If the memory database is unreachable, the whole chat is read
   * from Photon instead (respecting any "forget"), so the agent still answers.
   */
  private async chatContext(chatId: string, request: string, spaceIds: Set<string>): Promise<string> {
    try {
      const { transcript, debug } = await this.memory.context(chatId, request);
      this.recent.set(chatId, { chatId, phase: "answered", lastRetrieval: debug });
      return transcript;
    } catch (err) {
      log.error("photon_memory_failed", err, { chatId });
      return this.transcript(spaceIds, this.forgotten.get(chatId));
    }
  }

  /** Every Space that's part of the same chat: the incoming one, where replies go, and anything else redirected there. */
  private chatSpaces(spaceId: string, replySpace: string): Set<string> {
    const spaces = new Set([spaceId, replySpace]);
    for (const [from, to] of this.replySpaces) if (to === replySpace) spaces.add(from);
    return spaces;
  }

  /**
   * The whole chat as transcript lines, oldest first, read from Photon (the
   * fallback when memory is down). Photon can't filter group messages by
   * Space (they have no receivedBy), so this lists the project's iMessages
   * and keeps this chat's. Failed sends never reached the chat, so they're
   * left out, and so is anything from before a "forget".
   */
  private async transcript(spaceIds: Set<string>, forgottenAt?: Date): Promise<string> {
    const lines: string[] = [];
    for await (const m of this.api.listMessages({ platform: "imessage", order: "asc" })) {
      if (!spaceIds.has(m.space.id) || m.status === "failed") continue;
      const sentAt = new Date(m.createdAt);
      if (forgottenAt && sentAt <= forgottenAt) continue;
      const body = messageText(m.content);
      if (body) lines.push(transcriptLine({ id: m.id, senderName: this.nameOf(m.sentBy), body, sentAt }, config.TRIP_TIMEZONE));
    }
    return lines.slice(-MAX_TRANSCRIPT_MESSAGES).join("\n");
  }

  private nameOf(user: PhotonUser): string {
    if (user.kind === "agent" || this.agentIds.has(user.id)) return config.AGENT_NAME;
    return findMemberByHandle(this.roster, user.handle)?.name ?? user.metadata?.displayName ?? guestName(user.handle);
  }

  /** Reply as the agent that received the DM, or as our agent among the group's participants. */
  private replyAgent(m: PhotonMessage): string | undefined {
    if (m.receivedBy && this.agentIds.has(m.receivedBy.id)) return m.receivedBy.id;
    return m.space.participantIds.find((id) => this.agentIds.has(id));
  }

  private checkDelivery(messageId: string): void {
    setTimeout(() => {
      this.api.getMessage(messageId).then(
        (m) => {
          if (m.status === "failed") log.warn("photon_send_failed", { messageId, code: m.failure?.code, reason: m.failure?.message });
          else log.info("photon_send_status", { messageId, status: m.status });
        },
        (err) => log.error("photon_status_check_failed", err, { messageId }),
      );
    }, DELIVERY_CHECK_MS).unref();
  }
}

export async function runPhotonAgent(roster: Member[]): Promise<never> {
  const api = createPhotonClient({
    baseUrl: config.PHOTON_API_URL,
    projectId: config.PHOTON_PROJECT_ID!,
    apiKey: config.PHOTON_API_KEY!,
  });
  const agent = new PhotonAgent(api, roster);
  await agent.start();
  startDebugServer(agent);
  log.info("started", {
    platform: "imessage",
    api: "photon-beta",
    model: config.CLAUDE_MODEL,
    pollMs: config.PHOTON_POLL_MS,
    memory: config.DATABASE_URL ? "postgres" : "pglite",
  });
  return agent.run();
}
