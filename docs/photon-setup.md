# Photon 2.0 Beta: Group Chat Setup and API Notes (ROAM)

Context for the ROAM project (HackHarvard 2026). Written Fri Oct 16, 2026; updated Sat Oct 17 with checks against the live API. Keep the API key in `.env`, never in this file or git.

## Which Photon product we are using

- **Photon 2.0 beta**, not Spectrum.
  - API host: `https://api.photon.codes/v1`
  - Project ID starts with `pho_prj_`
  - Credentials: Bearer token, project API key `pho_sk_...` (account service keys are `pho_ask_...`)
  - Clients: `@photon-ai/api` (npm), `photonhq-api` (PyPI / crates.io), plus a Go client
  - Docs: https://photon.codes/docs/beta/photon, API spec: https://api.photon.codes/openapi.json
- **Spectrum** (`spectrum-ts`, `spectrum.photon.codes`, project ID + secret with Basic auth) is the *stable* product. Its docs and CLI (`@photon-ai/cli`) do not apply to the beta. Do not mix the two; they have different contracts.
- There is no beta CLI. Use the dashboard (https://app.beta.photon.codes) or the HTTP API.

## In this repo

- `src/photon/api.ts` is a small `fetch` client for the four endpoints we use (list messages, get message, send message, typing) plus the agent lookup. It retries 429s, 5xx and network errors with the same idempotency key.
- `src/photon/agent.ts` is the iMessage loop. It polls `GET /messages?direction=received` every 2 seconds and ignores anything that arrived before it started. It answers group messages that mention `@Tripchat`, and every DM. For each one it re-reads the whole chat from Photon and asks Claude for a trip suggestion (`src/agent/suggest.ts`), then replies in the same Space (or the one `PHOTON_REPLY_SPACES` maps it to).
- `npm run dev` picks this path when `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` are set. Without them it runs the terminal chat (Spectrum, full plan/vote/book/split flow with RAG).

## Our setup

| Thing | Value |
| - | - |
| Project ID | `pho_prj_01m53s4h9eesk81ffa3fybbck4` |
| Line type | Dedicated iMessage line (needed for groups) |
| Agent (dedicated line) number | +1 628 358-7968 |
| Agent User ID | `pho_usr_0v91c0k3g8hpqtapeywhdyp0qz` |
| Real group Space ID (the one the team is texting in) | `pho_spc_5506t6kmwhgn3tk4f1xnh1sxs4` (kind `group`) |
| Group Space the agent sends to (created via API) | `pho_spc_1c8v33wrgxgy39ha7tq6an1srq`; same chat on our phones, but incoming messages land in the Space above |

### Phone numbers in use (5 in the group, including the dedicated line)

| Number (E.164) | Role | Photon User ID |
| - | - | - |
| +16283587968 | Agent (dedicated line) | `pho_usr_0v91c0k3g8hpqtapeywhdyp0qz` |
| +61452598886 | Wilson | `pho_usr_4krjnbq0nthr1bvh59dh3xpjmm` |
| +14169491126 | Teammate | `pho_usr_0nxx2m1hnfh4cvdq84vmhcw3y8` |
| +15513318011 | Teammate | `pho_usr_7d4w0b7ew1gz4stjxnvte3x02y` |
| +19058724476 | Teammate | looked up via `GET /users` (not recorded here) |

Not part of the group: `wilson.zhang7@icloud.com` and agent number +16283167976 came from the early shared-line quickstart test (a separate DM Space) and are not used. That shared-line agent is a second agent User in the project (`kind: "agent"`), so code that looks up "the" agent must not just take the first one. Tripchat replies as whichever agent is in the Space, or as `PHOTON_AGENT_USER_ID` if set.

Note: Photon's `participantIds` on the real group Space is incomplete (it listed 2 members while all 5 had posted). On each received message, the Space snapshot lists only the agent and that message's sender. Build the roster from the senders you see, or from the table above, rather than trusting `participantIds`. Do not hardcode a Space ID; reply using the `space.id` on each incoming message.

An earlier test group was created through the API with `createGroup.ts` and a welcome message ("awassup") was sent from the agent line (status `dispatched`). The team texts in that same group chat, but Photon files their messages under the separate Space above, and sends to that Space fail (see Known issues).

## Plan and line constraints (important)

- **Shared pool lines (Free / Pro) are DM-only.** They cannot create groups and do not receive group events. The quickstart says shared assignments support direct conversations, not group chats. The agent cannot send an unsolicited first message on a shared line.
- **Dedicated lines (Business, $250/line/month, $250 monthly minimum)** support group creation and inbound group events. Cold outreach is limited to 50 new contacts per line per day.
- **Voice calls** need a separate voice-capable Photon number over SIP; shared iMessage lines do not support calls. Cookbooks for ElevenLabs, Retell, LiveKit and Twilio: https://photon.codes/docs/beta/cookbooks . Voice usage is billed per minute (about $0.01 to $0.013 in US/Canada).
- The beta launched Oct 15, 2026 with $100 in free credit. iMessage, Telegram and WhatsApp sends have no per-message fee; SMS, MMS and voice do.

## Core API calls (from the OpenAPI spec)

All requests: `Authorization: Bearer $PHOTON_API_KEY`, `Content-Type: application/json`, and a unique `idempotency-key` header on every POST (reuse the same key only when retrying the same logical request). Keys are 1 to 255 printable ASCII characters.

Base: `https://api.photon.codes/v1/projects/{projectId}`

1. **Create or get a User** (an addressable identity on one platform)
   `POST /users`  body `{ "platform": "imessage", "handle": "+15551234567" }`
2. **Create or get a Space** (the conversation)
   `POST /spaces`  body `{ "platform": "imessage", "participantIds": [agentUserId, ...humanUserIds] }`
   - iMessage: 2 to 1000 participants. The first participant is the creator when a new chat is needed; the rest of the order is ignored.
   - Every Space must include a project-owned agent User, or the request fails (`SpaceRequiresOwnedAgent`).
3. **Send a message**
   `POST /messages`  body `{ "spaceId": "...", "senderId": agentUserId, "content": { "type": "text", "format": "plain", "text": "..." } }`
   - `parentMessageId` (a threaded reply) is in the spec, but Photon rejects it on our iMessage Spaces, DM and group alike: `409 SPACE_NOT_SENDABLE: Replies are not supported for this Space`. Leave it out.
   - A `202`/`dispatched` response means Photon accepted or sent it. It does not confirm delivery to the phone. `GET /messages/{id}` later shows `delivered` or `failed` (with `failure.code`).
4. **List received messages** (polling)
   `GET /messages` with query params such as `createdSince`, `direction=received`, `order=asc`, `pageSize`, `platform=imessage`, `pageToken`. Each item includes `space` (with `kind` of `direct` or `group`), `sentBy` and `receivedBy` snapshots, `content`, and `status`.
   - `createdSince` is inclusive. The default order is newest first. Omit `direction` to get both sent and received.
   - **Received group messages have no `receivedBy` and no line (`resourceId`).** So `spaceId` + `perspectiveUserId=<agent>` and `spaceId` + `resourceId` return only the agent's own sends in a group, not what humans said. To read a whole group chat, list the project's messages and filter by `space.id` yourself (that's what Tripchat does).
5. **Find the agent's own User ID**
   `GET /users?platform=imessage`, pick the item with `kind: "agent"`. Or copy it from the dashboard. (Our script found it this way.) Our project has two agents; see above.

Replying to an incoming message: reuse its `space.id` as `spaceId` (or the mapped Space; see Known issues) and the receiving agent's User ID as `senderId`. Use a stable idempotency key per incoming message (for example `reply:<incomingMessageId>`) so retries cannot double-send. Never answer the agent's own outbound messages.

## Receiving messages live

- Polling `GET /messages` every ~2 seconds works for testing. Do not poll faster; `429` means back off per the response's retry guidance.
- For the real agent use the **Socket.IO event stream** with replay cursors: https://photon.codes/docs/beta/websocket (connect, session, events, cursors). The Socket.IO `reply` command is only for webhook responses, not for sending iMessages.
- Webhook delivery (Standard Webhooks compatible) is also available. A shared line needs no public server; a laptop is enough for development.
- Run the agent as a long-lived process (laptop with a tunnel, or Railway/Render/Fly). Avoid serverless (Vercel, Cloudflare Workers) for the voice path.

## Running from the Claude sandbox (network notes)

- The sandbox proxy only allows listed domains. `api.photon.codes` had to be added under Settings > Capabilities on claude.ai before calls worked.
- Node's built-in `fetch` ignores `HTTPS_PROXY`. Run Node scripts with `NODE_USE_ENV_PROXY=1` (Node 22.21 or later) and `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`. `curl` works without changes.

## Script

`createGroup.ts` (camelCase names, not checked into this repo) creates the Users, the group Space and a welcome message:

```
export PHOTON_PROJECT_ID=pho_prj_...
export PHOTON_API_KEY=pho_sk_...
npx tsx createGroup.ts "+1555..." "+1555..." "+1555..."
```

## Known issues and open questions

- **One group chat, two Spaces.** The team's group chat on our phones is the one `createGroup.ts` made, `pho_spc_1c8v33wrgxgy39ha7tq6an1srq`. Sends to it show up on everyone's phone (they stay `dispatched`; group sends never reach `delivered`). But Photon files the messages the team sends in that chat under a different Space, `pho_spc_5506t6kmwhgn3tk4f1xnh1sxs4`, and every agent send to `5506` fails within a second with `message_failed: Photon could not complete the message.` (4 of 4 on Oct 17, 03:58 to 04:20 UTC, e.g. `pho_msg_2zsdtgswewhcfb9y6w09mnppxz`). DMs are fine.
  - **Workaround (in `.env`):** `PHOTON_REPLY_SPACES=pho_spc_5506t6kmwhgn3tk4f1xnh1sxs4:pho_spc_1c8v33wrgxgy39ha7tq6an1srq`. Tripchat then replies to `1c8v` and reads both Spaces as one chat.
  - Still worth reporting to Photon with the IDs above. If they fix the mapping, drop the setting. A new group chat would need its own pair.
- **Dashboard visibility:** single-DM messages appeared in usage and message logs but not in the Messages tab, and group messages were not visible in the dashboard logs. Treat the dashboard as incomplete; verify delivery through `GET /messages` or the WebSocket instead. If group messages never arrive via the API, escalate to Photon (Discord, support@photon.codes, or a hackathon mentor) with the project ID, line number, Space ID, timestamp and request IDs.
- **Confirmed:** inbound group messages from all five numbers reach the API (`GET /messages` shows them with `space.kind: group`). The dashboard still does not show them reliably.
- **Not yet confirmed:** whether a human can add the agent's number to an existing iMessage group through Photon's own flow (creating the group from the agent side is the documented route), and why Photon put the team's chat in a different Space than the one created via the API. The send failures above suggest the human-created group is the problem.
- **Not yet verified in code:** the voice setup (SIP number plus ElevenLabs/Retell/LiveKit/Twilio) and any hackathon-specific credit or line allowances.
- The API key was pasted into a chat during setup. Rotate it after the hackathon.
