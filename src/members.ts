import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { config } from "./config";

// members.json maps the group's phone numbers/emails to names and bank
// accounts. It holds personal data, so it is gitignored; copy
// members.example.json to start.
const memberSchema = z.object({
  name: z.string().min(1),
  /** iMessage handles: E.164 phone numbers and/or Apple ID emails. */
  handles: z.array(z.string()).default([]),
  nessieCustomerId: z.string().optional(),
  nessieAccountId: z.string().optional(),
  /** Opening balance for seed-nessie and for the mock bank. */
  startBalance: z.number().nonnegative().default(1500),
});
const rosterSchema = z.array(memberSchema);

export type Member = z.infer<typeof memberSchema>;

export function loadRoster(): Member[] {
  if (!existsSync(config.MEMBERS_FILE)) return [];
  return rosterSchema.parse(JSON.parse(readFileSync(config.MEMBERS_FILE, "utf8")));
}

export function saveRoster(members: Member[]): void {
  writeFileSync(config.MEMBERS_FILE, `${JSON.stringify(members, null, 2)}\n`);
}

/** Compare handles loosely: emails case-insensitively, phones by their last 10 digits. */
export function sameHandle(a: string, b: string): boolean {
  if (a.includes("@") || b.includes("@")) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  return da.length >= 7 && da.slice(-10) === db.slice(-10);
}

export function findMemberByHandle(roster: Member[], handle: string | undefined): Member | undefined {
  if (!handle) return undefined;
  return roster.find((m) => m.handles.some((h) => sameHandle(h, handle)));
}

export function findMemberByName(roster: Member[], name: string): Member | undefined {
  const n = name.trim().toLowerCase();
  return roster.find((m) => m.name.toLowerCase() === n);
}

/** A display name that never exposes a full phone number or email. */
export function guestName(handle: string | undefined): string {
  if (!handle) return "Someone";
  const digits = handle.replace(/\D/g, "");
  if (!handle.includes("@") && digits.length >= 4) return `Guest ${digits.slice(-4)}`;
  return `Guest ${handle.split("@")[0]?.slice(0, 3) ?? ""}`;
}
