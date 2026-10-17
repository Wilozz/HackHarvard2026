import "dotenv/config";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const env = z
  .object({
    // Photon 2.0 beta (app.beta.photon.codes → project → API keys). Both unset → terminal mode.
    PHOTON_PROJECT_ID: optional,
    PHOTON_API_KEY: optional,
    PHOTON_API_URL: z.string().default("https://api.photon.codes/v1"),
    // Reply as this agent User. Unset → whichever of the project's agents is in the Space.
    PHOTON_AGENT_USER_ID: optional,
    PHOTON_POLL_MS: z.coerce.number().int().min(1000).default(2000),
    // Photon can file a group's incoming messages under a different Space than
    // the one that sends to it. "pho_spc_IN:pho_spc_OUT,..." sends replies for
    // IN to OUT and reads both as one chat.
    PHOTON_REPLY_SPACES: optional,
    PLATFORM: z.enum(["auto", "imessage", "terminal"]).default("auto"),

    // Claude. The SDK itself reads ANTHROPIC_API_KEY (or an `ant auth login` profile).
    CLAUDE_MODEL: z.string().default("claude-opus-5-5"),

    // Storage. Unset → embedded Postgres (PGlite + pgvector) under data/pglite.
    DATABASE_URL: optional,
    PGLITE_DIR: z.string().default("./data/pglite"),

    // Unset → mock bank with balances from members.json.
    NESSIE_API_KEY: optional,
    NESSIE_BASE_URL: z.string().default("http://api.nessieisreal.com"),

    VOICE_PROVIDER: z.enum(["mock", "retell"]).default("mock"),
    RETELL_API_KEY: optional,
    RETELL_FROM_NUMBER: optional,
    RETELL_AGENT_ID: optional,
    // Every catalog hotel is dialed at this number during the demo.
    DEMO_FRONT_DESK_PHONE: optional,
    // Comma-separated E.164 numbers the agent may call. Defaults to DEMO_FRONT_DESK_PHONE only.
    CALL_ALLOWLIST: optional,
    MOCK_CALL_OUTCOME: z.enum(["booked", "needs_input", "failed"]).default("booked"),
    MOCK_CALL_DELAY_MS: z.coerce.number().int().min(0).default(5000),

    AGENT_NAME: z.string().default("Tripchat"),
    TRIP_TIMEZONE: z.string().default("America/New_York"),
    // Share of a member's bank balance the planner may assume they can spend.
    BALANCE_CAP_FRACTION: z.coerce.number().min(0).max(1).default(0.5),
    MEMBERS_FILE: z.string().default("members.json"),
    DEBUG_PORT: z.coerce.number().int().min(0).default(8787),
  })
  .parse(process.env);

function resolvePlatform(): "imessage" | "terminal" {
  if (env.PLATFORM !== "auto") return env.PLATFORM;
  return env.PHOTON_PROJECT_ID && env.PHOTON_API_KEY ? "imessage" : "terminal";
}

const platform = resolvePlatform();
if (platform === "imessage" && !(env.PHOTON_PROJECT_ID && env.PHOTON_API_KEY)) {
  throw new Error("PLATFORM=imessage needs PHOTON_PROJECT_ID and PHOTON_API_KEY");
}
if (env.VOICE_PROVIDER === "retell" && !(env.RETELL_API_KEY && env.RETELL_FROM_NUMBER && env.RETELL_AGENT_ID)) {
  throw new Error("VOICE_PROVIDER=retell needs RETELL_API_KEY, RETELL_FROM_NUMBER and RETELL_AGENT_ID");
}

const SPACE_ID = /^pho_spc_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const replySpaces = new Map<string, string>();
for (const pair of (env.PHOTON_REPLY_SPACES ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
  const [from, to, ...rest] = pair.split(":").map((s) => s.trim());
  if (!from || !to || rest.length > 0 || !SPACE_ID.test(from) || !SPACE_ID.test(to)) {
    throw new Error(`PHOTON_REPLY_SPACES: expected "pho_spc_IN:pho_spc_OUT", got "${pair}"`);
  }
  replySpaces.set(from, to);
}

const allowlist =(env.CALL_ALLOWLIST ?? env.DEMO_FRONT_DESK_PHONE ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

export const config = {
  ...env,
  platform,
  callAllowlist: allowlist,
  photonReplySpaces: replySpaces as ReadonlyMap<string, string>,
  // Embedding model and its output dimension. Changing the model means
  // changing EMBED_DIM and recreating the chunks table (npm run reset -- --all).
  embeddingModel: "Xenova/bge-small-en-v1.5",
  embedDim: 384,
} as const;
