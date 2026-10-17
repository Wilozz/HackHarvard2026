# Ensemble

Build apps together in a group chat. Friends text what they want in iMessage, Ensemble turns the chat into a build brief, writes the app, runs it in a sandbox and posts a live link everyone can tap. Ask for changes and a new version arrives at its own link. HackHarvard 2026.

```
iMessage group ⇄ Photon 2.0 beta ⇄ Ensemble (this repo, on a laptop)
                                    ├─ Claude: chat → build brief, brief → single-file app, errors → fix
                                    ├─ Daytona: one public sandbox per app, every version served at its own link
                                    └─ headless Chrome: opens each build like a phone, catches console errors
```

## Run it

```bash
npm install
# .env: ANTHROPIC_API_KEY, PHOTON_PROJECT_ID, PHOTON_API_KEY, DAYTONA_API_KEY, ORBIT_ALLOWED (the roster's numbers)
npm run dev
```

In the group chat:

| Text | Ensemble does |
|---|---|
| `@Ensemble make space invaders where the aliens are our teammates` | Replies with a short build brief |
| `ship it` (no mention needed while a brief is waiting) | Builds it; posts `v1 … is live: <link>` about a minute later |
| `@Ensemble make the aliens faster and add sound` | Edits the same app and posts v2 at a new link (v1 keeps working) |
| Send a photo, then `@Ensemble make a game where this is the boss` | Uses the photo in the app (it's embedded in the page) |
| Send a photo, then `@Ensemble what's in this picture?` | Describes it |
| `@Ensemble versions` | Lists every link |
| `@Ensemble cancel` | Drops a brief that hasn't been built |
| `@Ensemble help` | How it works |

## Where each sponsor's tech is used

- **Photon 2.0 beta** (`src/photon/`): the agent's iMessage line. Ensemble polls Photon for group messages, detects `@Ensemble`, and replies in the chat with briefs and links. The signup page (http://127.0.0.1:8788) starts a new group chat from the line.
- **Daytona** (`src/orbit/hosts.ts`): every app gets its own public sandbox (`public: true`, label `app=orbit`). Each version is uploaded to `v1/`, `v2/`… and served by a web server inside the sandbox; the link in the chat is the sandbox's preview URL. **Claude Code runs headless inside each sandbox** (`claude -p`, installed on first build) and writes the app there; that's the default once a Daytona key is set. `ORBIT_BUILDER=api` switches to writing the file through the Claude API instead. `npm run orbit:cleanup` deletes the sandboxes after the demo.
- **Claude** (`src/orbit/brief.ts`, `src/orbit/spec.ts`, `src/orbit/builder.ts`): Claude Opus 5.5 writes the short brief the group approves. While they read it, a second call (Claude Sonnet 5.5, `ORBIT_SPEC_MODEL`) turns the brief plus the **whole chat** into a detailed design spec (controls, numbers, palette, sound, screens, inside jokes, a pass/fail checklist), saved as `data/apps/<app>/v1/SPEC.md`. The builder works from that spec, so v1 comes out polished. `ORBIT_SPEC=false` skips it. Claude Code (in Daytona) or the Claude API then writes the whole app as one self-contained HTML file (about 45-60 s). If the post-build check finds console errors, they go back to Claude once for a fix before the link is posted.

**Photos** (`src/orbit/images.ts`): Ensemble looks at photos sent in the chat in the last hour (up to four, including ones sent before the `@Ensemble` message). It downloads them from Photon, converts iPhone HEIC to JPEG and shrinks them to 1024 px, then shows them to Claude for the brief, the spec and the build. Generated code refers to each photo by a placeholder (`ORBIT_IMAGE_1`), which is swapped for the real image afterwards, so the published page is self-contained and edits never send base64 back to Claude. Converted photos are cached in `data/images/` (gitignored).

## Safety

- Only numbers in `ORBIT_ALLOWED` (or, if empty, `members.json` and the signup groups) can request or approve builds. Matching is by the sender's phone number from Photon, never by what the message says.
- Nothing builds until someone on the roster says `ship it`.
- Chat text is untrusted input: the brief and build prompts tell Claude to ignore instructions in it, and generated apps may not make network requests or collect personal data.
- No Photon key ever goes into a sandbox. With the Claude Code builder the sandbox gets the Anthropic key, passed only to the `claude` command; with `api` it holds only the app files.
- Builds time out after `ORBIT_BUILD_TIMEOUT_S`. Every build is recorded in `data/orbit.json` (who asked, the brief, result, link, build time), and each version's HTML and screenshot is kept in `data/apps/`.

## Photon notes

Replies never send `parentMessageId` (Photon rejects threaded replies on these Spaces). Group messages can arrive under a different Space than the one that can be sent to; `PHOTON_REPLY_SPACES` and the signup-group matching handle that. Details: [docs/photon-setup.md](docs/photon-setup.md).

---

# Earlier: Tripchat

The code below this line is the earlier travel-agent version. It still runs in the terminal (`PLATFORM=terminal npm run dev`).


An AI travel agent that lives in your iMessage group chat. It remembers what the group says about a trip, proposes options everyone can afford, calls the hotel to hold the rooms, and splits the bill through Capital One. HackHarvard 2026.

```
iMessage group ⇄ Photon 2.0 beta ⇄ Tripchat
                                    ├─ memory: every message → chunks → local embeddings → Postgres + pgvector
                                    ├─ brain: Claude (claude-opus-5-5) extracts trip facts and plans options
                                    ├─ voice: Retell places the reservation call (mock by default)
                                    └─ money: Capital One Nessie moves each share to the payer (mock by default)
```

## Quick start (no accounts needed except Claude)

```bash
npm install
cp .env.example .env               # set ANTHROPIC_API_KEY
cp members.example.json members.json
npm run seed:chat                  # loads a demo day of trip talk into the terminal chat
npm run dev                        # opens the terminal chat UI
```

In the terminal chat, you play the whole group. Prefix a message with a member's name to speak as them:

```
@Tripchat plan it
[Harsh] vote 1
[Hetarth] vote 1
[wiloz] vote 1
[Matias] @Tripchat book it
[Harsh] approve
[Hetarth] approve
[wiloz] approve
```

Open http://127.0.0.1:8787 to see which chat passages each retrieval question pulled (the demo's "memory flex").

The terminal UI's first chat is `terminal:chat-1`, which is what `npm run seed:chat` fills by default. When stdin isn't a TTY, Spectrum falls back to a plain readline chat named `terminal:terminal`; seed that one with `npm run seed:chat -- terminal:terminal`.

## Going live on iMessage

iMessage runs on **Photon 2.0 beta** (the HTTP API at `api.photon.codes/v1`), not Spectrum. Mention `@Tripchat` in the group (or text it directly) and ask for a trip idea; it replies with a suggestion built from the chat's memory. The plan → vote → book → split flow still runs only in the terminal.

Memory on iMessage works like this:

- **On start**, Tripchat copies every iMessage in the Photon project into the memory database (a backfill), so it knows what was said while it was off. Already-stored messages are skipped.
- **Every new message** is saved, chunked and embedded as it arrives, and so is each of Tripchat's own replies.
- **On a mention**, Claude gets the passages the trip template retrieves from the whole history plus the latest 20 messages, in time order, instead of the entire chat.
- **`@Tripchat forget`** deletes that chat's memory and records a cutoff, so the next backfill doesn't bring it back. Photon itself still keeps the conversation.
- If the database is unreachable, Tripchat falls back to reading the chat straight from Photon, so it still answers.

1. Put `PHOTON_PROJECT_ID` (`pho_prj_...`) and `PHOTON_API_KEY` (`pho_sk_...`) in `.env`. Tripchat switches from the terminal to iMessage automatically.
2. Optionally, put everyone's phone numbers in `members.json` so replies use real names instead of "Guest 1234".
3. Set up memory (below), then `npm run dev`. It polls Photon every 2 seconds and only answers messages that arrive after it starts.

### Signup page

`npm run dev` also serves a page at http://127.0.0.1:8788 where people enter their names and phone numbers. Submitting it starts an iMessage group from the dedicated line with everyone in it and a welcome that greets them by name. Signing up the same people again returns the same chat without a second welcome.

- Names and numbers are saved in `data/groups.json` (gitignored). The agent uses it for names in replies, and to reply in the right chat when Photon files a group's incoming messages under a different Space (see [docs/photon-setup.md](docs/photon-setup.md)).
- It only listens on this machine. Set `SIGNUP_HOST=0.0.0.0` to open it to your network, but anyone who can reach it can make the line text any number. Photon also caps a dedicated line at 50 new contacts a day.
- `SIGNUP_PORT=0` turns it off.

Setup details, IDs and known issues are in [docs/photon-setup.md](docs/photon-setup.md).

### Limits to know about

- **Group chats need a dedicated line.** Shared pool lines (Free and Pro) are DM-only. Our project has a dedicated line.
- **A 202 isn't delivery.** Photon accepts a send, then delivers it later. About 20 seconds after each reply, Tripchat checks the real status and logs `photon_send_failed` with Photon's failure code if it didn't go through.
- **Plain text only.** iMessage strips Markdown, so all replies are plain text.

## Memory on Supabase

Without `DATABASE_URL`, memory lives in an embedded database in `data/pglite` on whichever laptop runs the agent. To share it and keep it across machines, use Supabase:

1. In Supabase, click **Connect** and copy the **Session pooler** string (host `aws-…pooler.supabase.com`, user `postgres.<project-ref>`). The Direct connection (`db.<ref>.supabase.co`) is IPv6-only and fails on most Wi-Fi.
2. Put it in `.env` as `DATABASE_URL`, with your database password in place of `[YOUR-PASSWORD]` (no brackets).
3. `npm run db:setup` creates everything (it's also applied on every start, and it's safe to re-run):
   - pgvector in the `extensions` schema
   - tables `messages`, `chunks`, `trips`, `ledger`, `forgotten_chats`
   - an HNSW index for vector search and a GIN index for keyword search
   - row level security on every table
4. `npm run db:selftest` stores four messages in a scratch chat, embeds and retrieves them, then deletes them. `npm run db:check` is a read-only report of tables, row counts and which chats are indexed.

Notes:

- **Row level security:** Supabase exposes the `public` schema through its Data API. With RLS on and no policies, the anon and authenticated keys can't read anything. Tripchat connects as the table owner, which RLS doesn't restrict.
- **TLS:** connections to Supabase are encrypted (Supabase also accepts plaintext, so it's turned on explicitly). The certificate chain isn't verified, because Supabase uses its own CA.
- **Embeddings:** they're computed on the agent's machine, so Supabase stores only text and vectors. Nothing is sent to an embedding API.
- **Switching databases:** nothing carries over between PGlite and Supabase. On iMessage, the startup backfill refills it from Photon.

## How it works

**Memory.** Every message is saved raw (`messages` table), then grouped into conversation chunks: a new chunk starts after a 45-minute gap or at 15 messages, overlapping the previous chunk by 3 messages. Chunks are embedded locally with `bge-small-en-v1.5` (no API key; about 35 MB downloaded on first run) and stored in pgvector. Re-indexing is deterministic, so only new or changed chunks are re-embedded.

**Planning.** `@Tripchat plan it` runs 8 template questions (availability, destination, budget, lodging, activities, constraints, logistics, commitment) plus the request itself. Each one runs a vector search and a Postgres full-text search, for exact words like dates, prices and names. Hits are widened by 2 neighboring messages and sorted chronologically, so the latest message wins when someone changes their mind. Claude extracts a structured `TripContext` (who's in, availability, budget, constraints, with source messages), then picks 2 or 3 options from `data/catalog.json`. The code, not the model, computes nights, rooms and prices, and drops any option above someone's cap. A cap is the lower of their stated budget and `BALANCE_CAP_FRACTION` of their bank balance.

**Voting.** Each option is its own message. React to it, text `vote 2`, or use the native iMessage poll. A majority of travelers, or everyone voting with a single leader, picks the winner.

**Booking.** `@Tripchat book it` calls the hotel (see [docs/voice-agent.md](docs/voice-agent.md)) and posts the outcome. Reservations are pay at property, so no card ever goes to the AI.

**Splitting.** The person who confirmed the booking pays the hotel by default (`@Tripchat I'll pay` changes it). Everyone else owes `floor(total / travelers)` in whole dollars and replies `approve`. Once all of them have approved, each share moves to the payer.

### Safety rules (enforced in code, not just the prompt)

- Bookings and transfers only happen after explicit commands in the chat. The LLM has no tools that book or move money.
- Each member approves their own share. Approvals are matched from the sender's phone number, never from what the message says.
- Chat text is passed to Claude as data inside tags, and every prompt says to ignore instructions found there.
- The agent only dials numbers on `CALL_ALLOWLIST`, and every demo hotel uses `DEMO_FRONT_DESK_PHONE`.
- Bank moves are idempotent (`ledger` has one row per transfer leg), so a retry never pays twice.
- `@Tripchat forget` deletes the chat's messages, chunks and trip state, and a later backfill won't store those messages again. On iMessage only an exact "forget" counts, since DMs need no mention.
- Memory tables have row level security on, so Supabase's public API keys can't read them.
- Logs carry ids only, never message text, phone numbers or keys.

## Capital One Nessie

Tripchat splits the bill through Capital One's Nessie sandbox (fake customers, fake money), and the live bank page shows it happening.

```bash
# NESSIE_API_KEY in .env. Everyone in members.json and in data/groups.json (the signup page) gets an account.
npm run seed:nessie            # creates a customer + checking account per person, saves ids to members.json
npm run seed:nessie -- --check # $1 withdrawal + deposit to confirm the sandbox accepts our requests
npm run reset                  # balances back to opening, trips and the activity log cleared (the demo reset)
```

People who sign up on the signup page are added to the roster automatically, with an account when a Nessie key is set. To give people different budgets, edit `startBalance` in `members.json` before seeding (or delete someone's `nessieAccountId` and reseed).

**In the chat** (iMessage mode):

| Say | Does |
|---|---|
| `@Tripchat budgets` | Shows what each person can spend (`BALANCE_CAP_FRACTION` of their balance). Trip ideas also stay inside the lowest budget. |
| `@Tripchat I'll pay $480` | You're the payer and the total is $480. Everyone else owes `floor(480 / people)`. |
| `@Tripchat total 480` | Sets or changes the total (only before anyone has paid). |
| `approve` | Sends *your* share to the payer. Works without the mention while a split is waiting. |
| `@Tripchat cancel the split` | Cancels it, if no money has moved yet. |

**Live bank page:** http://127.0.0.1:8788/nessie (same server as the signup page). One card per person with their balance (animated when it changes), who's the payer, who has paid, the group's trip budget, and a log of every approval and transfer.

**Safety rules (enforced in code):** nothing moves without that person's own `approve`, matched from their phone number and never from what the text says; a repeated `approve` can't pay twice (each transfer has a per-plan, per-person ref); a transfer needs enough balance and is capped at `MAX_TRANSFER_USD`; money only moves between the sandbox accounts of people on the roster; every step is logged.

The 2026 sandbox behaves differently from its old docs (verified Oct 17):

- Use `https://api.nessieisreal.com`. Plain `http://` is refused.
- `POST /accounts/{id}/transfers` rejects `payee_id` and `medium`, so each share is a **withdrawal** from the member plus a **deposit** to the payer. Both need `status: "completed"` (a deposit without it is rejected).
- Account `balance` never changes after creation, so Tripchat computes balance as the opening balance plus its own ledger.
- Amounts are truncated to whole dollars, so shares are whole dollars.

## Commands

| In the chat | Does |
|---|---|
| `@Tripchat plan it` | Options from what everyone said |
| `vote 2`, or react to an option | Vote (works without the mention while voting) |
| `@Tripchat book it` | Calls the hotel for the winning option |
| `@Tripchat I'll pay` | You pay the hotel; others pay you back |
| `approve` | Send your share to the payer (works without the mention while collecting) |
| `@Tripchat status` | Where the plan stands |
| `@Tripchat <question>` | Answers from chat memory, e.g. "what did Matias say about the Airbnb?" |
| `@Tripchat forget` | Deletes everything stored for this chat |

## Scripts

| | |
|---|---|
| `npm run dev` | Run the agent |
| `npm test` | Unit tests + an end-to-end flow test (no API calls) |
| `npm run typecheck` | TypeScript |
| `npm run seed:chat [-- chatId]` | Load `data/seed-chat.json` into a chat |
| `npm run seed:nessie [-- --check]` | Create Nessie accounts for members |
| `npm run reset [-- --chats \| --all]` | Clear trips and ledger (balances back to opening); `--chats` also clears messages; `--all` drops tables |
| `npm run db:setup` | Create the memory schema in `DATABASE_URL` (idempotent) |
| `npm run db:check` | Read-only report: pgvector, tables, RLS, row counts, indexed chats |
| `npm run db:selftest` | Store → embed → retrieve round trip in a scratch chat, cleaned up after |

## Configuration

See [.env.example](.env.example). Storage defaults to embedded PGlite in `data/pglite`. Set `DATABASE_URL` to use Supabase or any Postgres with pgvector.

## Layout

```
src/index.ts          Entry point: Photon on iMessage, else the Spectrum terminal chat
src/photon/           Photon 2.0 beta client, the iMessage loop (backfill, poll, store, retrieve, reply), and the signup page
src/agent/handler.ts  The trip state machine: plan → vote → book → split (terminal)
src/agent/            commands parser, Claude calls (suggest, extract, planner, answer)
src/memory/           chunking, local embeddings, ingestion, retrieval
src/bank/             Nessie client and mock bank, both on a local ledger
src/voice/            Retell and mock reservation calls
src/trip/             trip state, hotel catalog, pricing and split math
data/                 demo hotel catalog and seed chat
```
