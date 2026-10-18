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
    // Signup page that starts a group chat (iMessage mode). 0 disables it.
    // Anyone who can reach it can make the line text any number, so it only
    // listens on this machine unless SIGNUP_HOST says otherwise.
    SIGNUP_PORT: z.coerce.number().int().min(0).default(8788),
    SIGNUP_HOST: z.string().default("127.0.0.1"),
    // Groups started from the signup page: names and phone numbers, gitignored.
    GROUPS_FILE: z.string().default("data/groups.json"),
    PLATFORM: z.enum(["auto", "imessage", "terminal"]).default("auto"),

    // Claude. The SDK itself reads ANTHROPIC_API_KEY (or an `ant auth login` profile).
    CLAUDE_MODEL: z.string().default("claude-opus-5-5"),

    // Storage. Unset → embedded Postgres (PGlite + pgvector) under data/pglite.
    DATABASE_URL: optional,
    PGLITE_DIR: z.string().default("./data/pglite"),

    // Unset → mock bank with balances from members.json.
    NESSIE_API_KEY: optional,
    // Opening balance for members who join through the signup page (members.json can override per person).
    NESSIE_START_BALANCE: z.coerce.number().int().min(0).default(1500),
    // No single transfer may exceed this many whole dollars.
    MAX_TRANSFER_USD: z.coerce.number().int().min(1).default(1000),
    NESSIE_BASE_URL: z.string().default("https://api.nessieisreal.com"),

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

    AGENT_NAME: z.string().default("Ensemble"),

    // Ensemble (code name Orbit): build apps from the group chat.
    // Where apps run: "daytona" (public preview links; needs DAYTONA_API_KEY) or "local" (served by this machine, for testing).
    ORBIT_HOST: z.enum(["auto", "daytona", "local"]).default("auto"),
    DAYTONA_API_KEY: optional,
    DAYTONA_API_URL: optional,
    // How Claude writes the app: "api" (Claude writes the file from this machine) or "claude-code" (Claude Code runs inside the sandbox).
    // How apps get written. "api" (default): one streamed Claude call, about 50 s. "claude-code": Claude Code
    // works step by step inside the Daytona sandbox, which is several times slower for a single-file app.
    // Repo mode always uses Claude Code in Daytona.
    ORBIT_BUILDER: z.enum(["auto", "api", "claude-code"]).default("api"),
    ORBIT_BUILD_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    // The design step that turns the whole chat into a detailed spec before a new app is built.
    ORBIT_SPEC: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    ORBIT_SPEC_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
    // Models: the "interpreter" (brief, repo planner, design spec) and the builder (Claude Code in Daytona, the API builder, error fixes).
    ORBIT_BRIEF_MODEL: z.string().default("claude-haiku-5-5"),
    ORBIT_SPEC_MODEL: z.string().default("claude-haiku-5-5"),
    ORBIT_CODE_MODEL: z.string().default("claude-sonnet-5-5"),
    // Comma-separated phone numbers allowed to start builds. Empty → everyone in members.json and the signup groups.
    ORBIT_ALLOWED: optional,
    // Edits (v2, v3…) build right away; set true to make them wait for "ship it" too.
    ORBIT_CONFIRM_EDITS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    // Longest a build may take before it's abandoned, in seconds.
    ORBIT_BUILD_TIMEOUT_S: z.coerce.number().int().min(30).default(420),
    ORBIT_FILE: z.string().default("data/orbit.json"),
    // Repo mode: paste a GitHub link and Ensemble works on that repo in a Daytona sandbox.
    // A fine-grained token with Contents and Pull requests (read and write) on the repos you'll use.
    // Without one, public repos can still be cloned, read and changed, but nothing is pushed.
    GITHUB_TOKEN: optional,
    // Ensemble's own repository, for "work on your own code" / "this repository".
    ENSEMBLE_REPO: z.string().default("https://github.com/Wilozz/HackHarvard2026"),
    ORBIT_REPO_TIMEOUT_S: z.coerce.number().int().min(60).default(900),
    // Every app's HTML, one folder per version (also what the local host serves).
    ORBIT_APPS_DIR: z.string().default("data/apps"),
    // Base URL for links when ORBIT_HOST=local, e.g. http://10.0.0.5:8788 to open them on a phone on the same Wi-Fi.
    ORBIT_PUBLIC_URL: optional,
    // Chrome for the post-build check (console errors + screenshot). Empty → skip the check.
    CHROME_PATH: z.string().default("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
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
if (env.ORBIT_HOST === "daytona" && !env.DAYTONA_API_KEY) throw new Error("ORBIT_HOST=daytona needs DAYTONA_API_KEY");
if (env.ORBIT_BUILDER === "claude-code" && !env.DAYTONA_API_KEY) throw new Error("ORBIT_BUILDER=claude-code runs inside Daytona, so it needs DAYTONA_API_KEY");
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
  orbitHost: (env.ORBIT_HOST === "auto" ? (env.DAYTONA_API_KEY ? "daytona" : "local") : env.ORBIT_HOST) as "daytona" | "local",
  orbitLocalBase: (env.ORBIT_PUBLIC_URL ?? `http://127.0.0.1:${env.SIGNUP_PORT}`).replace(/\/+$/, ""),
  orbitBuilder: (env.ORBIT_BUILDER === "auto" ? "api" : env.ORBIT_BUILDER) as "api" | "claude-code",
  orbitAllowed: (env.ORBIT_ALLOWED ?? "").split(",").map((n) => n.trim()).filter(Boolean),
  // Embedding model and its output dimension. Changing the model means
  // changing EMBED_DIM and recreating the chunks table (npm run reset -- --all).
  embeddingModel: "Xenova/bge-small-en-v1.5",
  embedDim: 384,
} as const;
