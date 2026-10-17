// Reset the demo. Usage:
//   npm run reset                 → clear trip plans, votes and bank ledger (balances back to opening)
//   npm run reset -- --chats      → also delete every stored message and chunk ("forget" cutoffs are kept,
//                                   so a backfill still won't restore forgotten chats)
//   npm run reset -- --all        → drop every table, cutoffs included (needed after changing the embedding model)
import { getDb, TABLES } from "../src/db";

const all = process.argv.includes("--all");
const chats = process.argv.includes("--chats");

const db = await getDb();
if (all) {
  await db.exec(TABLES.map((t) => `drop table if exists ${t};`).join("\n"));
  console.log("Dropped all tables. They are recreated on next start.");
} else {
  await db.exec(`delete from trips; delete from ledger;`);
  if (chats) await db.exec(`delete from chunks; delete from messages;`);
  console.log(`Cleared trips and ledger${chats ? ", messages and chunks" : ""}.`);
}
await db.close();
process.exit(0);
