// End-to-end state machine: plan → vote → book → (mock) call → approvals →
// bank transfers, against an in-memory database. The LLM steps are stubbed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Space } from "spectrum-ts";

Object.assign(process.env, {
  PGLITE_DIR: "memory://",
  DATABASE_URL: "",
  NESSIE_API_KEY: "",
  PLATFORM: "terminal",
  VOICE_PROVIDER: "mock",
  MOCK_CALL_OUTCOME: "booked",
  MOCK_CALL_DELAY_MS: "10",
  DEBUG_PORT: "0",
});

const { TripAgent } = await import("../src/agent/handler");
const { getBank } = await import("../src/bank");
const { loadTrip } = await import("../src/trip/state");
const { getDb } = await import("../src/db");
type Member = import("../src/members").Member;
type PlanOption = import("../src/trip/state").PlanOption;

const roster: Member[] = [
  { name: "Matias", handles: ["+16175550101"], startBalance: 1800 },
  { name: "Harsh", handles: ["+16175550102"], startBalance: 1500 },
  { name: "Hetarth", handles: ["+16175550103"], startBalance: 1200 },
  { name: "wiloz", handles: ["+16175550104"], startBalance: 900 },
];
const guests = roster.map((m) => m.name);
const option = (hotelId: string, hotelName: string, totalUsd: number): PlanOption => ({
  title: `Montreal, Dec 19-22 (${hotelName})`,
  hotelId,
  hotelName,
  city: "Montreal",
  checkIn: "2026-12-19",
  checkOut: "2026-12-22",
  nights: 3,
  rooms: 2,
  guests,
  totalUsd,
  perPersonUsd: Math.ceil(totalUsd / 4),
  rationale: "Dec 19-22 since Harsh is busy until the 18th.",
  sources: [],
});

const sent: string[] = [];
let nextId = 0;
const space = {
  id: "chat-1",
  async send(content: unknown) {
    sent.push(typeof content === "string" ? content : "[rich content]");
    return { id: `out-${++nextId}` };
  },
  async responding<T>(fn: () => T | Promise<T>) {
    return fn();
  },
} as unknown as Space;
const message = { react: async () => undefined } as unknown as Message;

const pending: Promise<void>[] = [];
const enqueue = (_chatId: string, task: () => Promise<void>) => void pending.push(task());
const settle = async () => {
  await new Promise((r) => setTimeout(r, 200));
  await Promise.all(pending);
};

const bank = getBank();
const agent = new TripAgent(roster, bank, enqueue, {
  makePlan: async () => ({
    options: [option("mtl-plateau", "Plateau Lofts (demo)", 990), option("mtl-oldport", "Old Port Inn (demo)", 1374)],
    debug: [],
  }),
  answerQuestion: async () => "stub answer",
});

const ctx = { chatId: "terminal:chat-1", platform: "terminal", isGroup: true, space };
const as = (name: string) => {
  const member = roster.find((m) => m.name === name);
  return { key: member?.name ?? name, name, member };
};
const lastSaid = () => sent[sent.length - 1] ?? "";

test("full trip: plan, vote, book, split", async () => {
  await agent.onText(ctx, as("Matias"), "@Tripchat plan it", message);
  let trip = (await loadTrip(ctx.chatId))!;
  assert.equal(trip.phase, "voting");
  assert.ok(sent[0]!.startsWith("Hi! I'm Tripchat"), "introduces itself first");
  assert.equal(Object.keys(trip.optionMessages).length, 2);

  // Someone who isn't a traveler can't vote.
  await agent.onText(ctx, as("You"), "vote 2", message);
  assert.match(lastSaid(), /only have Matias, Harsh, Hetarth, wiloz/);

  await agent.onText(ctx, as("Harsh"), "vote 1", message);
  const firstOptionMessage = Object.entries(trip.optionMessages).find(([, i]) => i === 0)![0];
  await agent.onReaction(ctx, as("Hetarth"), "❤️", firstOptionMessage);
  trip = (await loadTrip(ctx.chatId))!;
  assert.equal(trip.phase, "voting", "2 of 4 is not a majority");

  await agent.onText(ctx, as("wiloz"), "I vote for 1", message);
  trip = (await loadTrip(ctx.chatId))!;
  assert.equal(trip.phase, "confirming");
  assert.equal(trip.chosen, 0);

  await agent.onText(ctx, as("Matias"), "@Tripchat book it", message);
  assert.equal((await loadTrip(ctx.chatId))!.phase, "calling");
  await settle();
  trip = (await loadTrip(ctx.chatId))!;
  assert.equal(trip.phase, "collecting");
  assert.equal(trip.booking?.status, "booked");
  assert.equal(trip.payerKey, "Matias", "whoever confirmed the booking pays by default");
  assert.deepEqual(trip.shares, { Harsh: 247, Hetarth: 247, wiloz: 247 });

  // A bare "approve" from the payer moves nothing.
  await agent.onText(ctx, as("Matias"), "approve", message);
  assert.match(lastSaid(), /you're the payer/);

  await agent.onText(ctx, as("Harsh"), "approve", message);
  await agent.onText(ctx, as("Hetarth"), "Approved!", message);
  assert.equal((await loadTrip(ctx.chatId))!.phase, "collecting");
  await agent.onText(ctx, as("wiloz"), "@Tripchat I approve", message);

  trip = (await loadTrip(ctx.chatId))!;
  assert.equal(trip.phase, "paid");
  assert.match(lastSaid(), /Shares moved through Capital One \(mock bank\)/);
  assert.equal(await bank.balance(roster[0]!), 1800 + 3 * 247);
  assert.equal(await bank.balance(roster[1]!), 1500 - 247);
  assert.equal(await bank.balance(roster[3]!), 900 - 247);
});

test("approving again after paying never moves money twice", async () => {
  await agent.onText(ctx, as("Harsh"), "@Tripchat approve", message);
  assert.equal(await bank.balance(roster[1]!), 1500 - 247);
  assert.equal(await bank.balance(roster[0]!), 1800 + 3 * 247);
});

test("forget wipes the chat", async () => {
  await agent.onText(ctx, as("Harsh"), "@Tripchat forget", message);
  const trip = (await loadTrip(ctx.chatId))!;
  assert.equal(trip.phase, "idle");
  assert.equal(trip.options.length, 0);
  assert.match(lastSaid(), /deleted every message/);
  await (await getDb()).close();
});
