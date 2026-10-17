import { config } from "../config";
import { log } from "../log";
import { findMemberByHandle, saveRoster, type Member } from "../members";
import type { Group } from "../photon/groups";
import { NessieClient } from "./nessie";

/**
 * Add everyone from the signup groups to the roster, matched by phone number
 * (newest group's name wins for new people; existing entries are kept as
 * they are). Mutates `roster` in place so the running agent sees the change.
 * Returns how many people were added.
 */
export function mergeGroupMembers(roster: Member[], groups: readonly Group[]): number {
  let added = 0;
  // Oldest first, so the first name someone signed up with sticks.
  for (const group of [...groups].reverse()) {
    for (const person of group.members) {
      if (findMemberByHandle(roster, person.handle)) continue;
      const taken = roster.some((m) => m.name.toLowerCase() === person.name.toLowerCase());
      roster.push({
        name: taken ? `${person.name} ${person.handle.slice(-4)}` : person.name,
        handles: [person.handle],
        startBalance: config.NESSIE_START_BALANCE,
      });
      added++;
    }
  }
  return added;
}

/** Create a Nessie sandbox customer and checking account for every member who lacks one. Returns how many were created. */
export async function ensureNessieAccounts(roster: Member[], client: NessieClient): Promise<number> {
  let created = 0;
  for (const m of roster) {
    if (m.nessieAccountId) continue;
    const [first, ...rest] = m.name.split(" ");
    m.nessieCustomerId ??= await client.createCustomer(first ?? m.name, rest.join(" ") || "Tripchat");
    m.nessieAccountId = await client.createAccount(m.nessieCustomerId, `${m.name} checking`, m.startBalance);
    saveRoster(roster); // after each one, so a failure halfway never loses an account we already made
    created++;
    log.info("nessie_account_created", { member: m.name });
  }
  return created;
}

/** Bring the roster in line with the signup groups, and give new people accounts when a Nessie key is set. */
export async function syncBankRoster(roster: Member[], groups: readonly Group[]): Promise<void> {
  const added = mergeGroupMembers(roster, groups);
  if (added > 0) saveRoster(roster);
  if (config.NESSIE_API_KEY) {
    await ensureNessieAccounts(roster, new NessieClient(config.NESSIE_BASE_URL, config.NESSIE_API_KEY));
  }
  if (added > 0) log.info("bank_roster_synced", { added, members: roster.length });
}
