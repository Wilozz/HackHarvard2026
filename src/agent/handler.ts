import { randomUUID } from "node:crypto";
import { poll, type Message, type Space } from "spectrum-ts";
import type { Bank } from "../bank";
import { config } from "../config";
import { log } from "../log";
import { findMemberByName, type Member } from "../members";
import { forgetChat } from "../memory/ingest";
import { hotelPhone, loadCatalog } from "../trip/catalog";
import { splitShares } from "../trip/money";
import { loadTrip, newTrip, resetPlan, saveTrip, type PlanOption, type TripState } from "../trip/state";
import { CallNotAllowedError, placeReservationCall, type CallOutcome } from "../voice";
import { answerQuestion } from "./answer";
import { parseCommand } from "./commands";
import { makePlan } from "./planner";

export interface ChatContext {
  chatId: string;
  platform: string;
  isGroup: boolean;
  space: Space;
}

export interface Sender {
  /** Stable key for votes and approvals: the roster name, else the display name. */
  key: string;
  name: string;
  member?: Member;
}

type Enqueue = (chatId: string, task: () => Promise<void>) => void;

/** The LLM-backed steps, injectable so the state machine can be tested without API calls. */
export interface AgentBrain {
  makePlan: typeof makePlan;
  answerQuestion: typeof answerQuestion;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

function optionLine(i: number, o: PlanOption): string {
  return `${i + 1}. ${o.title}: ${o.hotelName}, ${shortDate(o.checkIn)} to ${shortDate(o.checkOut)} (${o.nights} night${o.nights === 1 ? "" : "s"}), ${o.rooms} room${o.rooms === 1 ? "" : "s"}. About ${usd(o.totalUsd)} total, ${usd(o.perPersonUsd)} each.\n${o.rationale}`;
}

function pollTitle(i: number, o: PlanOption): string {
  return `${i + 1}. ${o.title}`;
}

export class TripAgent {
  /** Chats with a reservation call running in this process. */
  private readonly activeCalls = new Set<string>();
  /** Latest trip state per chat, for the debug view. */
  readonly recent = new Map<string, TripState>();

  constructor(
    private readonly roster: Member[],
    private readonly bank: Bank | undefined,
    private readonly enqueue: Enqueue,
    private readonly brain: AgentBrain = { makePlan, answerQuestion },
  ) {}

  private intro(): string {
    const name = config.AGENT_NAME;
    return [
      `Hi! I'm ${name}, an AI travel agent. I remember what this chat says about trips so I can plan one everyone agrees on.`,
      `Text "@${name} plan it" when you're ready, or ask me anything, like "@${name} what did Harsh say about dates?"`,
      `I never book anything or move money without the group confirming here first. "@${name} forget" deletes everything I've stored from this chat.`,
    ].join("\n\n");
  }

  private help(): string {
    const n = `@${config.AGENT_NAME}`;
    return [
      `${n} plan it: options from what you've all said`,
      `vote 2 (or react to an option): pick one`,
      `${n} book it: I call the hotel to hold the rooms`,
      `${n} I'll pay: you're the one paying the hotel`,
      `approve: send your share to the payer`,
      `${n} status, ${n} forget, or ask me anything about the chat`,
    ].join("\n");
  }

  private async say(ctx: ChatContext, text: string): Promise<Message | undefined> {
    return ctx.space.send(text);
  }

  private async load(ctx: ChatContext): Promise<TripState> {
    const trip = (await loadTrip(ctx.chatId)) ?? newTrip(ctx.chatId);
    // A call can't survive a restart; let the group retry instead of waiting forever.
    if (trip.phase === "calling" && !this.activeCalls.has(ctx.chatId)) {
      trip.phase = "confirming";
      if (trip.booking) trip.booking.status = "failed";
      await this.say(ctx, `I lost track of the hotel call when I restarted. Say "@${config.AGENT_NAME} book it" to call again.`);
      await this.save(trip);
    }
    return trip;
  }

  private async save(trip: TripState): Promise<void> {
    await saveTrip(trip);
    this.recent.set(trip.chatId, trip);
  }

  async onText(ctx: ChatContext, sender: Sender, text: string, message: Message): Promise<void> {
    const trip = await this.load(ctx);
    if (!trip.introduced) {
      trip.introduced = true;
      await this.save(trip);
      await this.say(ctx, this.intro());
    }

    const cmd = parseCommand(text, { agentName: config.AGENT_NAME, requireMention: ctx.isGroup, phase: trip.phase });
    switch (cmd.kind) {
      case "none":
        return;
      case "help":
        await this.say(ctx, this.help());
        return;
      case "status":
        await this.say(ctx, this.status(trip));
        return;
      case "forget":
        await forgetChat(ctx.chatId);
        this.recent.delete(ctx.chatId);
        await this.save({ ...newTrip(ctx.chatId), introduced: true });
        await this.say(ctx, "Done. I deleted every message, memory, and plan I had stored from this chat.");
        return;
      case "plan":
        await this.plan(ctx, trip, cmd.request, message);
        return;
      case "vote":
        await this.vote(ctx, trip, sender, cmd.option - 1);
        return;
      case "book":
        await this.book(ctx, trip, sender);
        return;
      case "payer":
        await this.setPayer(ctx, trip, sender);
        return;
      case "approve":
        await this.approve(ctx, trip, sender);
        return;
      case "ask":
        await this.ask(ctx, cmd.question);
        return;
    }
  }

  /** A reaction on one of our option messages counts as a vote for it (👎 withdraws it). */
  async onReaction(ctx: ChatContext, sender: Sender, emoji: string, targetId: string): Promise<void> {
    const trip = await this.load(ctx);
    if (trip.phase !== "voting") return;
    const option = trip.optionMessages[targetId];
    if (option === undefined) return;
    if (emoji === "👎") {
      if (trip.votes[sender.key] === option) {
        delete trip.votes[sender.key];
        await this.save(trip);
      }
      return;
    }
    await this.vote(ctx, trip, sender, option, { quiet: true });
  }

  /** A native iMessage poll vote. */
  async onPollVote(ctx: ChatContext, sender: Sender, optionTitle: string, selected: boolean): Promise<void> {
    const trip = await this.load(ctx);
    if (trip.phase !== "voting") return;
    const option = trip.options.findIndex((o, i) => pollTitle(i, o) === optionTitle);
    if (option < 0) return;
    if (!selected) {
      if (trip.votes[sender.key] === option) {
        delete trip.votes[sender.key];
        await this.save(trip);
      }
      return;
    }
    await this.vote(ctx, trip, sender, option, { quiet: true });
  }

  private status(trip: TripState): string {
    const chosen = trip.chosen !== undefined ? trip.options[trip.chosen] : undefined;
    switch (trip.phase) {
      case "idle":
        return `Nothing planned yet. Text "@${config.AGENT_NAME} plan it" when you're ready.`;
      case "voting":
        return `Voting on ${trip.options.length} options. ${Object.keys(trip.votes).length} vote(s) in so far.`;
      case "confirming":
        return chosen ? `We picked ${chosen.title}. Say "@${config.AGENT_NAME} book it" and I'll call ${chosen.hotelName}.` : "Waiting to book.";
      case "calling":
        return `I'm on the phone with ${chosen?.hotelName ?? "the hotel"} right now.`;
      case "collecting": {
        const owed = Object.keys(trip.shares);
        const done = owed.filter((k) => trip.approvals[k]);
        return `Booked. Waiting on approvals to pay ${trip.payerKey}: ${done.length} of ${owed.length} in${owed.length > done.length ? ` (still need ${owed.filter((k) => !trip.approvals[k]).join(", ")})` : ""}.`;
      }
      case "paid":
        return `All set: ${chosen?.title ?? "the trip"} is booked and everyone has paid ${trip.payerKey} back.`;
    }
  }

  private async plan(ctx: ChatContext, trip: TripState, request: string, message: Message): Promise<void> {
    if (trip.phase === "calling") {
      await this.say(ctx, "I'm on the phone with the hotel right now. I'll post back here as soon as I hang up.");
      return;
    }
    if (trip.phase === "collecting" && Object.keys(trip.transfers).length > 0) {
      await this.say(ctx, "Some shares have already been sent for this booking. Let's finish the split before planning a new trip.");
      return;
    }

    await message.react("👍").catch(() => undefined);
    const result = await ctx.space.responding(() =>
      this.brain.makePlan({ chatId: ctx.chatId, request, roster: this.roster, bank: this.bank }),
    );

    resetPlan(trip);
    trip.planId = randomUUID();
    trip.lastRetrieval = result.debug;
    if (result.context) trip.context = result.context;
    if (result.options.length === 0) {
      await this.save(trip);
      await this.say(ctx, result.problem ?? "I couldn't put together options from the chat yet.");
      return;
    }

    trip.options = result.options;
    trip.phase = "voting";
    await this.say(ctx, `Here ${result.options.length === 1 ? "is 1 option" : `are ${result.options.length} options`} based on what you've all said:`);
    for (const [i, option] of result.options.entries()) {
      const sent = await this.say(ctx, optionLine(i, option));
      if (sent) trip.optionMessages[sent.id] = i;
    }
    if (ctx.platform === "imessage" && result.options.length >= 2) {
      await ctx.space
        .send(poll("Which trip?", result.options.map((o, i) => pollTitle(i, o))))
        .catch((err) => log.error("poll_failed", err, { chatId: ctx.chatId }));
    }
    const open = result.context?.open_questions.slice(0, 2) ?? [];
    await this.say(
      ctx,
      [`Vote by reacting to an option or texting "vote 2". Nothing gets booked until you confirm.`, ...open.map((q) => `Still open: ${q}`)].join("\n"),
    );
    await this.save(trip);
  }

  private voters(trip: TripState): string[] {
    return trip.options[0]?.guests ?? [];
  }

  private async vote(ctx: ChatContext, trip: TripState, sender: Sender, option: number, opts: { quiet?: boolean } = {}): Promise<void> {
    if (trip.phase !== "voting") {
      if (!opts.quiet) await this.say(ctx, `There's no vote open right now. Text "@${config.AGENT_NAME} plan it" to get options.`);
      return;
    }
    if (!trip.options[option]) {
      if (!opts.quiet) await this.say(ctx, `There are only ${trip.options.length} options.`);
      return;
    }
    const voters = this.voters(trip);
    if (voters.length > 0 && !voters.some((v) => v.toLowerCase() === sender.key.toLowerCase())) {
      if (!opts.quiet) await this.say(ctx, `${sender.name}, I only have ${voters.join(", ")} down as travelers for this trip.`);
      return;
    }
    trip.votes[sender.key] = option;

    const tally = trip.options.map((_, i) => Object.values(trip.votes).filter((v) => v === i).length);
    const electorate = voters.length > 0 ? voters.length : Object.keys(trip.votes).length;
    const best = Math.max(...tally);
    const leaders = tally.flatMap((n, i) => (n === best ? [i] : []));
    const everyoneVoted = Object.keys(trip.votes).length >= electorate;
    const majority = best > electorate / 2;

    if ((majority || everyoneVoted) && leaders.length === 1) {
      const winner = leaders[0]!;
      trip.chosen = winner;
      trip.phase = "confirming";
      await this.save(trip);
      const o = trip.options[winner]!;
      await this.say(
        ctx,
        `Option ${winner + 1} wins: ${o.title} at ${o.hotelName}. Say "@${config.AGENT_NAME} book it" and I'll call to hold ${o.rooms} room${o.rooms === 1 ? "" : "s"} for ${shortDate(o.checkIn)} to ${shortDate(o.checkOut)}. Nothing is charged now; you pay at the hotel.`,
      );
      return;
    }
    await this.save(trip);
    if (everyoneVoted && leaders.length > 1) {
      await this.say(ctx, `It's a tie between ${leaders.map((i) => `option ${i + 1}`).join(" and ")}. Someone change their vote to break it.`);
    } else if (!opts.quiet) {
      await this.say(ctx, `Got it, ${sender.name}: option ${option + 1}. ${Object.keys(trip.votes).length} of ${electorate} voted.`);
    }
  }

  private async book(ctx: ChatContext, trip: TripState, sender: Sender): Promise<void> {
    if (trip.phase === "calling") {
      await this.say(ctx, "Already on the phone with the hotel.");
      return;
    }
    const option = trip.chosen !== undefined ? trip.options[trip.chosen] : undefined;
    if (trip.phase !== "confirming" || !option || trip.chosen === undefined) {
      await this.say(ctx, `We haven't picked an option yet. Text "@${config.AGENT_NAME} plan it" to get options, then vote.`);
      return;
    }
    const hotel = loadCatalog().find((h) => h.id === option.hotelId);
    const phone = hotel ? hotelPhone(hotel) : undefined;
    if (!hotel || (!phone && config.VOICE_PROVIDER !== "mock")) {
      await this.say(ctx, "I don't have a phone number for that hotel. Set DEMO_FRONT_DESK_PHONE for the demo.");
      return;
    }

    if (!trip.payerKey && sender.member) trip.payerKey = sender.key;
    const guestName = trip.payerKey ?? sender.name;
    const constraints = new Set<string>();
    for (const m of trip.context?.members ?? []) if (option.guests.includes(m.name)) for (const c of m.constraints) constraints.add(`${m.name}: ${c}`);

    trip.phase = "calling";
    trip.booking = { option: trip.chosen, status: "calling" };
    await this.save(trip);
    await this.say(ctx, `Calling ${hotel.name} now to hold ${option.rooms} room${option.rooms === 1 ? "" : "s"} under ${guestName}. I'll post back here when I hang up.`);

    const attempt = `${trip.planId ?? ctx.chatId}-${Date.now()}`;
    this.activeCalls.add(ctx.chatId);
    placeReservationCall({
      to: phone ?? "",
      hotelName: hotel.name,
      checkIn: option.checkIn,
      checkOut: option.checkOut,
      nights: option.nights,
      rooms: option.rooms,
      guestCount: option.guests.length,
      guestName,
      maxNightlyUsd: hotel.nightlyRateUsd,
      specialRequests: [...constraints].slice(0, 6),
      idempotencyKey: attempt.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200),
    })
      .then((outcome) => this.enqueue(ctx.chatId, () => this.onCallOutcome(ctx, outcome)))
      .catch((err) => {
        log.error("call_failed", err, { chatId: ctx.chatId });
        const summary = err instanceof CallNotAllowedError ? "That number isn't on the call allowlist, so I didn't dial it." : "The call didn't go through.";
        this.enqueue(ctx.chatId, () => this.onCallOutcome(ctx, { status: "failed", summary }));
      })
      .finally(() => this.activeCalls.delete(ctx.chatId));
  }

  private async onCallOutcome(ctx: ChatContext, outcome: CallOutcome): Promise<void> {
    const trip = (await loadTrip(ctx.chatId)) ?? newTrip(ctx.chatId);
    const option = trip.chosen !== undefined ? trip.options[trip.chosen] : undefined;
    if (trip.phase !== "calling" || !trip.booking || !option) return; // plan was reset or forgotten mid-call

    if (outcome.status !== "booked") {
      trip.phase = "confirming";
      trip.booking.status = outcome.status;
      trip.booking.summary = outcome.summary;
      await this.save(trip);
      await this.say(
        ctx,
        `${outcome.summary}\n\nSay "@${config.AGENT_NAME} book it" to try again, or "@${config.AGENT_NAME} plan it" for new options.`,
      );
      return;
    }

    const totalUsd = outcome.quotedTotalUsd ?? option.totalUsd;
    trip.booking = { ...trip.booking, status: "booked", confirmation: outcome.confirmation, totalUsd, summary: outcome.summary };
    const lines = [
      `Booked! ${outcome.summary}`,
      `${option.title}, ${shortDate(option.checkIn)} to ${shortDate(option.checkOut)}. ${outcome.confirmation ? `Confirmation ${outcome.confirmation}. ` : ""}About ${usd(totalUsd)} total, paid at the hotel.`,
    ];

    const split = this.splitReady(option);
    if (!split.ok) {
      trip.phase = "paid";
      await this.save(trip);
      await this.say(ctx, [...lines, split.reason].join("\n\n"));
      return;
    }
    trip.payerKey ??= option.guests[0]!;
    this.recomputeShares(trip, totalUsd, option.guests);
    trip.phase = "collecting";
    await this.save(trip);
    await this.say(ctx, [...lines, this.collectMessage(trip)].join("\n\n"));
  }

  private splitReady(option: PlanOption): { ok: true } | { ok: false; reason: string } {
    if (!this.bank) return { ok: false, reason: "Add the group to members.json to split the bill through Capital One." };
    const missing = option.guests.filter((g) => {
      const m = findMemberByName(this.roster, g);
      return !m || (this.bank?.name === "nessie" && !m.nessieAccountId);
    });
    if (missing.length > 0) return { ok: false, reason: `I can't split the bill yet: no bank account on file for ${missing.join(", ")}.` };
    return { ok: true };
  }

  private recomputeShares(trip: TripState, totalUsd: number, guests: string[]): void {
    trip.shares = Object.fromEntries(splitShares(totalUsd, guests, trip.payerKey!));
    trip.approvals = {};
  }

  private collectMessage(trip: TripState): string {
    const owed = Object.entries(trip.shares);
    if (owed.length === 0) return `${trip.payerKey} is covering it.`;
    const amount = owed[0]![1];
    return `${trip.payerKey} pays the hotel. To split it, ${owed.map(([k]) => k).join(", ")}: reply "approve" and I'll send your ${usd(amount)} share to ${trip.payerKey} through Capital One. Not the payer? "@${config.AGENT_NAME} I'll pay" switches it.`;
  }

  private async setPayer(ctx: ChatContext, trip: TripState, sender: Sender): Promise<void> {
    if (!sender.member) {
      await this.say(ctx, `${sender.name}, I don't have you in members.json, so I can't route money to you.`);
      return;
    }
    if (Object.keys(trip.transfers).length > 0) {
      await this.say(ctx, `Shares are already on their way to ${trip.payerKey}, so the payer can't change now.`);
      return;
    }
    if (trip.phase === "collecting") {
      const option = trip.options[trip.chosen!]!;
      if (!option.guests.includes(sender.key)) {
        await this.say(ctx, `${sender.name}, you're not on this booking.`);
        return;
      }
      trip.payerKey = sender.key;
      this.recomputeShares(trip, trip.booking?.totalUsd ?? option.totalUsd, option.guests);
      await this.save(trip);
      await this.say(ctx, `Got it, ${sender.name} is paying. Approvals start over.\n\n${this.collectMessage(trip)}`);
      return;
    }
    if (trip.phase === "voting" || trip.phase === "confirming") {
      trip.payerKey = sender.key;
      await this.save(trip);
      await this.say(ctx, `Got it, ${sender.name} will pay the hotel and the rest of you will pay ${sender.name} back.`);
      return;
    }
    await this.say(ctx, "There's no booking to pay for yet.");
  }

  private async approve(ctx: ChatContext, trip: TripState, sender: Sender): Promise<void> {
    if (trip.phase !== "collecting") return;
    if (sender.key === trip.payerKey) {
      await this.say(ctx, `${sender.name}, you're the payer, so there's nothing for you to send.`);
      return;
    }
    if (!(sender.key in trip.shares)) {
      await this.say(ctx, `${sender.name}, you don't have a share on this booking.`);
      return;
    }
    // Approvals only count from the member's own handle: sender.key comes
    // from the roster match on the sending phone/email, never from the text.
    trip.approvals[sender.key] = true;
    await this.save(trip);
    const owed = Object.keys(trip.shares);
    const waiting = owed.filter((k) => !trip.approvals[k]);
    if (waiting.length > 0) {
      await this.say(ctx, `Thanks ${sender.name}. ${owed.length - waiting.length} of ${owed.length} approved, waiting on ${waiting.join(", ")}.`);
      return;
    }
    await this.runTransfers(ctx, trip);
  }

  private async runTransfers(ctx: ChatContext, trip: TripState): Promise<void> {
    const bank = this.bank;
    const payer = trip.payerKey ? findMemberByName(this.roster, trip.payerKey) : undefined;
    if (!bank || !payer) {
      await this.say(ctx, "I couldn't find the payer's bank account, so I didn't move any money.");
      return;
    }
    try {
      await ctx.space.responding(async () => {
        const lines: string[] = [];
        const payerBefore = await bank.balance(payer);
        for (const [key, amount] of Object.entries(trip.shares)) {
          if (trip.transfers[key]) continue;
          const member = findMemberByName(this.roster, key);
          if (!member) throw new Error(`no roster entry for ${key}`);
          const before = await bank.balance(member);
          await bank.move(member, payer, amount, `${trip.planId}:${key}`, `${config.AGENT_NAME}: ${key} to ${payer.name}`);
          trip.transfers[key] = { at: new Date().toISOString() };
          await this.save(trip);
          lines.push(`${key} sent ${usd(amount)} (${usd(before)} → ${usd(await bank.balance(member))})`);
        }
        trip.phase = "paid";
        await this.save(trip);
        await this.say(
          ctx,
          [
            `Done! Shares moved through Capital One${bank.name === "mock" ? " (mock bank)" : " Nessie"}:`,
            ...lines,
            `${payer.name}: ${usd(payerBefore)} → ${usd(await bank.balance(payer))}`,
            "Have a great trip!",
          ].join("\n"),
        );
      });
    } catch (err) {
      log.error("transfers_failed", err, { chatId: ctx.chatId });
      await this.say(ctx, `A transfer to ${payer.name} failed partway. Nothing is sent twice, so anyone can reply "approve" to retry the rest.`);
    }
  }

  private async ask(ctx: ChatContext, question: string): Promise<void> {
    const answer = await ctx.space.responding(() => this.brain.answerQuestion(ctx.chatId, question));
    await this.say(ctx, answer);
  }
}
