// The Photon 2.0 beta loop against an in-memory fake of the API and a real
// in-memory memory database (PGlite + pgvector, local embeddings). Claude is stubbed.
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  PLATFORM: "terminal",
  PHOTON_AGENT_USER_ID: "",
  AGENT_NAME: "Tripchat",
  PGLITE_DIR: "memory://",
  DATABASE_URL: "",
  DEBUG_PORT: "0",
});

const { PhotonAgent, messageText, isForgetCommand } = await import("../src/photon/agent");
const { getDb, TABLES } = await import("../src/db");
type PhotonApi = import("../src/photon/api").PhotonApi;
type PhotonMemory = import("../src/photon/agent").PhotonMemory;
type PhotonMessage = import("../src/photon/api").PhotonMessage;
type SendTextArgs = import("../src/photon/api").SendTextArgs;
type ListMessagesQuery = import("../src/photon/api").ListMessagesQuery;

const AGENT = "pho_usr_agent";
const GROUP = "pho_spc_group";
const OTHER_GROUP = "pho_spc_other";
const DM = "pho_spc_dm";
const human = (id: string, handle: string) => ({ id, kind: "human", handle });
const MATIAS = human("pho_usr_matias", "+16175550101");
const HARSH = human("pho_usr_harsh", "+16175550102");
const STRANGER = human("pho_usr_stranger", "+19995550123");
const agentUser = { id: AGENT, kind: "agent", handle: "+16285550000" };

class FakePhoton implements PhotonApi {
  messages: PhotonMessage[] = [];
  sent: SendTextArgs[] = [];
  private clock = 0;
  private next = 0;

  add(spaceId: string, from: PhotonMessage["sentBy"], text: string, status: PhotonMessage["status"] = from.kind === "agent" ? "dispatched" : "received"): PhotonMessage {
    const kind = spaceId === DM ? "direct" : "group";
    // Server timestamps: never behind the real clock, one second apart.
    this.clock = Math.max(this.clock + 1000, Date.now());
    const m: PhotonMessage = {
      id: `pho_msg_${++this.next}`,
      platform: "imessage",
      status,
      createdAt: new Date(this.clock).toISOString(),
      space: { id: spaceId, kind, participantIds: [AGENT, from.id] },
      sentBy: from,
      ...(kind === "direct" && from.kind !== "agent" ? { receivedBy: agentUser } : {}),
      content: { type: "text", format: "plain", text },
    };
    this.messages.push(m);
    return m;
  }

  async *listMessages(q: ListMessagesQuery): AsyncIterable<PhotonMessage> {
    let items = this.messages.filter((m) => {
      if (q.direction === "received" && m.status !== "received") return false;
      if (q.direction === "sent" && m.status === "received") return false;
      return !q.createdSince || m.createdAt >= q.createdSince;
    });
    if (q.order === "desc") items = [...items].reverse();
    yield* items;
  }

  async getMessage(id: string) {
    return this.messages.find((m) => m.id === id)!;
  }

  async listAgentUserIds() {
    return [AGENT];
  }

  async sendText(args: SendTextArgs) {
    this.sent.push(args);
    return this.add(args.spaceId, agentUser, args.text);
  }

  async setTyping() {}
}

const roster = [
  { name: "Matias", handles: [MATIAS.handle], startBalance: 1500 },
  { name: "Harsh", handles: [HARSH.handle], startBalance: 1500 },
];

type Call = { transcript: string; askedBy: string; request: string };

/** A fresh agent over a fresh fake Photon, with the memory tables emptied. */
async function setup(
  reply: (args: Call) => Promise<string>,
  replySpaces = new Map<string, string>(),
  opts: { api?: FakePhoton; memory?: PhotonMemory; keepMemory?: boolean } = {},
) {
  if (!opts.keepMemory) {
    const db = await getDb();
    for (const table of TABLES) await db.exec(`delete from ${table}`);
  }
  const api = opts.api ?? new FakePhoton();
  const calls: Call[] = [];
  const agent = new PhotonAgent(api, roster, {
    brain: {
      suggestTrip: async (args) => {
        calls.push(args);
        return reply(args);
      },
    },
    replySpaces,
    memory: opts.memory,
  });
  return { api, agent, calls };
}

async function storedRows(chatId: string) {
  const db = await getDb();
  return db.query<{ id: string; body: string; is_agent: boolean; sender_name: string }>(
    `select id, body, is_agent, sender_name from messages where chat_id = $1 order by sent_at, id`,
    [chatId],
  );
}

test("answers a mention in a group with the whole chat as context", async () => {
  const { api, agent, calls } = await setup(async () => "How about Montreal, Dec 19-22?");
  api.add(GROUP, HARSH, "old message from before the agent started");
  await agent.start();

  api.add(GROUP, MATIAS, "I'm free after the 18th");
  api.add(GROUP, agentUser, "this send failed", "failed");
  api.add(OTHER_GROUP, MATIAS, "a different chat");
  const ask = api.add(GROUP, HARSH, "@Tripchat give us a trip idea");
  await agent.poll();
  await agent.idle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.askedBy, "Harsh");
  assert.equal(calls[0]!.request, "give us a trip idea");
  const lines = calls[0]!.transcript.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /\] Harsh: old message from before the agent started$/);
  assert.match(lines[1]!, /\] Matias: I'm free after the 18th$/);
  assert.match(lines[2]!, /\] Harsh: @Tripchat give us a trip idea$/);

  assert.deepEqual(api.sent, [
    { spaceId: GROUP, senderId: AGENT, text: "How about Montreal, Dec 19-22?", idempotencyKey: `reply:${ask.id}` },
  ]);
});

test("only answers group messages that mention it, and every DM", async () => {
  const { api, agent, calls } = await setup(async () => "ok");
  await agent.start();

  api.add(GROUP, MATIAS, "we should go somewhere");
  api.add(GROUP, STRANGER, "tripchat, where should we go?");
  api.add(DM, MATIAS, "any ideas for December?");
  await agent.poll();
  await agent.idle();

  // Different Spaces run in parallel, so compare without order.
  assert.deepEqual(calls.map((c) => `${c.askedBy}: ${c.request}`).sort(), ["Guest 0123: where should we go?", "Matias: any ideas for December?"]);
  assert.deepEqual(api.sent.map((s) => s.spaceId).sort(), [DM, GROUP].sort());
});

test("sends replies to the mapped Space and reads both as one chat", async () => {
  const { api, agent, calls } = await setup(async () => "Montreal?", new Map([[GROUP, OTHER_GROUP]]));
  api.add(OTHER_GROUP, agentUser, "Hi! Where should we go?");
  await agent.start();

  const ask = api.add(GROUP, MATIAS, "@Tripchat trip idea?");
  await agent.poll();
  await agent.idle();

  const lines = calls[0]!.transcript.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /\] Tripchat: Hi! Where should we go\?$/);
  assert.match(lines[1]!, /\] Matias: @Tripchat trip idea\?$/);
  assert.deepEqual(api.sent, [
    { spaceId: OTHER_GROUP, senderId: AGENT, text: "Montreal?", idempotencyKey: `reply:${ask.id}` },
  ]);
});

test("never answers the same message twice across polls", async () => {
  const { api, agent, calls } = await setup(async () => "ok");
  await agent.start();
  api.add(GROUP, MATIAS, "@Tripchat plan something");
  await agent.poll();
  await agent.poll();
  await agent.idle();
  assert.equal(calls.length, 1);
  assert.equal(api.sent.length, 1);
});

test("still replies when Claude fails", async () => {
  const { api, agent } = await setup(async () => {
    throw new Error("boom");
  });
  await agent.start();
  api.add(GROUP, MATIAS, "@Tripchat trip idea?");
  await agent.poll();
  await agent.idle();
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0]!.text, /couldn't come up with anything/);
});

test("backfills history and saves new messages and its own replies to memory", async () => {
  const { api, agent } = await setup(async () => "Montreal, Dec 19-22?");
  api.add(GROUP, HARSH, "from before the agent ever ran");
  api.add(GROUP, agentUser, "a send that failed", "failed");
  await agent.start();

  const ask = api.add(GROUP, MATIAS, "@Tripchat trip idea?");
  await agent.poll();
  await agent.idle();

  const rows = await storedRows(`imessage:${GROUP}`);
  assert.deepEqual(
    rows.map((r) => [r.sender_name, r.body, r.is_agent]),
    [
      ["Harsh", "from before the agent ever ran", false],
      ["Matias", "@Tripchat trip idea?", false],
      ["Tripchat", "Montreal, Dec 19-22?", true],
    ],
  );
  assert.equal(rows[1]!.id, ask.id);
  // The retrieval behind the answer is recorded for the debug page.
  const debug = agent.recent.get(`imessage:${GROUP}`)?.lastRetrieval ?? [];
  assert.deepEqual(debug.map((d) => d.slot), ["availability", "destination", "budget", "lodging", "activities", "constraints", "logistics", "commitment", "request"]);
});

test("retrieves an old message that's no longer among the latest ones", async () => {
  const { api, agent, calls } = await setup(async () => "ok");
  api.add(GROUP, HARSH, "reminder I'm vegetarian so we need real food options");
  for (let i = 0; i < 30; i++) api.add(GROUP, MATIAS, `random chatter ${i}`);
  await agent.start();

  api.add(GROUP, MATIAS, "@Tripchat where should we eat on the trip?");
  await agent.poll();
  await agent.idle();

  // 32 messages, and only the latest 20 come in as "recent", so the first one is there through retrieval.
  assert.match(calls[0]!.transcript, /Harsh: reminder I'm vegetarian/);
});

test("forget wipes this chat's memory, and a restart doesn't bring it back", async () => {
  const { api, agent, calls } = await setup(async () => "ok");
  api.add(GROUP, HARSH, "my budget is $300");
  api.add(OTHER_GROUP, HARSH, "a message in another chat");
  await agent.start();

  api.add(GROUP, MATIAS, "@Tripchat forget");
  await agent.poll();
  await agent.idle();
  assert.match(api.sent[0]!.text, /deleted everything I had stored from this chat/);
  assert.equal(calls.length, 0, "forget doesn't ask Claude anything");

  const humanRows = async (space: string) => (await storedRows(`imessage:${space}`)).filter((r) => !r.is_agent);
  assert.deepEqual(await humanRows(GROUP), []);
  assert.equal((await humanRows(OTHER_GROUP)).length, 1, "other chats are untouched");

  // A restart backfills from Photon, which still has the old messages.
  const restarted = await setup(async () => "ok", new Map(), { api, keepMemory: true });
  await restarted.agent.start();
  assert.deepEqual(await humanRows(GROUP), []);

  api.add(GROUP, HARSH, "@Tripchat what's my budget?");
  await restarted.agent.poll();
  await restarted.agent.idle();
  assert.doesNotMatch(restarted.calls[0]!.transcript, /\$300/);
});

test("only an explicit forget wipes memory", () => {
  for (const yes of ["forget", "Forget!", "forget everything", "please forget this chat", "wipe it all"]) assert.ok(isForgetCommand(yes), yes);
  for (const no of ["delete the hotel idea", "forget about Miami, let's do Montreal", "don't forget Harsh is vegetarian", "what did we forget?"]) {
    assert.ok(!isForgetCommand(no), no);
  }
});

test("reads the chat from Photon when the memory database is down", async () => {
  const down: PhotonMemory = {
    store: async () => {
      throw new Error("db down");
    },
    context: async () => {
      throw new Error("db down");
    },
    forget: async () => {
      throw new Error("db down");
    },
    cutoffs: async () => {
      throw new Error("db down");
    },
  };
  const { api, agent, calls } = await setup(async () => "still here", new Map(), { memory: down });
  api.add(GROUP, HARSH, "I'm free after the 18th");
  await agent.start();

  api.add(GROUP, MATIAS, "@Tripchat trip idea?");
  await agent.poll();
  await agent.idle();

  const lines = calls[0]!.transcript.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /\] Harsh: I'm free after the 18th$/);
  assert.equal(api.sent[0]!.text, "still here");
});

test("messageText reads text, groups and attachments", () => {
  assert.equal(messageText({ type: "text", text: " hi￼ " }), "hi");
  assert.equal(messageText({ type: "attachment" }), "[shared a file]");
  assert.equal(
    messageText({ type: "group", parts: [{ type: "attachment" }, { type: "text", text: "look at this place" }] }),
    "[shared a file] look at this place",
  );
  assert.equal(messageText({ type: "space.typing.update" }), undefined);
});
