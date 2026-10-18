// The money flow over iMessage: budgets, payer, per-person approval, transfers
// and the dashboard that reads them. Mock bank on an in-memory database;
// Claude and Photon are stubbed.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

Object.assign(process.env, {
  PLATFORM: "terminal",
  PHOTON_AGENT_USER_ID: "",
  AGENT_NAME: "Tripchat",
  PGLITE_DIR: "memory://",
  DATABASE_URL: "",
  NESSIE_API_KEY: "",
  DEBUG_PORT: "0",
});

const { PhotonAgent } = await import("../src/photon/agent");
const { SplitService, parseSplitCommand, parseAmount, isApproveText } = await import("../src/photon/split");
const { GroupRegistry } = await import("../src/photon/groups");
const { getBank } = await import("../src/bank");
const { createDashboard } = await import("../src/bank/dashboard");
const { listActivity } = await import("../src/bank/activity");
const { mergeGroupMembers } = await import("../src/bank/roster");
const { loadTrip } = await import("../src/trip/state");
const { getDb } = await import("../src/db");
type Member = import("../src/members").Member;
type PhotonApi = import("../src/photon/api").PhotonApi;
type PhotonMessage = import("../src/photon/api").PhotonMessage;
type SendTextArgs = import("../src/photon/api").SendTextArgs;

const WILSON: Member = { name: "Wilson", handles: ["+61452598886"], startBalance: 1500 };
const HETARTH: Member = { name: "Hetarth", handles: ["+14169491126"], startBalance: 500 };
const HARSH: Member = { name: "Harsh", handles: ["+15513318011"], startBalance: 1500 };
const CHAT = "imessage:pho_spc_group";

beforeEach(async () => {
  const db = await getDb();
  await db.exec("delete from trips; delete from ledger; delete from bank_activity;");
});

function service(roster: Member[] = [WILSON, HETARTH, HARSH]) {
  const bank = getBank();
  return { bank, split: new SplitService(roster, bank, new GroupRegistry()), roster };
}
const ctx = (m: Member | { name: string; handles: string[] }, messageId = `pho_msg_${Math.random().toString(36).slice(2)}`) => ({
  chatId: CHAT,
  replySpaceId: "pho_spc_group",
  senderHandle: m.handles[0]!,
  senderName: m.name,
  messageId,
});

test("parses money commands and ignores everything else", () => {
  assert.deepEqual(parseSplitCommand("I'll pay $480"), { kind: "payer", total: 480 });
  assert.deepEqual(parseSplitCommand("i’ll pay"), { kind: "payer" });
  assert.deepEqual(parseSplitCommand("I'll pay 1,200.50 for it"), { kind: "payer", total: 1201 });
  assert.deepEqual(parseSplitCommand("total is $600"), { kind: "total", total: 600 });
  assert.deepEqual(parseSplitCommand("split 300"), { kind: "total", total: 300 });
  assert.deepEqual(parseSplitCommand("approve"), { kind: "approve" });
  assert.deepEqual(parseSplitCommand("I approve!"), { kind: "approve" });
  assert.deepEqual(parseSplitCommand("budgets"), { kind: "budgets" });
  assert.deepEqual(parseSplitCommand("cancel the split"), { kind: "cancel" });
  assert.equal(parseSplitCommand("I approve of Lisbon"), undefined);
  assert.equal(parseSplitCommand("give us a trip idea"), undefined);
  assert.equal(parseAmount("no number"), undefined);
  assert.ok(isApproveText("Approve."));
  assert.ok(!isApproveText("approve of this plan"));
});

test("shows budgets from balances", async () => {
  const { split } = service();
  const text = await split.handle({ kind: "budgets" }, ctx(WILSON));
  assert.match(text, /Wilson: up to \$750 \(balance \$1,500\)/);
  assert.match(text, /Hetarth: up to \$250 \(balance \$500\)/);
  assert.match(text, /Everyone can afford \$250 each, or \$750 for the group/);
  assert.equal(await split.budgetLine(service().roster), "Wilson can spend up to $750; Hetarth can spend up to $250; Harsh can spend up to $750");
});

test("payer, total, then each person's own approval moves their share", async () => {
  const { split, bank } = service();
  assert.match(await split.handle({ kind: "payer" }, ctx(WILSON)), /Wilson is paying\. Text "@Tripchat total 480"/);
  const proposal = await split.handle({ kind: "total", total: 480 }, ctx(WILSON));
  assert.match(proposal, /Wilson is paying \$480, so Hetarth and Harsh owe \$160 each/);
  // Nothing has moved yet.
  assert.equal(await bank.balance(HETARTH), 500);

  const first = await split.handle({ kind: "approve" }, ctx(HETARTH));
  assert.match(first, /Sent \$160 from Hetarth to Wilson \(\$500 → \$340\)\. Still waiting on Harsh/);
  assert.equal(await bank.balance(HETARTH), 340);
  assert.equal(await bank.balance(WILSON), 1660);
  assert.equal(await bank.balance(HARSH), 1500);

  const last = await split.handle({ kind: "approve" }, ctx(HARSH));
  assert.match(last, /That's everyone\. Wilson now has \$1,820/);
  assert.equal((await loadTrip(CHAT))?.phase, "paid");

  const kinds = (await listActivity()).map((a) => `${a.kind}:${a.status}`).reverse();
  assert.deepEqual(kinds, ["payer:ok", "split:ok", "approval:ok", "transfer:ok", "approval:ok", "transfer:ok"]);
});

test("a repeated approve never sends a second transfer", async () => {
  const { split, bank } = service();
  await split.handle({ kind: "payer", total: 480 }, ctx(WILSON));
  await split.handle({ kind: "approve" }, ctx(HETARTH, "pho_msg_a"));
  const again = await split.handle({ kind: "approve" }, ctx(HETARTH, "pho_msg_b"));
  assert.match(again, /already went to Wilson/);
  // Even run twice at the same moment.
  await Promise.all([split.handle({ kind: "approve" }, ctx(HARSH)), split.handle({ kind: "approve" }, ctx(HARSH))]);
  assert.equal(await bank.balance(HETARTH), 340);
  assert.equal(await bank.balance(HARSH), 1340);
  assert.equal(await bank.balance(WILSON), 1820);
  assert.equal((await listActivity()).filter((a) => a.kind === "transfer").length, 2);
});

test("refuses people who aren't on the list, payers approving, and short balances", async () => {
  const poor: Member = { name: "Poor", handles: ["+19058724476"], startBalance: 100 };
  const { split, bank } = service([WILSON, HETARTH, poor]);
  await split.handle({ kind: "payer", total: 480 }, ctx(WILSON));

  const stranger = await split.handle({ kind: "approve" }, ctx({ name: "Guest 0123", handles: ["+19995550123"] }));
  assert.match(stranger, /don't have your number on the member list/);
  assert.match(await split.handle({ kind: "approve" }, ctx(WILSON)), /you're the payer/);

  const short = await split.handle({ kind: "approve" }, ctx(poor));
  assert.match(short, /you have \$100 and your share is \$160, so I didn't send anything/);
  assert.equal(await bank.balance(poor), 100);
  assert.equal(await bank.balance(WILSON), 1500);
  assert.ok((await listActivity()).some((a) => a.kind === "transfer" && a.status === "failed"));
});

test("caps a single transfer and rejects absurd totals", async () => {
  const { split } = service();
  await split.handle({ kind: "payer" }, ctx(WILSON));
  assert.match(await split.handle({ kind: "total", total: 6000 }, ctx(WILSON)), /\$2,000 each, over my \$1,000 limit/);
  assert.match(await split.handle({ kind: "total", total: 2 }, ctx(WILSON)), /too small/);
  assert.equal((await loadTrip(CHAT))?.phase, "idle");
});

test("approve with nothing pending, and a changed mind before anyone pays", async () => {
  const { split, bank } = service();
  assert.match(await split.handle({ kind: "approve" }, ctx(HARSH)), /no split waiting for approval/);

  await split.handle({ kind: "payer", total: 480 }, ctx(WILSON));
  // Harsh takes over as payer and the total changes: approvals start over with new shares.
  const changed = await split.handle({ kind: "payer", total: 300 }, ctx(HARSH));
  assert.match(changed, /Harsh is paying \$300, so Wilson and Hetarth owe \$100 each/);
  assert.match(await split.handle({ kind: "cancel" }, ctx(HARSH)), /canceled the split/);
  assert.match(await split.handle({ kind: "approve" }, ctx(WILSON)), /no split waiting/);
  assert.equal(await bank.balance(WILSON), 1500);

  // Once money has moved, neither the payer nor the total can change, and it can't be canceled.
  await split.handle({ kind: "payer", total: 300 }, ctx(HARSH));
  await split.handle({ kind: "approve" }, ctx(WILSON));
  assert.match(await split.handle({ kind: "payer", total: 999 }, ctx(WILSON)), /already on their way to Harsh/);
  assert.match(await split.handle({ kind: "total", total: 999 }, ctx(HARSH)), /can't change now/);
  assert.match(await split.handle({ kind: "cancel" }, ctx(HARSH)), /already been sent/);
});

test("only people in the signup group are on the split", async () => {
  const groups = new GroupRegistry();
  const member = (m: Member, userId: string) => ({ name: m.name, handle: m.handles[0]!, userId });
  groups.upsert({ spaceId: "pho_spc_group", createdAt: "2026-10-17T00:00:00Z", members: [member(WILSON, "u1"), member(HETARTH, "u2")] });
  const split = new SplitService([WILSON, HETARTH, HARSH], getBank(), groups);
  assert.deepEqual(split.travelers("pho_spc_group").map((m) => m.name), ["Wilson", "Hetarth"]);
  assert.match(await split.handle({ kind: "payer", total: 400 }, ctx(WILSON)), /so Hetarth owes \$200 \(Wilson covers the rest\)/);
  assert.match(await split.handle({ kind: "approve" }, ctx(HARSH)), /don't have a share/);
});

test("signup groups become bank members once, with the configured balance", () => {
  const roster: Member[] = [{ ...WILSON }];
  const group = (members: { name: string; handle: string }[]) => ({
    spaceId: "pho_spc_x",
    createdAt: "2026-10-17T00:00:00Z",
    members: members.map((m, i) => ({ ...m, userId: `u${i}` })),
  });
  const added = mergeGroupMembers(roster, [
    group([{ name: "Wilson", handle: "+61 452 598 886" }, { name: "Priya", handle: "+16175550199" }, { name: "Wilson", handle: "+16175550142" }]),
  ]);
  assert.equal(added, 2);
  assert.deepEqual(roster.map((m) => m.name), ["Wilson", "Priya", "Wilson 0142"]);
  assert.equal(roster[1]!.startBalance, 1500);
  assert.equal(mergeGroupMembers(roster, []), 0);
});

// --- through the agent ---

class FakePhoton implements PhotonApi {
  messages: PhotonMessage[] = [];
  sent: SendTextArgs[] = [];
  private clock = 0;
  private next = 0;
  add(from: Member, text: string): PhotonMessage {
    this.clock = Math.max(this.clock + 1000, Date.now());
    const m: PhotonMessage = {
      id: `pho_msg_${++this.next}`,
      platform: "imessage",
      status: "received",
      createdAt: new Date(this.clock).toISOString(),
      space: { id: "pho_spc_group", kind: "group", participantIds: ["pho_usr_agent"] },
      sentBy: { id: `pho_usr_${from.name}`, kind: "human", handle: from.handles[0]! },
      content: { type: "text", format: "plain", text },
    };
    this.messages.push(m);
    return m;
  }
  async *listMessages(q: { direction?: string; createdSince?: string }) {
    yield* this.messages.filter((m) => (!q.createdSince || m.createdAt >= q.createdSince) && (q.direction !== "sent" || m.status !== "received"));
  }
  async getMessage(id: string) {
    return this.messages.find((m) => m.id === id)!;
  }
  async listAgents() {
    return [{ id: "pho_usr_agent", kind: "agent", handle: "+16285550000", details: { type: "dedicated" } }];
  }
  async createUser(): Promise<never> {
    throw new Error("unused");
  }
  async createSpace(): Promise<never> {
    throw new Error("unused");
  }
  async sendText(args: SendTextArgs) {
    this.sent.push(args);
    return { id: `pho_msg_out${this.sent.length}`, status: "dispatched", createdAt: new Date().toISOString() } as PhotonMessage;
  }
  async setTyping() {}
  async downloadAttachment(id: string) {
    const data = this.attachments.get(id);
    if (!data) throw new Error(`no attachment ${id}`);
    return { contentType: "image/png", data };
  }
  attachments = new Map<string, Buffer>();
}

function agentSetup() {
  const api = new FakePhoton();
  const suggestions: { budgets?: string }[] = [];
  const agent = new PhotonAgent(api, [WILSON, HETARTH, HARSH], {
    brain: {
      suggestTrip: async (args) => {
        suggestions.push(args);
        return "Montreal!";
      },
    },
    memory: { store: async () => {}, context: async () => ({ transcript: "", debug: [] }), forget: async () => {}, cutoffs: async () => new Map() },
    replySpaces: new Map(),
    groups: new GroupRegistry(),
    bank: getBank(),
  });
  return { api, agent, suggestions };
}

test("the agent runs the whole flow from group messages, with budgets in the trip prompt", async () => {
  const { api, agent, suggestions } = agentSetup();
  await agent.start();

  // A bare "approve" with no split waiting is ordinary chatter.
  api.add(HARSH, "approve");
  api.add(HETARTH, "@Tripchat give us a trip idea");
  api.add(WILSON, "@Tripchat I'll pay $480");
  await agent.poll();
  await agent.idle();
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0]!.budgets!, /Hetarth can spend up to \$250/);
  assert.deepEqual(api.sent.map((s) => s.text.slice(0, 22)), ["Montreal!", "Wilson is paying $480,"]);

  // Now approvals count without a mention, and only from the person who sends them.
  api.add(HETARTH, "approve");
  api.add(HARSH, "I approve of this plan");
  api.add(HARSH, "approve");
  await agent.poll();
  await agent.idle();
  assert.match(api.sent[2]!.text, /Sent \$160 from Hetarth to Wilson/);
  assert.match(api.sent[3]!.text, /Sent \$160 from Harsh to Wilson/);
  assert.equal(api.sent.length, 4);

  const bank = getBank();
  assert.equal(await bank.balance(WILSON), 1820);
  assert.equal((await loadTrip("imessage:pho_spc_group"))?.phase, "paid");
});

test("the dashboard shows balances, the split's progress and the log", async () => {
  const { split, bank, roster } = service();
  const dashboard = createDashboard(roster, bank);
  const before = await dashboard.snapshot();
  assert.equal(before.bank, "mock");
  assert.equal(before.split, null);
  assert.deepEqual(before.members.map((m) => [m.name, m.balance, m.cap]), [["Wilson", 1500, 750], ["Hetarth", 500, 250], ["Harsh", 1500, 750]]);
  assert.deepEqual(before.budget, { perPerson: 250, group: 750, limitedBy: "Hetarth" });

  await split.handle({ kind: "payer", total: 480 }, ctx(WILSON));
  await split.handle({ kind: "approve" }, ctx(HETARTH));
  await new Promise((r) => setTimeout(r, 700)); // past the snapshot cache
  const after = await dashboard.snapshot();
  assert.deepEqual(after.split, { payer: "Wilson", total: 480, perPerson: 160, phase: "collecting", sent: 1, of: 2 });
  const byName = Object.fromEntries(after.members.map((m) => [m.name, m]));
  assert.equal(byName.Hetarth!.balance, 340);
  assert.equal(byName.Hetarth!.sent, true);
  assert.equal(byName.Wilson!.balance, 1660);
  assert.equal(byName.Wilson!.isPayer, true);
  assert.equal(byName.Harsh!.share, 160);
  assert.equal(byName.Harsh!.sent, false);
  assert.match(after.activity[0]!.detail, /Hetarth sent \$160 to Wilson \(\$500 → \$340\)/);
  await (await getDb()).close();
});
