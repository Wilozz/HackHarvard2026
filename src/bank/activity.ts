import { getDb } from "../db";
import { log } from "../log";

export type ActivityKind = "budget" | "payer" | "split" | "approval" | "transfer" | "error";

export interface Activity {
  id: number;
  at: string;
  chatId: string | null;
  kind: ActivityKind;
  actor: string | null;
  counterparty: string | null;
  amount: number | null;
  status: "ok" | "pending" | "failed";
  detail: string;
}

export interface NewActivity {
  chatId?: string;
  kind: ActivityKind;
  actor?: string;
  counterparty?: string;
  amount?: number;
  status?: Activity["status"];
  detail: string;
}

/** Append to the audit trail. Never throws: a logging failure must not block or undo a transfer. */
export async function recordActivity(a: NewActivity): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `insert into bank_activity (chat_id, kind, actor, counterparty, amount, status, detail)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [a.chatId ?? null, a.kind, a.actor ?? null, a.counterparty ?? null, a.amount ?? null, a.status ?? "ok", a.detail],
    );
  } catch (err) {
    log.error("activity_failed", err, { kind: a.kind });
  }
}

/** Newest first. */
export async function listActivity(limit = 50): Promise<Activity[]> {
  const db = await getDb();
  const rows = await db.query<{
    id: string | number;
    at: Date | string;
    chat_id: string | null;
    kind: ActivityKind;
    actor: string | null;
    counterparty: string | null;
    amount: string | number | null;
    status: Activity["status"];
    detail: string;
  }>(`select id, at, chat_id, kind, actor, counterparty, amount, status, detail from bank_activity order by id desc limit $1`, [limit]);
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    chatId: r.chat_id,
    kind: r.kind,
    actor: r.actor,
    counterparty: r.counterparty,
    amount: r.amount === null ? null : Number(r.amount),
    status: r.status,
    detail: r.detail,
  }));
}
