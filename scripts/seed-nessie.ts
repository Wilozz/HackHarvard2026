// Create a Nessie sandbox customer and checking account for every member in
// members.json (plus everyone from the signup page's groups) that doesn't
// have one yet, and write the ids back. Edit startBalance in members.json
// first to give people different budgets.
//   npm run seed:nessie            → create missing customers/accounts
//   npm run seed:nessie -- --check → also run a $1 round trip between the first
//                                    two members to confirm the sandbox accepts
//                                    our withdrawal/deposit shape
import { config } from "../src/config";
import { NessieClient } from "../src/bank/nessie";
import { mergeGroupMembers } from "../src/bank/roster";
import { loadRoster, saveRoster } from "../src/members";
import { GroupRegistry } from "../src/photon/groups";

if (!config.NESSIE_API_KEY) {
  console.error("Set NESSIE_API_KEY in .env first (get one at https://api.nessieisreal.com).");
  process.exit(1);
}
const client = new NessieClient(config.NESSIE_BASE_URL, config.NESSIE_API_KEY);
const roster = loadRoster();
// Everyone who signed up through the signup page is a member too.
const added = mergeGroupMembers(roster, new GroupRegistry(config.GROUPS_FILE).list());
if (added > 0) saveRoster(roster);
if (roster.length === 0) {
  console.error(`No members in ${config.MEMBERS_FILE} or ${config.GROUPS_FILE}. Sign people up on the signup page, or copy members.example.json to members.json.`);
  process.exit(1);
}

for (const m of roster) {
  if (m.nessieAccountId) {
    const account = await client.getAccount(m.nessieAccountId);
    console.log(`${m.name}: account ${account._id}, opening balance $${account.balance}`);
    continue;
  }
  const [first, ...rest] = m.name.split(" ");
  m.nessieCustomerId ??= await client.createCustomer(first ?? m.name, rest.join(" ") || "Tripchat");
  m.nessieAccountId = await client.createAccount(m.nessieCustomerId, `${m.name} checking`, m.startBalance);
  saveRoster(roster);
  console.log(`${m.name}: created account ${m.nessieAccountId} with $${m.startBalance}`);
}

if (process.argv.includes("--check")) {
  const [a, b] = roster;
  if (!a?.nessieAccountId || !b?.nessieAccountId) {
    console.error("--check needs at least two members with accounts.");
    process.exit(1);
  }
  const w = await client.withdraw(a.nessieAccountId, 1, "Tripchat connectivity check");
  const d = await client.deposit(b.nessieAccountId, 1, "Tripchat connectivity check");
  const after = await client.getAccount(a.nessieAccountId);
  console.log(`Withdrawal ${w} and deposit ${d} accepted. ${a.name}'s balance field now reads $${after.balance}.`);
  console.log("(If it didn't change, that's the known sandbox behavior; Tripchat tracks balances in its ledger.)");
}
process.exit(0);
