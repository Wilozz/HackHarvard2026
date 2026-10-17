// The Photon 2.0 beta loop against an in-memory fake of the API. Claude is stubbed.
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, { PLATFORM: "terminal", PHOTON_AGENT_USER_ID: "", AGENT_NAME: "Tripchat" });

const { PhotonAgent, messageText } = await import("../src/photon/agent");
type PhotonApi = import("../src/photon/api").PhotonApi;
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

function setup(reply: (args: { transcript: string; askedBy: string; request: string }) => Promise<string>, replySpaces = new Map<string, string>()) {
  const api = new FakePhoton();
  const calls: { transcript: string; askedBy: string; request: string }[] = [];
  const agent = new PhotonAgent(api, roster, {
    brain: {
      suggestTrip: async (args) => {
        calls.push(args);
        return reply(args);
      },
    },
    replySpaces,
  });
  return { api, agent, calls };
}

test("answers a mention in a group with the whole chat as context", async () => {
  const { api, agent, calls } = setup(async () => "How about Montreal, Dec 19-22?");
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
  const { api, agent, calls } = setup(async () => "ok");
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
  const { api, agent, calls } = setup(async () => "Montreal?", new Map([[GROUP, OTHER_GROUP]]));
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
  const { api, agent, calls } = setup(async () => "ok");
  await agent.start();
  api.add(GROUP, MATIAS, "@Tripchat plan something");
  await agent.poll();
  await agent.poll();
  await agent.idle();
  assert.equal(calls.length, 1);
  assert.equal(api.sent.length, 1);
});

test("still replies when Claude fails", async () => {
  const { api, agent } = setup(async () => {
    throw new Error("boom");
  });
  await agent.start();
  api.add(GROUP, MATIAS, "@Tripchat trip idea?");
  await agent.poll();
  await agent.idle();
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0]!.text, /couldn't come up with anything/);
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
