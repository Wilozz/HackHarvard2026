import { getDb } from "../db";
import type { SlotDebug } from "../memory/retrieve";

export type Phase =
  | "idle" // nothing in progress
  | "voting" // options posted, waiting for votes
  | "confirming" // winner chosen, waiting for "book it"
  | "calling" // reservation call in progress
  | "collecting" // booked, waiting for each member's approval
  | "paid"; // shares moved to the payer

export interface MemberFacts {
  name: string;
  status: "in" | "out" | "maybe" | "unknown";
  available: string[];
  unavailable: string[];
  budget_max_usd: number | null;
  wants: string[];
  constraints: string[];
  traveling_from: string | null;
  sources: string[];
}

export interface TripContext {
  members: MemberFacts[];
  destination_candidates: string[];
  ruled_out: string[];
  lodging_pref: string | null;
  open_questions: string[];
}

export interface PlanOption {
  title: string;
  hotelId: string;
  hotelName: string;
  city: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  guests: string[];
  totalUsd: number;
  perPersonUsd: number;
  rationale: string;
  /** Message ids the rationale cites. */
  sources: string[];
}

export interface Booking {
  option: number;
  status: "calling" | "booked" | "failed" | "needs_input";
  confirmation?: string;
  totalUsd?: number;
  summary?: string;
}

export interface TripState {
  chatId: string;
  introduced: boolean;
  phase: Phase;
  /** New for every plan; scopes bank transfer refs so they never collide across trips. */
  planId?: string;
  context?: TripContext;
  options: PlanOption[];
  /** Outbound option message id → option index, for reaction votes. */
  optionMessages: Record<string, number>;
  /** Voter key (member name or handle) → option index. */
  votes: Record<string, number>;
  chosen?: number;
  booking?: Booking;
  /** Whole-dollar total to split when there's no hotel booking behind it (iMessage "I'll pay $480"). */
  splitTotalUsd?: number;
  payerKey?: string;
  /** Member key → whole dollars owed to the payer. */
  shares: Record<string, number>;
  approvals: Record<string, boolean>;
  /** Member key → when their share finished moving. The bank's ledger refs keep retries idempotent. */
  transfers: Record<string, { at: string }>;
  lastRetrieval?: SlotDebug[];
}

export function newTrip(chatId: string): TripState {
  return {
    chatId,
    introduced: false,
    phase: "idle",
    options: [],
    optionMessages: {},
    votes: {},
    shares: {},
    approvals: {},
    transfers: {},
  };
}

export async function loadTrip(chatId: string): Promise<TripState | undefined> {
  const db = await getDb();
  const rows = await db.query<{ state: TripState | string }>(`select state from trips where chat_id = $1`, [chatId]);
  const raw = rows[0]?.state;
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? (JSON.parse(raw) as TripState) : raw;
}

export async function saveTrip(trip: TripState): Promise<void> {
  const db = await getDb();
  await db.query(
    `insert into trips (chat_id, state, updated_at) values ($1, $2::jsonb, now())
     on conflict (chat_id) do update set state = excluded.state, updated_at = now()`,
    [trip.chatId, JSON.stringify(trip)],
  );
}

/** Drop the current plan and everything downstream of it. */
export function resetPlan(trip: TripState): void {
  trip.phase = "idle";
  trip.options = [];
  trip.optionMessages = {};
  trip.votes = {};
  delete trip.chosen;
  delete trip.booking;
  delete trip.splitTotalUsd;
  delete trip.payerKey;
  trip.shares = {};
  trip.approvals = {};
  trip.transfers = {};
}
