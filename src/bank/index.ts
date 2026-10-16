import { config } from "../config";
import { getDb } from "../db";
import type { Member } from "../members";
import { NessieClient } from "./nessie";

export interface Bank {
  readonly name: "nessie" | "mock";
  /** Opening balance plus every adjustment this app recorded. */
  balance(member: Member): Promise<number>;
  /**
   * Move whole dollars from one member to another. `ref` makes it idempotent:
   * the same ref never moves money twice, so a crashed run can be retried.
   */
  move(from: Member, to: Member, amountUsd: number, ref: string, description: string): Promise<void>;
}

async function ledgerSum(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ total: string | number | null }>(
    `select coalesce(sum(delta), 0) as total from ledger where account_id = $1`,
    [accountId],
  );
  return Number(rows[0]?.total ?? 0);
}

async function ledgerHas(accountId: string, ref: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query(`select 1 from ledger where account_id = $1 and ref = $2`, [accountId, ref]);
  return rows.length > 0;
}

async function ledgerAdd(accountId: string, delta: number, ref: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `insert into ledger (account_id, delta, ref) values ($1, $2, $3) on conflict (account_id, ref) do nothing`,
    [accountId, delta, ref],
  );
}

function wholeDollars(amountUsd: number): number {
  if (!Number.isInteger(amountUsd) || amountUsd <= 0) throw new Error("amount must be a positive whole number of dollars");
  return amountUsd;
}

function accountOf(member: Member): string {
  if (!member.nessieAccountId) throw new Error(`${member.name} has no nessieAccountId (run npm run seed:nessie)`);
  return member.nessieAccountId;
}

class NessieBank implements Bank {
  readonly name = "nessie";
  private readonly opening = new Map<string, number>();

  constructor(private readonly client: NessieClient) {}

  async balance(member: Member): Promise<number> {
    const id = accountOf(member);
    let opening = this.opening.get(id);
    if (opening === undefined) {
      opening = (await this.client.getAccount(id)).balance;
      this.opening.set(id, opening);
    }
    return opening + (await ledgerSum(id));
  }

  async move(from: Member, to: Member, amountUsd: number, ref: string, description: string): Promise<void> {
    const amount = wholeDollars(amountUsd);
    const fromId = accountOf(from);
    const toId = accountOf(to);
    // Each leg is recorded as soon as Nessie accepts it, so a retry after a
    // failure between the two legs only sends the missing one.
    if (!(await ledgerHas(fromId, `${ref}:out`))) {
      await this.client.withdraw(fromId, amount, description);
      await ledgerAdd(fromId, -amount, `${ref}:out`);
    }
    if (!(await ledgerHas(toId, `${ref}:in`))) {
      await this.client.deposit(toId, amount, description);
      await ledgerAdd(toId, amount, `${ref}:in`);
    }
  }
}

class MockBank implements Bank {
  readonly name = "mock";

  private key(member: Member): string {
    return `mock:${member.name.toLowerCase()}`;
  }

  async balance(member: Member): Promise<number> {
    return member.startBalance + (await ledgerSum(this.key(member)));
  }

  async move(from: Member, to: Member, amountUsd: number, ref: string): Promise<void> {
    const amount = wholeDollars(amountUsd);
    await ledgerAdd(this.key(from), -amount, `${ref}:out`);
    await ledgerAdd(this.key(to), amount, `${ref}:in`);
  }
}

let bank: Bank | undefined;

export function getBank(): Bank {
  bank ??= config.NESSIE_API_KEY
    ? new NessieBank(new NessieClient(config.NESSIE_BASE_URL, config.NESSIE_API_KEY))
    : new MockBank();
  return bank;
}
