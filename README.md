# Tripchat

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

iMessage runs on **Photon 2.0 beta** (the HTTP API at `api.photon.codes/v1`), not Spectrum. For now it does one thing: mention `@Tripchat` in the group (or text it directly) and ask for a trip idea, and it reads the whole chat and replies with a suggestion. There's no retrieval yet; every mention re-reads the full chat from Photon. The plan → vote → book → split flow still runs only in the terminal.

1. Put `PHOTON_PROJECT_ID` (`pho_prj_...`) and `PHOTON_API_KEY` (`pho_sk_...`) in `.env`. Tripchat switches from the terminal to iMessage automatically.
2. Optionally, put everyone's phone numbers in `members.json` so replies use real names instead of "Guest 1234".
3. `npm run dev`. It polls Photon every 2 seconds and only answers messages that arrive after it starts.

### Signup page

`npm run dev` also serves a page at http://127.0.0.1:8788 where people enter their names and phone numbers. Submitting it starts an iMessage group from the dedicated line with everyone in it and a welcome that greets them by name. Signing up the same people again returns the same chat without a second welcome.

- Names and numbers are saved in `data/groups.json` (gitignored). The agent uses it for names in replies, and to reply in the right chat when Photon files a group's incoming messages under a different Space (see [docs/photon-setup.md](docs/photon-setup.md)).
- It only listens on this machine. Set `SIGNUP_HOST=0.0.0.0` to open it to your network, but anyone who can reach it can make the line text any number. Photon also caps a dedicated line at 50 new contacts a day.
- `SIGNUP_PORT=0` turns it off.

The page is a React app in `web/` (Vite, Tailwind 4, shadcn components in `web/src/components/ui`). The phone field is `reui-phone-input` with a searchable country picker.

```bash
npm run web:install   # once
npm run web:build     # writes web/dist; the signup server then serves it at /
npm run web:dev       # hot-reload page at http://localhost:5173, forwards /api to the signup server on 8788
```

Without a build, the server falls back to the plain HTML page in `src/photon/signup-page.ts`.

Setup details, IDs and known issues are in [docs/photon-setup.md](docs/photon-setup.md).

### Limits to know about

- **Group chats need a dedicated line.** Shared pool lines (Free and Pro) are DM-only. Our project has a dedicated line.
- **A 202 isn't delivery.** Photon accepts a send, then delivers it later. About 20 seconds after each reply, Tripchat checks the real status and logs `photon_send_failed` with Photon's failure code if it didn't go through.
- **Plain text only.** iMessage strips Markdown, so all replies are plain text.

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
- `@Tripchat forget` deletes the chat's messages, chunks and trip state.
- Logs carry ids only, never message text, phone numbers or keys.

## Capital One Nessie

```bash
# NESSIE_API_KEY in .env, members.json filled in
npm run seed:nessie            # creates a customer + checking account per member, saves ids to members.json
npm run seed:nessie -- --check # $1 round trip to confirm the sandbox accepts our requests
```

The 2026 sandbox behaves differently from its old docs (its docs pages return 403):

- `POST /accounts/{id}/transfers` rejects `payee_id` and `medium`, so each share is a **withdrawal** from the member plus a **deposit** to the payer.
- Account `balance` never changes after creation, so Tripchat computes balance as the opening balance plus its own ledger.
- Amounts are truncated to whole dollars, so shares are whole dollars.

Run the `--check` early on Friday. If the shapes differ, fix `src/bank/nessie.ts`.

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

## Configuration

See [.env.example](.env.example). Storage defaults to embedded PGlite in `data/pglite`. Set `DATABASE_URL` to use Supabase or any Postgres with pgvector.

## Layout

```
src/index.ts          Entry point: Photon on iMessage, else the Spectrum terminal chat
src/photon/           Photon 2.0 beta client, the iMessage loop (poll, mention, full-chat suggestion), and the signup page
src/agent/handler.ts  The trip state machine: plan → vote → book → split (terminal)
src/agent/            commands parser, Claude calls (suggest, extract, planner, answer)
src/memory/           chunking, local embeddings, ingestion, retrieval
src/bank/             Nessie client and mock bank, both on a local ledger
src/voice/            Retell and mock reservation calls
src/trip/             trip state, hotel catalog, pricing and split math
data/                 demo hotel catalog and seed chat
```
