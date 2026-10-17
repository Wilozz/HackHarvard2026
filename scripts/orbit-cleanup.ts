// Delete every Daytona sandbox Orbit created (label app=orbit). Run after the demo.
//   npm run orbit:cleanup
import { config } from "../src/config";
import { DaytonaHost } from "../src/orbit/hosts";

if (!config.DAYTONA_API_KEY) {
  console.error("Set DAYTONA_API_KEY in .env first.");
  process.exit(1);
}
const deleted = await new DaytonaHost().deleteAll();
console.log(`Deleted ${deleted} Ensemble sandbox${deleted === 1 ? "" : "es"}.`);
process.exit(0);
