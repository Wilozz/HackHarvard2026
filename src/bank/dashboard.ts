import { config } from "../config";
import { getDb } from "../db";
import { log } from "../log";
import type { Member } from "../members";
import type { TripState } from "../trip/state";
import { listActivity, type Activity } from "./activity";
import type { Bank } from "./index";

export interface DashboardMember {
  name: string;
  /** Masked: never the full account id. */
  account: string;
  /** Null when the bank couldn't be reached for this person. */
  balance: number | null;
  /** What they can spend on a trip: a share of their balance. */
  cap: number | null;
  isPayer: boolean;
  /** Their share of the active split, or null if they're not in one (or they're the payer). */
  share: number | null;
  sent: boolean;
  /** Whether their balance covers their share. */
  canAfford: boolean | null;
}

export interface DashboardSplit {
  payer: string;
  total: number;
  perPerson: number;
  phase: "collecting" | "paid";
  sent: number;
  of: number;
}

export interface NessieSnapshot {
  at: string;
  bank: Bank["name"];
  capFraction: number;
  members: DashboardMember[];
  split: DashboardSplit | null;
  /** What everyone can afford, limited by the person with the smallest cap. */
  budget: { perPerson: number; group: number; limitedBy: string } | null;
  /** Newest first. */
  activity: Activity[];
}

export interface Dashboard {
  snapshot(): Promise<NessieSnapshot>;
}

const CACHE_MS = 600;

async function latestSplit(): Promise<TripState | undefined> {
  const db = await getDb();
  const rows = await db.query<{ state: TripState | string }>(
    `select state from trips where state->>'phase' in ('collecting', 'paid') and state->>'payerKey' is not null
     order by updated_at desc limit 1`,
  );
  const raw = rows[0]?.state;
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? (JSON.parse(raw) as TripState) : raw;
}

const maskAccount = (member: Member, bank: Bank): string =>
  bank.name === "mock" ? "Demo account" : member.nessieAccountId ? `•••• ${member.nessieAccountId.slice(-4)}` : "No account yet";

/** What the /nessie page shows: balances, the active split, budgets and the activity log, read from the same bank the agent moves money with. */
export function createDashboard(roster: Member[], bank: Bank): Dashboard {
  let cached: { at: number; value: Promise<NessieSnapshot> } | undefined;

  async function build(): Promise<NessieSnapshot> {
    const trip = await latestSplit();
    const members: DashboardMember[] = await Promise.all(
      roster.map(async (m) => {
        let balance: number | null = null;
        try {
          balance = await bank.balance(m);
        } catch (err) {
          log.error("dashboard_balance_failed", err, { member: m.name });
        }
        const share = trip?.shares[m.name] ?? null;
        return {
          name: m.name,
          account: maskAccount(m, bank),
          balance,
          cap: balance === null ? null : Math.floor(balance * config.BALANCE_CAP_FRACTION),
          isPayer: trip?.payerKey === m.name,
          share,
          sent: !!trip?.transfers[m.name],
          canAfford: share === null || balance === null ? null : balance >= share || !!trip?.transfers[m.name],
        };
      }),
    );

    const owing = Object.keys(trip?.shares ?? {});
    const split: DashboardSplit | null =
      trip?.payerKey && (trip.phase === "collecting" || trip.phase === "paid")
        ? {
            payer: trip.payerKey,
            total: trip.splitTotalUsd ?? 0,
            perPerson: owing.length > 0 ? trip.shares[owing[0]!]! : 0,
            phase: trip.phase,
            sent: owing.filter((k) => trip.transfers[k]).length,
            of: owing.length,
          }
        : null;

    const capped = members.filter((m): m is DashboardMember & { cap: number } => m.cap !== null);
    const lowest = capped.length > 0 ? capped.reduce((a, b) => (b.cap < a.cap ? b : a)) : undefined;
    return {
      at: new Date().toISOString(),
      bank: bank.name,
      capFraction: config.BALANCE_CAP_FRACTION,
      members,
      split,
      budget: lowest ? { perPerson: lowest.cap, group: lowest.cap * capped.length, limitedBy: lowest.name } : null,
      activity: await listActivity(60),
    };
  }

  return {
    // Every browser polls every second; share one read between them.
    snapshot() {
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        const value = build();
        cached = { at: Date.now(), value };
        value.catch(() => {
          if (cached?.value === value) cached = undefined;
        });
      }
      return cached.value;
    },
  };
}
