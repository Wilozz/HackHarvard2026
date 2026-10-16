import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { TripAgent, type ChatContext, type Sender } from "./agent/handler";
import { getBank } from "./bank";
import { config } from "./config";
import { startDebugServer } from "./debug";
import { getDb } from "./db";
import { log } from "./log";
import { findMemberByHandle, findMemberByName, guestName, loadRoster } from "./members";
import { storeMessage } from "./memory/ingest";

const roster = loadRoster();
const bank = roster.length > 0 ? getBank() : undefined;

// Work for one chat runs in order; different chats run in parallel.
const queues = new Map<string, Promise<void>>();
function enqueue(chatId: string, task: () => Promise<void>): void {
  const next = (queues.get(chatId) ?? Promise.resolve())
    .then(task)
    .catch((err) => log.error("task_failed", err, { chatId }));
  queues.set(chatId, next);
}

const agent = new TripAgent(roster, bank, enqueue);

async function createApp() {
  if (config.platform === "imessage") {
    return Spectrum({
      projectId: config.PHOTON_PROJECT_ID!,
      projectSecret: config.PHOTON_PROJECT_SECRET!,
      providers: [imessage.config()],
    });
  }
  return Spectrum({
    providers: [
      terminal.config({
        commands: [{ name: "/help", description: `What ${config.AGENT_NAME} can do` }],
      }),
    ],
  });
}

function isGroupSpace(message: Message, space: Space): boolean {
  if (message.platform === "imessage") return imessage(space).type === "group";
  // The terminal stands in for a group chat, so mentions are required there too.
  return true;
}

/**
 * Who sent this? Roster members are matched by phone/email. In the terminal,
 * "[Harsh] text" speaks as a roster member so one person can play the whole
 * group; that shortcut is never honored on iMessage.
 */
function resolveSender(message: Message, text: string): { sender: Sender; text: string } {
  const handle = message.sender?.id;
  if (message.platform === "terminal") {
    const as = text.match(/^\[([^\]]{1,40})\]\s*([\s\S]*)$/);
    if (as) {
      const name = as[1]!.trim();
      const member = findMemberByName(roster, name);
      return { sender: { key: member?.name ?? name, name: member?.name ?? name, member }, text: as[2] ?? "" };
    }
    return { sender: { key: "You", name: "You" }, text };
  }
  const member = findMemberByHandle(roster, handle);
  const name = member?.name ?? guestName(handle);
  return { sender: { key: name, name, member }, text };
}

function messageText(message: Message): string | undefined {
  const c = message.content;
  if (c.type === "text") return c.text.replace(/￼/g, "").trim();
  if (c.type === "markdown") return c.markdown.trim();
  if (c.type === "attachment") return `[shared a file: ${c.name}]`;
  return undefined;
}

async function handle(space: Space, message: Message): Promise<void> {
  const chatId = `${message.platform}:${space.id}`;
  const ctx: ChatContext = { chatId, platform: message.platform, isGroup: isGroupSpace(message, space), space };
  const raw = messageText(message);

  if (message.direction === "outbound") {
    if (raw) {
      await storeMessage({ id: message.id, chatId, sender: undefined, senderName: config.AGENT_NAME, body: raw, sentAt: message.timestamp, isAgent: true });
    }
    return;
  }

  const c = message.content;
  if (raw !== undefined) {
    const { sender, text } = resolveSender(message, raw);
    await storeMessage({ id: message.id, chatId, sender: message.sender?.id, senderName: sender.name, body: text, sentAt: message.timestamp, isAgent: false });
    if (c.type === "text" || c.type === "markdown") {
      const command = text.trim() === "/help" ? `@${config.AGENT_NAME} help` : text;
      enqueue(chatId, () => agent.onText(ctx, sender, command, message));
    }
    return;
  }
  if (c.type === "reaction") {
    const { sender } = resolveSender(message, "");
    enqueue(chatId, () => agent.onReaction(ctx, sender, c.emoji, c.target.id));
    return;
  }
  if (c.type === "poll_option") {
    const { sender } = resolveSender(message, "");
    enqueue(chatId, () => agent.onPollVote(ctx, sender, c.option.title, c.selected));
  }
}

async function main(): Promise<void> {
  await getDb();
  const app = await createApp();
  startDebugServer(agent);
  log.info("started", {
    platform: config.platform,
    model: config.CLAUDE_MODEL,
    bank: bank?.name ?? "off",
    voice: config.VOICE_PROVIDER,
    members: roster.length,
  });

  for await (const [space, message] of app.messages) {
    try {
      await handle(space, message);
    } catch (err) {
      log.error("message_failed", err, { messageId: message.id });
    }
  }
  log.warn("message_stream_ended");
  process.exit(1);
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
