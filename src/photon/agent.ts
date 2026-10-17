import { findMention } from "../agent/commands";
import { suggestTrip } from "../agent/suggest";
import { config } from "../config";
import { log } from "../log";
import { findMemberByHandle, guestName, type Member } from "../members";
import { transcriptLine } from "../memory/chunker";
import { createPhotonClient, type PhotonApi, type PhotonContent, type PhotonMessage, type PhotonUser } from "./api";
import { GroupRegistry, type Group } from "./groups";
import { startSignupServer } from "./signup";

/** Each poll re-lists this far back, since createdAt order can lag arrival order. Seen ids dedupe the overlap. */
const LOOKBACK_MS = 10_000;
/** Upper bound on the transcript sent to Claude, newest messages kept. */
const MAX_TRANSCRIPT_MESSAGES = 2000;
/** A 202 from Photon only means accepted; check the real status this long after sending. */
const DELIVERY_CHECK_MS = 20_000;

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

/** The LLM step, injectable so the loop can be tested without API calls. */
export interface PhotonBrain {
  suggestTrip: typeof suggestTrip;
}

/**
 * Tripchat on Photon 2.0 beta: polls for received iMessages and answers
 * mentions (every message in a DM) with a trip suggestion built from the
 * whole chat. No retrieval and no local storage: the chat is re-read from
 * Photon on every mention.
 */
export class PhotonAgent {
  private agentIds = new Set<string>();
  /** Newest createdAt seen, in ms. Polls list from here minus LOOKBACK_MS. */
  private cursorMs = 0;
  /** Message id → createdAt ms, for ids still inside the lookback window. */
  private readonly seen = new Map<string, number>();
  /** Replies for one Space run in order; different Spaces run in parallel. */
  private readonly queues = new Map<string, Promise<void>>();

  private readonly brain: PhotonBrain;
  private readonly replySpaces: ReadonlyMap<string, string>;
  private readonly groups: GroupRegistry;

  constructor(
    private readonly api: PhotonApi,
    private readonly roster: Member[],
    opts: { brain?: PhotonBrain; replySpaces?: ReadonlyMap<string, string>; groups?: GroupRegistry } = {},
  ) {
    this.brain = opts.brain ?? { suggestTrip };
    this.replySpaces = opts.replySpaces ?? config.photonReplySpaces;
    this.groups = opts.groups ?? new GroupRegistry();
  }

  /** Learn which Users are ours, then mark everything already in Photon as seen so old messages never get answers. */
  async start(): Promise<void> {
    const ids = config.PHOTON_AGENT_USER_ID ? [config.PHOTON_AGENT_USER_ID] : (await this.api.listAgents()).map((u) => u.id);
    if (ids.length === 0) throw new Error("This Photon project has no agent User. Set PHOTON_AGENT_USER_ID.");
    this.agentIds = new Set(ids);

    // Start from the newest message's server timestamp, not this machine's clock.
    this.cursorMs = Date.now();
    for await (const m of this.api.listMessages({ platform: "imessage", direction: "received", order: "desc", pageSize: 1 })) {
      this.cursorMs = Date.parse(m.createdAt);
      break;
    }
    await this.poll({ prime: true });
    log.info("photon_ready", { agents: ids.length, members: this.roster.length });
  }

  /** One pass over recently received messages. Each new one is queued on its Space. */
  async poll(opts: { prime?: boolean } = {}): Promise<void> {
    const since = new Date(this.cursorMs - LOOKBACK_MS).toISOString();
    for await (const m of this.api.listMessages({ platform: "imessage", direction: "received", order: "asc", createdSince: since })) {
      if (this.seen.has(m.id)) continue;
      const at = Date.parse(m.createdAt);
      this.seen.set(m.id, at);
      this.cursorMs = Math.max(this.cursorMs, at);
      if (!opts.prime) this.enqueue(m.space.id, () => this.handle(m));
    }
    for (const [id, at] of this.seen) if (at < this.cursorMs - LOOKBACK_MS) this.seen.delete(id);
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

  private async handle(m: PhotonMessage): Promise<void> {
    if (m.sentBy.kind === "agent" || this.agentIds.has(m.sentBy.id)) return;
    if (m.content.type === "attachment") return;
    const text = messageText(m.content);
    if (!text) return;
    const { mentioned, body } = findMention(text, config.AGENT_NAME);
    if (m.space.kind === "group" && !mentioned) return;

    const senderId = this.replyAgent(m);
    if (!senderId) {
      log.warn("photon_no_agent_in_space", { messageId: m.id, spaceId: m.space.id });
      return;
    }
    log.info("photon_mention", { messageId: m.id, spaceId: m.space.id, kind: m.space.kind });

    let replySpace = this.replySpaces.get(m.space.id) ?? m.space.id;
    let reply: string;
    try {
      const all = await this.allMessages();
      replySpace = this.replySpaceFor(m, all);
      void this.api.setTyping(replySpace, senderId, true).catch(() => undefined);
      const transcript = this.transcript(all, this.chatSpaces(m.space.id, replySpace));
      reply = await this.brain.suggestTrip({ transcript, askedBy: this.nameOf(m.sentBy), request: body });
    } catch (err) {
      log.error("photon_suggest_failed", err, { messageId: m.id });
      reply = "Sorry, I couldn't come up with anything just now. Try asking again in a minute.";
    }

    // No parentMessageId: Photon rejects threaded replies on our iMessage
    // Spaces (409 SPACE_NOT_SENDABLE "Replies are not supported for this Space").
    const sent = await this.api.sendText({
      spaceId: replySpace,
      senderId,
      text: reply,
      // One reply per incoming message, even across retries and restarts.
      idempotencyKey: `reply:${m.id}`,
    });
    log.info("photon_replied", {
      messageId: m.id,
      replyId: sent.id,
      replySpaceId: replySpace !== m.space.id ? replySpace : undefined,
      status: sent.status,
    });
    this.checkDelivery(sent.id);
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

  /** The chat as transcript lines, oldest first. Failed sends never reached the chat, so they're left out. */
  private transcript(all: PhotonMessage[], spaceIds: Set<string>): string {
    const lines: string[] = [];
    for (const m of all) {
      if (!spaceIds.has(m.space.id) || m.status === "failed") continue;
      const body = messageText(m.content);
      if (body) {
        lines.push(transcriptLine({ id: m.id, senderName: this.nameOf(m.sentBy), body, sentAt: new Date(m.createdAt) }, config.TRIP_TIMEZONE));
      }
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
  const agent = new PhotonAgent(api, roster, { groups });
  await agent.start();
  startSignupServer(api, groups);
  log.info("started", { platform: "imessage", api: "photon-beta", model: config.CLAUDE_MODEL, pollMs: config.PHOTON_POLL_MS });
  return agent.run();
}
