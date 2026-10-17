// The Photon 2.0 beta loop against an in-memory fake of the API. Claude is stubbed.
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, { PLATFORM: "terminal", PHOTON_AGENT_USER_ID: "", AGENT_NAME: "Tripchat" });

const { PhotonAgent, messageText } = await import("../src/photon/agent");
const { GroupRegistry } = await import("../src/photon/groups");
const { createGroupChat, normalizePhone, parseSignup } = await import("../src/photon/signup");
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
const agentUser = { id: AGENT, kind: "agent", handle: "+16285550000", details: { type: "dedicated" } };

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

  users = new Map<string, string>([[MATIAS.handle, MATIAS.id], [HARSH.handle, HARSH.id]]);
  spaces: { id: string; participantIds: string[] }[] = [];

  async listAgents() {
    return [agentUser, { id: "pho_usr_shared", kind: "agent", handle: "+16285550001", details: { type: "shared" } }];
  }

  async createUser(handle: string) {
    if (!this.users.has(handle)) this.users.set(handle, `pho_usr_${this.users.size + 1}`);
    return { id: this.users.get(handle)!, kind: "human", handle };
  }

  async createSpace(participantIds: string[]) {
    const key = [...participantIds].sort().join(",");
    let space = this.spaces.find((s) => [...s.participantIds].sort().join(",") === key);
    if (!space) this.spaces.push((space = { id: `pho_spc_new${this.spaces.length + 1}`, participantIds }));
    return { ...space, kind: "group" };
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

function setup(
  reply: (args: { transcript: string; askedBy: string; request: string }) => Promise<string>,
  opts: { replySpaces?: Map<string, string>; groups?: InstanceType<typeof GroupRegistry> } = {},
) {
  const api = new FakePhoton();
  const calls: { transcript: string; askedBy: string; request: string }[] = [];
  const agent = new PhotonAgent(api, roster, {
    brain: {
      suggestTrip: async (args) => {
        calls.push(args);
        return reply(args);
      },
    },
    replySpaces: opts.replySpaces ?? new Map(),
    groups: opts.groups ?? new GroupRegistry(),
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
  const { api, agent, calls } = setup(async () => "Montreal?", { replySpaces: new Map([[GROUP, OTHER_GROUP]]) });
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

test("replies in the signup group that matches who's talking in an unknown Space", async () => {
  const NEWER = "pho_spc_newer";
  const UNKNOWN = "pho_spc_unknown";
  const groups = new GroupRegistry();
  const member = (name: string, u: { id: string; handle: string }) => ({ name, handle: u.handle, userId: u.id });
  groups.upsert({ spaceId: OTHER_GROUP, createdAt: "2026-10-17T00:00:00Z", members: [member("Matias", MATIAS), member("Harsh", HARSH)] });
  groups.upsert({ spaceId: NEWER, createdAt: "2026-10-17T01:00:00Z", members: [member("Matias", MATIAS), member("Priya", STRANGER)] });
  const { api, agent, calls } = setup(async () => "ok", { groups });
  await agent.start();

  // Harsh and Matias are talking, so it's their group even though Matias is in a newer one too.
  api.add(GROUP, HARSH, "hey");
  api.add(GROUP, MATIAS, "@Tripchat trip idea?");
  await agent.poll();
  await agent.idle();
  // Only Priya's group has Priya; her signup name shows up in the transcript.
  api.add(UNKNOWN, STRANGER, "@Tripchat where should we go?");
  await agent.poll();
  await agent.idle();

  assert.deepEqual(
    api.sent.map((s) => s.spaceId),
    [OTHER_GROUP, NEWER],
  );
  assert.equal(calls[1]!.askedBy, "Priya");
  assert.match(calls[1]!.transcript, /\] Priya: @Tripchat where should we go\?$/);
});

test("signup starts a group with the line first and greets everyone by name, once", async () => {
  const api = new FakePhoton();
  const groups = new GroupRegistry();
  const line = (await api.listAgents())[0]!;
  const first = await createGroupChat(api, groups, line, {
    title: "spring break",
    members: [
      { name: "Wilson", phone: "+61452598886" },
      { name: "Harsh", phone: HARSH.handle },
    ],
  });
  assert.equal(first.existing, false);
  assert.equal(api.spaces[0]!.participantIds[0], AGENT);
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0]!.spaceId, first.group.spaceId);
  assert.match(api.sent[0]!.text, /^Hi Wilson and Harsh! .*plan spring break\./);
  assert.equal(groups.nameOf(HARSH.id), "Harsh");

  // The same people again: same chat, new names, no second welcome, title kept.
  const again = await createGroupChat(api, groups, line, {
    members: [
      { name: "Wilson", phone: "+61452598886" },
      { name: "Harsh P", phone: HARSH.handle },
    ],
  });
  assert.equal(again.existing, true);
  assert.equal(again.group.spaceId, first.group.spaceId);
  assert.equal(again.group.title, "spring break");
  assert.equal(api.sent.length, 1);
  assert.equal(groups.nameOf(HARSH.id), "Harsh P");
});

test("signup form cleans up numbers and explains problems", () => {
  assert.equal(normalizePhone("(617) 555-0101"), "+16175550101");
  assert.equal(normalizePhone("1 617 555 0101"), "+16175550101");
  assert.equal(normalizePhone("+61 452 598 886"), "+61452598886");
  assert.equal(normalizePhone("0452 598 886"), undefined);
  assert.equal(normalizePhone("555-0101"), undefined);

  const people = [
    { name: " Wilson ", phone: "+61 452 598 886" },
    { name: "Harsh", phone: "617-555-0102" },
    { name: "", phone: "" },
  ];
  assert.deepEqual(parseSignup({ title: "  Spring break ", consent: true, members: people }), {
    ok: true,
    input: {
      title: "Spring break",
      members: [
        { name: "Wilson", phone: "+61452598886" },
        { name: "Harsh", phone: "+16175550102" },
      ],
    },
  });
  const error = (body: unknown) => {
    const r = parseSignup(body);
    return r.ok ? undefined : r.error;
  };
  assert.match(error({ consent: true, members: people.slice(0, 1) })!, /at least 2 people/);
  assert.match(error({ consent: false, members: people })!, /Check the box/);
  assert.match(error({ consent: true, members: [people[0], { name: "Again", phone: "+61452598886" }] })!, /twice/);
  assert.match(error({ consent: true, members: [people[0], { name: "Harsh", phone: "0452 598 886" }] })!, /country code/);
  assert.match(error({ consent: true, members: [people[0], { name: "", phone: "617-555-0102" }] })!, /Add a name/);
  assert.match(error("nope")!, /Reload the page/);
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
