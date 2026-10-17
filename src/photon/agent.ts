import { findMention } from "../agent/commands";
import type { Bank } from "../bank";
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
import { GroupRegistry, type Group } from "./groups";
import { startSignupServer } from "./signup";
import { isApproveText, parseSplitCommand, SplitService } from "./split";
import { createHost } from "../orbit/hosts";
import { recentImages } from "../orbit/images";
import { isShipIt, OrbitService } from "../orbit/service";
import { OrbitStore } from "../orbit/store";

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
  private readonly groups: GroupRegistry;
  /** Budgets, the payer and approvals. Off unless a bank is given. */
  private readonly split?: SplitService;
  /** Build apps from the chat. When set, it answers every mention. */
  private readonly orbit?: OrbitService;

  constructor(
    private readonly api: PhotonApi,
    private readonly roster: Member[],
    opts: {
      brain?: PhotonBrain;
      memory?: PhotonMemory;
      replySpaces?: ReadonlyMap<string, string>;
      groups?: GroupRegistry;
      bank?: Bank;
      orbit?: OrbitService;
    } = {},
  ) {
    this.brain = opts.brain ?? { suggestTrip };
    this.memory = opts.memory ?? databaseMemory;
    this.replySpaces = opts.replySpaces ?? config.photonReplySpaces;
    this.groups = opts.groups ?? new GroupRegistry();
    if (opts.bank) this.split = new SplitService(roster, opts.bank, this.groups);
    this.orbit = opts.orbit;
  }

  /**
   * Learn which Users are ours, copy the chat history into memory, then mark
   * everything already in Photon as seen so old messages never get answers.
   */
  async start(): Promise<void> {
    const ids = config.PHOTON_AGENT_USER_ID ? [config.PHOTON_AGENT_USER_ID] : (await this.api.listAgents()).map((u) => u.id);
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
    const chatId = this.chatIdFor(m.space.id);
    // A bare "approve" counts without a mention, but only while a split is waiting on the group.
    // Without a mention, only a bare "ship it" (while a plan waits) or "approve" (while a split waits) counts.
    const bareShip = !!this.orbit && isShipIt(text) && this.orbit.hasPending(chatId);
    const bareApprove = !this.orbit && !!this.split && isApproveText(text) && (await this.split.isCollecting(chatId));
    if (isGroup && !mentioned && !bareShip && !bareApprove) return;

    const senderId = this.replyAgent(m);
    if (!senderId) {
      log.warn("photon_no_agent_in_space", { messageId: m.id, spaceId: m.space.id });
      return;
    }
    log.info("photon_mention", { messageId: m.id, spaceId: m.space.id, kind: m.space.kind });
    // Memory keys a chat by the Space its messages arrive in (or its
    // PHOTON_REPLY_SPACES target), so this chat's questions and our answers
    // stay together even when replies go to a signup group's Space.

    // Working out where to reply needs the project's messages from Photon.
    // If Photon can't list them, still answer, in the Space the message came from.
    let replySpace = this.replySpaces.get(m.space.id) ?? m.space.id;
    let all: PhotonMessage[] | undefined;
    try {
      all = await this.allMessages();
      replySpace = this.replySpaceFor(m, all);
    } catch (err) {
      log.error("photon_list_failed", err, { messageId: m.id });
    }

    if (isForgetCommand(body)) {
      await this.forget(m, chatId, senderId, replySpace);
      return;
    }

    void this.api.setTyping(replySpace, senderId, true).catch(() => undefined);

    if (this.orbit) {
      try {
        await this.orbit.handle({
          chatId,
          body,
          askedBy: this.nameOf(m.sentBy),
          senderHandle: m.sentBy.handle,
          transcript: () => this.chatContext(chatId, body, all, this.chatSpaces(m.space.id, replySpace)).catch(() => ""),
          // The whole chat straight from Photon (minus anything forgotten); memory's retrieval if Photon couldn't list it.
          fullTranscript: async () =>
            all
              ? this.transcript(all, this.chatSpaces(m.space.id, replySpace), this.forgotten.get(chatId))
              : this.chatContext(chatId, body, all, this.chatSpaces(m.space.id, replySpace)).catch(() => ""),
          images: async () =>
            all ? recentImages({ api: this.api, all, spaceIds: this.chatSpaces(m.space.id, replySpace), upTo: m, nameOf: (x) => this.nameOf(x.sentBy) }) : [],
          say: (text, key) => this.send(m, chatId, senderId, replySpace, text, `orbit:${m.id}:${key}`),
        });
      } catch (err) {
        log.error("orbit_failed", err, { messageId: m.id });
        await this.send(m, chatId, senderId, replySpace, "Sorry, something went wrong on my side. Try again in a minute.", `orbit:${m.id}:error`);
      }
      return;
    }

    let reply: string;
    const money = this.split ? parseSplitCommand(body) : undefined;
    if (this.split && money) {
      try {
        reply = await this.split.handle(money, {
          chatId,
          replySpaceId: replySpace,
          senderHandle: m.sentBy.handle,
          senderName: this.nameOf(m.sentBy),
          messageId: m.id,
        });
      } catch (err) {
        log.error("photon_split_failed", err, { messageId: m.id });
        reply = "Sorry, something went wrong on my side, so I didn't move any money. Try again in a minute.";
      }
      await this.send(m, chatId, senderId, replySpace, reply);
      return;
    }

    try {
      const transcript = await this.chatContext(chatId, body, all, this.chatSpaces(m.space.id, replySpace));
      const budgets = await this.split?.budgetLine(this.split.travelers(replySpace)).catch(() => undefined);
      reply = await this.brain.suggestTrip({ transcript, askedBy: this.nameOf(m.sentBy), request: body, budgets });
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

  private async send(m: PhotonMessage, chatId: string, senderId: string, replySpace: string, text: string, key = `reply:${m.id}`): Promise<void> {
    // No parentMessageId: Photon rejects threaded replies on our iMessage
    // Spaces (409 SPACE_NOT_SENDABLE "Replies are not supported for this Space").
    const sent = await this.api.sendText({
      spaceId: replySpace,
      senderId,
      text,
      // One reply per incoming message, even across retries and restarts.
      idempotencyKey: key,
    });
    log.info("photon_replied", {
      messageId: m.id,
      replyId: sent.id,
      replySpaceId: replySpace !== m.space.id ? replySpace : undefined,
      status: sent.status,
    });
    // Remember what we said, so later answers can build on it.
    await this.memory
      .store([{ id: sent.id, chatId, sender: undefined, senderName: config.AGENT_NAME, body: text, sentAt: new Date(sent.createdAt), isAgent: true }])
      .catch((err) => log.error("photon_store_reply_failed", err, { replyId: sent.id }));
    this.checkDelivery(sent.id);
  }

  /**
   * What Claude sees: the passages retrieved from memory plus the latest
   * messages. If the memory database is unreachable, the whole chat comes
   * from Photon's listing instead (respecting any "forget"), so the agent
   * still answers.
   */
  private async chatContext(chatId: string, request: string, all: PhotonMessage[] | undefined, spaceIds: Set<string>): Promise<string> {
    try {
      const { transcript, debug } = await this.memory.context(chatId, request);
      this.recent.set(chatId, { chatId, phase: "answered", lastRetrieval: debug });
      return transcript;
    } catch (err) {
      log.error("photon_memory_failed", err, { chatId });
      if (!all) throw err;
      return this.transcript(all, spaceIds, this.forgotten.get(chatId));
    }
  }

  /**
   * Every iMessage in the project, oldest first. Photon can't filter group
   * messages by Space (they have no receivedBy), so chats are picked out of this.
   */
  private async allMessages(): Promise<PhotonMessage[]> {
    const all: PhotonMessage[] = [];
    for await (const m of this.api.listMessages({ platform: "imessage", order: "asc" })) all.push(m);
    return all;
  }

  /**
   * Where a reply to m goes. Photon files the messages people send in a group
   * we started under a new Space that can't be sent to. So for a group Space
   * we didn't start, reply in the signup group the sender is in whose members
   * overlap most with who's talking there; the newest group wins ties.
   */
  private replySpaceFor(m: PhotonMessage, all: PhotonMessage[]): string {
    const configured = this.replySpaces.get(m.space.id);
    if (configured) return configured;
    if (m.space.kind !== "group" || this.groups.get(m.space.id)) return m.space.id;

    const talking = new Set([m.sentBy.id]);
    for (const x of all) if (x.space.id === m.space.id && x.status === "received") talking.add(x.sentBy.id);
    let best: Group | undefined;
    let bestOverlap = 0;
    for (const g of this.groups.list()) {
      if (!g.members.some((p) => p.userId === m.sentBy.id)) continue;
      const overlap = g.members.filter((p) => talking.has(p.userId)).length;
      if (overlap > bestOverlap) {
        best = g;
        bestOverlap = overlap;
      }
    }
    return best?.spaceId ?? m.space.id;
  }

  /** Every Space that's part of the same chat: the incoming one, where replies go, and anything else redirected there. */
  private chatSpaces(spaceId: string, replySpace: string): Set<string> {
    const spaces = new Set([spaceId, replySpace]);
    for (const [from, to] of this.replySpaces) if (to === replySpace) spaces.add(from);
    return spaces;
  }

  /**
   * The chat as transcript lines from Photon's listing, oldest first (the
   * fallback when memory is down). Failed sends never reached the chat, so
   * they're left out, and so is anything from before a "forget".
   */
  private transcript(all: PhotonMessage[], spaceIds: Set<string>, forgottenAt?: Date): string {
    const lines: string[] = [];
    for (const m of all) {
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
    return (
      findMemberByHandle(this.roster, user.handle)?.name ??
      this.groups.nameOf(user.id) ??
      user.metadata?.displayName ??
      guestName(user.handle)
    );
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
  const groups = new GroupRegistry(config.GROUPS_FILE);
  const host = createHost();
  const orbit = new OrbitService(new OrbitStore(), host, roster, groups);
  const agent = new PhotonAgent(api, roster, { groups, orbit });
  await agent.start();
  startSignupServer(api, groups, { serveApps: host.name === "local" });
  startDebugServer(agent);
  log.info("started", {
    platform: "imessage",
    api: "photon-beta",
    model: config.CLAUDE_MODEL,
    pollMs: config.PHOTON_POLL_MS,
    memory: config.DATABASE_URL ? "postgres" : "pglite",
    host: host.name,
    builder: config.orbitBuilder,
  });
  return agent.run();
}
