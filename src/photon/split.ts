import { randomUUID } from "node:crypto";
import type { Bank } from "../bank";
import { recordActivity } from "../bank/activity";
import { config } from "../config";
import { log } from "../log";
import { findMemberByHandle, findMemberByName, type Member } from "../members";
import { splitShares } from "../trip/money";
import { loadTrip, newTrip, resetPlan, saveTrip, type TripState } from "../trip/state";
import type { GroupRegistry } from "./groups";

export type SplitCommand =
  | { kind: "budgets" }
  | { kind: "payer"; total?: number }
  | { kind: "total"; total: number }
  | { kind: "approve" }
  | { kind: "cancel" }
  | { kind: "status" };

/** A bare "approve" (no mention) counts while a split is waiting on the group. */
const APPROVE = /^(?:i\s+)?approved?(?:\s+(?:it|the split|my share|the payment))?[.!]*$/i;

export function isApproveText(text: string): boolean {
  return APPROVE.test(text.replace(/[‘’]/g, "'").trim());
}

/** Whole dollars from "$480", "1,200", "480.50" (rounded), or undefined. */
export function parseAmount(text: string): number | undefined {
  const m = text.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return undefined;
  return Math.round(Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0));
}

/** A money command from message text with the @mention already removed, or undefined for anything else. */
export function parseSplitCommand(body: string): SplitCommand | undefined {
  const t = body.replace(/[‘’]/g, "'").trim().replace(/[?!.]+$/, "").toLowerCase();
  if (/^(?:budgets?|balances?|who can afford (?:it|what)|what can (?:we|everyone|each of us) (?:afford|spend))$/.test(t)) {
    return { kind: "budgets" };
  }
  const pay = t.match(/^(?:i'?ll pay|i will pay|i can pay|i'?m paying|i'?ll be the payer|i'?m the payer|i'?ll cover(?: it)?)\b(.*)$/);
  if (pay) {
    const total = parseAmount(pay[1]!);
    return total === undefined ? { kind: "payer" } : { kind: "payer", total };
  }
  const total = t.match(/^(?:the )?(?:total|split|cost)(?: is| of)?\s+(.+)$/);
  const amount = total ? parseAmount(total[1]!) : undefined;
  if (amount !== undefined) return { kind: "total", total: amount };
  if (APPROVE.test(t)) return { kind: "approve" };
  if (/^cancel (?:the )?(?:split|payment)s?$/.test(t)) return { kind: "cancel" };
  if (/^(?:status|where are we)$/.test(t)) return { kind: "status" };
  return undefined;
}

export interface SplitContext {
  /** Memory/trip-state key for the conversation. */
  chatId: string;
  /** The Space replies go to; its signup group says who's on the trip. */
  replySpaceId: string;
  /** Photon's handle (phone number) for the sender. Roster matching is by this, never by what the text says. */
  senderHandle: string;
  senderName: string;
  messageId: string;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The money flow in the chat: show budgets, pick a payer and a total,
 * collect each person's own approval, and move their share to the payer.
 * Nothing moves without that person's approval message, and every step is
 * written to the activity log the /nessie page shows.
 */
export class SplitService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly roster: Member[],
    private readonly bank: Bank,
    private readonly groups: GroupRegistry,
  ) {}

  /** Who's on the trip: the signup group's members, else everyone on the roster. */
  travelers(replySpaceId: string): Member[] {
    const group = this.groups.get(replySpaceId);
    const fromGroup = (group?.members ?? []).map((p) => findMemberByHandle(this.roster, p.handle)).filter((m): m is Member => !!m);
    const list = fromGroup.length >= 2 ? fromGroup : this.roster;
    return [...new Map(list.map((m) => [m.name, m])).values()];
  }

  /** True while a split is waiting for approvals. */
  async isCollecting(chatId: string): Promise<boolean> {
    return (await loadTrip(chatId))?.phase === "collecting";
  }

  private async limits(members: Member[]): Promise<{ member: Member; balance?: number; cap?: number }[]> {
    return Promise.all(
      members.map(async (member) => {
        try {
          const balance = await this.bank.balance(member);
          return { member, balance, cap: Math.floor(balance * config.BALANCE_CAP_FRACTION) };
        } catch (err) {
          log.error("balance_failed", err, { member: member.name });
          return { member };
        }
      }),
    );
  }

  /** One line for the trip-idea prompt, so suggestions fit everyone's wallet. Undefined if no balances are known. */
  async budgetLine(members: Member[]): Promise<string | undefined> {
    const known = (await this.limits(members)).filter((l) => l.cap !== undefined);
    if (known.length === 0) return undefined;
    return known.map((l) => `${l.member.name} can spend up to ${usd(l.cap!)}`).join("; ");
  }

  private async budgetText(members: Member[]): Promise<string> {
    const limits = await this.limits(members);
    const pct = Math.round(config.BALANCE_CAP_FRACTION * 100);
    const lines = limits.map((l) =>
      l.cap === undefined ? `${l.member.name}: balance unavailable` : `${l.member.name}: up to ${usd(l.cap)} (balance ${usd(l.balance!)})`,
    );
    const caps = limits.filter((l) => l.cap !== undefined);
    if (caps.length > 0) {
      const lowest = Math.min(...caps.map((l) => l.cap!));
      lines.push(`Everyone can afford ${usd(lowest)} each, or ${usd(lowest * caps.length)} for the group.`);
    }
    return [`Here's what each of you can spend (${pct}% of your sandbox Capital One balance):`, ...lines].join("\n");
  }

  /** Run one money command and return what to say. Commands for one chat never overlap. */
  handle(cmd: SplitCommand, ctx: SplitContext): Promise<string> {
    const next = (this.locks.get(ctx.chatId) ?? Promise.resolve()).then(() => this.run(cmd, ctx));
    this.locks.set(ctx.chatId, next.catch(() => undefined));
    return next;
  }

  private async run(cmd: SplitCommand, ctx: SplitContext): Promise<string> {
    const members = this.travelers(ctx.replySpaceId);
    if (cmd.kind === "budgets") {
      await recordActivity({ chatId: ctx.chatId, kind: "budget", actor: ctx.senderName, detail: `${ctx.senderName} asked for everyone's budget` });
      return this.budgetText(members);
    }

    const trip = (await loadTrip(ctx.chatId)) ?? newTrip(ctx.chatId);
    const sender = findMemberByHandle(this.roster, ctx.senderHandle);
    if (cmd.kind === "status") return this.status(trip);
    if (!sender) return `${ctx.senderName}, I don't have your number on the member list, so I can't move money for you.`;
    if (this.bank.name === "nessie" && !sender.nessieAccountId) {
      return `${sender.name}, you don't have a sandbox bank account yet. Run npm run seed:nessie and try again.`;
    }

    switch (cmd.kind) {
      case "payer":
        return this.setPayer(trip, members, sender, ctx, cmd.total);
      case "total":
        return this.setTotal(trip, members, sender, ctx, cmd.total);
      case "approve":
        return this.approve(trip, sender, ctx);
      case "cancel":
        return this.cancel(trip, sender, ctx);
    }
  }

  private status(trip: TripState): string {
    if (trip.phase === "collecting") {
      const owed = Object.keys(trip.shares);
      const done = owed.filter((k) => trip.transfers[k]);
      const waiting = owed.filter((k) => !trip.transfers[k]);
      return `${trip.payerKey} is paying ${usd(trip.splitTotalUsd ?? 0)}. ${done.length} of ${owed.length} shares sent${waiting.length > 0 ? `, waiting on ${listNames(waiting)}` : ""}.`;
    }
    if (trip.phase === "paid") return `All settled: everyone has paid ${trip.payerKey}.`;
    if (trip.payerKey) return `${trip.payerKey} is paying. Text "@${config.AGENT_NAME} total 480" with the full cost and I'll work out everyone's share.`;
    return `Nothing to split yet. Text "@${config.AGENT_NAME} I'll pay 480" when someone has paid.`;
  }

  private async setPayer(trip: TripState, members: Member[], sender: Member, ctx: SplitContext, total?: number): Promise<string> {
    if (Object.keys(trip.transfers).length > 0) {
      return `Shares are already on their way to ${trip.payerKey}, so the payer can't change now.`;
    }
    if (!members.some((m) => m.name === sender.name)) return `${sender.name}, you're not on this trip's member list.`;
    trip.payerKey = sender.name;
    await recordActivity({ chatId: ctx.chatId, kind: "payer", actor: sender.name, detail: `${sender.name} is the payer` });
    const amount = total ?? trip.splitTotalUsd;
    if (amount === undefined) {
      trip.phase = "idle";
      await saveTrip(trip);
      return `Got it, ${sender.name} is paying. Text "@${config.AGENT_NAME} total 480" with the full cost and I'll work out everyone's share.`;
    }
    return this.propose(trip, members, amount, ctx);
  }

  private async setTotal(trip: TripState, members: Member[], sender: Member, ctx: SplitContext, total: number): Promise<string> {
    if (Object.keys(trip.transfers).length > 0) {
      return `Shares are already on their way to ${trip.payerKey}, so the total can't change now.`;
    }
    if (!trip.payerKey) return `Who's paying? Text "@${config.AGENT_NAME} I'll pay ${total}" and I'll split it.`;
    if (!members.some((m) => m.name === sender.name)) return `${sender.name}, you're not on this trip's member list.`;
    return this.propose(trip, members, total, ctx);
  }

  /** Work out each person's share of `total` and ask them to approve. */
  private async propose(trip: TripState, members: Member[], total: number, ctx: SplitContext): Promise<string> {
    const payerKey = trip.payerKey!;
    const keys = members.map((m) => m.name);
    if (!keys.includes(payerKey)) return `${payerKey} isn't on this trip's member list.`;
    const per = Math.floor(total / keys.length);
    if (per < 1) return `${usd(total)} is too small to split between ${keys.length} people in whole dollars.`;
    if (per > config.MAX_TRANSFER_USD) {
      return `That would be ${usd(per)} each, over my ${usd(config.MAX_TRANSFER_USD)} limit for a single transfer. Try a smaller total.`;
    }

    trip.splitTotalUsd = total;
    trip.shares = Object.fromEntries(splitShares(total, keys, payerKey));
    trip.approvals = {};
    trip.transfers = {};
    trip.planId = randomUUID();
    trip.phase = "collecting";
    await saveTrip(trip);
    const owing = Object.keys(trip.shares);
    await recordActivity({
      chatId: ctx.chatId,
      kind: "split",
      actor: payerKey,
      amount: total,
      detail: `${payerKey} is paying ${usd(total)}; ${listNames(owing)} ${owing.length === 1 ? "owes" : "owe"} ${usd(per)}${owing.length === 1 ? "" : " each"}`,
    });

    const short: string[] = [];
    for (const l of await this.limits(members.filter((m) => owing.includes(m.name)))) {
      if (l.balance !== undefined && l.balance < per) short.push(`${l.member.name} has ${usd(l.balance)}`);
    }
    return [
      `${payerKey} is paying ${usd(total)}, so ${listNames(owing)} ${owing.length === 1 ? "owes" : "owe"} ${usd(per)}${owing.length === 1 ? "" : " each"} (${payerKey} covers the rest).`,
      `${listNames(owing)}: reply "approve" and I'll send your share to ${payerKey} through Capital One (sandbox money). Nothing moves until you do.`,
      ...(short.length > 0 ? [`Heads up: ${listNames(short)}, which isn't enough for a ${usd(per)} share.`] : []),
    ].join("\n\n");
  }

  private async approve(trip: TripState, sender: Member, ctx: SplitContext): Promise<string> {
    if (trip.phase !== "collecting" || !trip.payerKey) {
      return `There's no split waiting for approval. Text "@${config.AGENT_NAME} I'll pay 480" to start one.`;
    }
    const key = sender.name;
    if (key === trip.payerKey) return `${sender.name}, you're the payer, so there's nothing for you to send.`;
    const share = trip.shares[key];
    if (share === undefined) return `${sender.name}, you don't have a share on this split.`;
    // A repeated "approve" never sends a second transfer.
    if (trip.transfers[key]) return `${sender.name}, your ${usd(share)} share already went to ${trip.payerKey}.`;
    if (share > config.MAX_TRANSFER_USD) return `${usd(share)} is over my ${usd(config.MAX_TRANSFER_USD)} limit for a single transfer, so I can't send it.`;

    const payer = findMemberByName(this.roster, trip.payerKey);
    if (!payer) return `I can't find ${trip.payerKey}'s account, so I didn't move any money.`;

    const before = await this.bank.balance(sender);
    if (before < share) {
      await recordActivity({
        chatId: ctx.chatId,
        kind: "transfer",
        actor: key,
        counterparty: payer.name,
        amount: share,
        status: "failed",
        detail: `${key} approved ${usd(share)} but only has ${usd(before)}`,
      });
      return `${sender.name}, you have ${usd(before)} and your share is ${usd(share)}, so I didn't send anything.`;
    }

    trip.approvals[key] = true;
    await saveTrip(trip);
    await recordActivity({
      chatId: ctx.chatId,
      kind: "approval",
      actor: key,
      amount: share,
      detail: `${key} approved their ${usd(share)} share (message ${ctx.messageId.slice(-6)})`,
    });

    try {
      // The ref is per plan and person, so a retry after a crash can't pay twice.
      await this.bank.move(sender, payer, share, `${trip.planId}:${key}`, `${config.AGENT_NAME}: ${key} to ${payer.name}`);
    } catch (err) {
      log.error("transfer_failed", err, { chatId: ctx.chatId });
      await recordActivity({
        chatId: ctx.chatId,
        kind: "transfer",
        actor: key,
        counterparty: payer.name,
        amount: share,
        status: "failed",
        detail: `Transfer from ${key} to ${payer.name} failed`,
      });
      return `The transfer from ${sender.name} to ${payer.name} failed. Nothing is sent twice, so reply "approve" again to retry.`;
    }
    trip.transfers[key] = { at: new Date().toISOString() };
    const settled = Object.keys(trip.shares).every((k) => trip.transfers[k]);
    if (settled) trip.phase = "paid";
    await saveTrip(trip);

    const after = await this.bank.balance(sender);
    await recordActivity({
      chatId: ctx.chatId,
      kind: "transfer",
      actor: key,
      counterparty: payer.name,
      amount: share,
      detail: `${key} sent ${usd(share)} to ${payer.name} (${usd(before)} → ${usd(after)})`,
    });

    const sent = `Sent ${usd(share)} from ${sender.name} to ${payer.name} (${usd(before)} → ${usd(after)}).`;
    if (settled) {
      return `${sent}\n\nThat's everyone. ${payer.name} now has ${usd(await this.bank.balance(payer))}. Have a great trip!`;
    }
    const waiting = Object.keys(trip.shares).filter((k) => !trip.transfers[k]);
    return `${sent} Still waiting on ${listNames(waiting)}.`;
  }

  private async cancel(trip: TripState, sender: Member, ctx: SplitContext): Promise<string> {
    if (Object.keys(trip.transfers).length > 0) return `Shares have already been sent to ${trip.payerKey}, so I can't cancel the split now.`;
    if (!trip.payerKey) return "There's no split to cancel.";
    resetPlan(trip);
    trip.phase = "idle";
    await saveTrip(trip);
    await recordActivity({ chatId: ctx.chatId, kind: "split", actor: sender.name, detail: `${sender.name} canceled the split` });
    return "Okay, I canceled the split. Nothing was sent.";
  }
}
