---
name: chat-adapter-imessage
description: >
  Connect Vercel's Chat SDK (the `chat` package) to iMessage with chat-adapter-imessage, Photon's community adapter
  built on spectrum-ts. Cloud mode (Spectrum Cloud), self-hosted mode (your own @photon-ai/advanced-imessage gRPC
  server), and local mode (on a Mac). Covers createiMessageAdapter, Chat config, onNewMention, thread.post,
  webhooks, startGatewayListener, modals as polls, tapbacks, and limitations.
  Keywords: vercel chat sdk, chat-sdk.dev, imessage, chat adapter, ai agent, chatbot, messaging, apple messages,
  nextjs, spectrum-ts, webhooks, macos.
license: MIT
metadata:
  author: photon-hq
  version: '1.0.0-local.1'
  note: >
    Rewritten locally from the published chat-adapter-imessage 1.1.0 README (npm, 2026-06-25). The upstream
    skill text described the pre-1.0 adapter (imessage-kit + advanced-imessage-kit, `new Chat({ adapter })`,
    `chat.on('message')`, webhooks unsupported), which no longer matches the shipped package.
---

# Chat SDK: iMessage Adapter

Contract pinned here: `chat-adapter-imessage` 1.1.0, peer `chat` ^4.14.0, built on `spectrum-ts`.

`chat` is Vercel's **Chat SDK** ([chat-sdk.dev](https://chat-sdk.dev/docs)), a multi-platform bot toolkit with adapters for Slack, Teams, Discord, WhatsApp and others. It is not the Vercel AI SDK (`ai`); use the AI SDK inside your handlers if you want LLM calls.

When this file and the installed package disagree, follow the package's own README and types.

## Install

```bash
pnpm add chat chat-adapter-imessage
```

No direct `@photon-ai/imessage-kit` or `@photon-ai/advanced-imessage-kit` install. The adapter depends on `spectrum-ts`.

## Modes

| Mode | When | Config / env |
|---|---|---|
| **Cloud** (recommended) | Spectrum Cloud, runs anywhere | `local: false`, `projectId`, `projectSecret` / `IMESSAGE_LOCAL=false`, `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET` |
| **Self-hosted** | Your own `@photon-ai/advanced-imessage` gRPC server | `local: false`, `serverUrl` (gRPC `host:port`, **not** `https://`), `apiKey` / `IMESSAGE_SERVER_URL`, `IMESSAGE_API_KEY`; optional `clients: [{ address, token, phone }]` for several numbers |
| **Local** | On a Mac with Messages signed in and Full Disk Access | `local: true` (the default when no remote credentials are present) |

Mode is auto-detected from environment variables when options are omitted.

## Setup

```typescript
import { Chat } from "chat";
import { createiMessageAdapter } from "chat-adapter-imessage";

export const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({
      local: false,
      projectId: process.env.IMESSAGE_PROJECT_ID,
      projectSecret: process.env.IMESSAGE_PROJECT_SECRET,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello from iMessage!");
});
```

Note `adapters` (an object keyed by platform name), not `adapter`. The underlying `SpectrumInstance` is `bot.adapters.imessage.app` (null until initialized).

### Options

| Option | Required | Notes |
|---|---|---|
| `local` | No | Defaults to local unless `local: false`, `IMESSAGE_LOCAL=false`, or remote credentials are provided |
| `projectId` / `projectSecret` | Cloud | `IMESSAGE_PROJECT_ID` / `IMESSAGE_PROJECT_SECRET` |
| `serverUrl` / `apiKey` | Self-host | `IMESSAGE_SERVER_URL` / `IMESSAGE_API_KEY`. Bare host gets `:443`; URL schemes are stripped |
| `clients` | No | Explicit `{ address, token, phone }[]` for multi-number self-host |
| `phone` | No | Legacy self-host routing phone, default `"shared"`; `IMESSAGE_PHONE` |
| `webhookSecret` | For webhooks | `IMESSAGE_WEBHOOK_SECRET` |
| `logger` | No | Defaults to `ConsoleLogger("info")` |

## Receiving messages

Two paths:

1. **Webhooks** (cloud only, best for serverless). Register a public HTTPS endpoint in the Spectrum Cloud dashboard, set `IMESSAGE_WEBHOOK_SECRET`, and route requests to the bot. The adapter verifies the `X-Spectrum-Signature` HMAC and rejects unsigned, mismatched, or stale (>5 min) requests. Delivery is at-least-once: dedupe on `X-Spectrum-Webhook-Id` + `message.id` before side effects.

   ```typescript
   // app/api/imessage/webhook/route.ts
   import { after } from "next/server";
   import { bot } from "@/lib/bot";

   export async function POST(request: Request): Promise<Response> {
     return bot.webhooks.imessage(request, {
       waitUntil: (task) => after(() => task),
     });
   }
   ```

2. **Gateway listener** (all modes). `startGatewayListener(options, durationMs)` consumes the spectrum-ts message stream. On serverless, keep it alive with a cron that overlaps the duration:

   ```typescript
   // app/api/imessage/gateway/route.ts  (check `Authorization: Bearer ${CRON_SECRET}` first)
   return bot.adapters.imessage.startGatewayListener(
     { waitUntil: (task) => after(() => task) },
     600 * 1000,
   );
   ```

   ```json
   { "crons": [{ "path": "/api/imessage/gateway", "schedule": "*/9 * * * *" }] }
   ```

## Features

| Feature | Supported |
|---|---|
| Mentions | **DMs only** |
| DMs | Yes |
| File uploads | Yes (send) |
| Reactions (add) | Remote only |
| Reactions (remove) | No |
| Message editing | Remote only |
| Typing indicator | Remote only |
| Modals | Limited, remote only (mapped to iMessage polls) |
| Message history (`fetchMessages`) | **No** |
| Thread/chat info (`fetchThread`) | No |
| Cards, streaming, ephemeral | No |
| Webhooks | Yes (cloud) |

"Remote" means cloud or self-hosted.

## Modals as polls

In remote mode, `message.openModal(Modal({ ... }))` becomes a native iMessage poll: `Modal.title` is the question and the first `Select`'s options (2 to 10) are the choices. Votes fire `bot.onModalSubmit(callbackId, (event) => event.values.<selectId>)`. Only one `Select` is supported; no `TextInput`, `RadioSelect`, labels, placeholders, or vote deselection. Polls in one chat need distinct titles. Local mode throws `NotImplementedError`.

## Tapbacks

Emoji names map to tapbacks: `love`/`heart`, `like`/`thumbs_up`, `dislike`/`thumbs_down`, `laugh`, `emphasize`/`exclamation`, `question`.

## Limitations

- **Groups are session-bound.** A DM thread can be rebuilt from its address and sent to cold (including from a webhook delivery). A group has no by-id resolver: you can only post to a group received over the gateway/stream in the current session. Cold sends to an unseen group throw `NotImplementedError`.
- **No history.** spectrum-ts has no paginated history API, so `fetchMessages` throws.
- **Plain text only.** Markdown is stripped on send, keeping the text.
- **Local mode** only replies to received messages: no reactions, typing, editing, modals, history, thread info, or space creation.

## Troubleshooting

- `serverUrl is required when local is false`: provide cloud credentials or self-host URL + key.
- Self-host connection fails: `IMESSAGE_SERVER_URL` must be gRPC `host:port`, not `https://`.
- Local mode receives nothing: grant Full Disk Access and confirm Messages is signed in.

## References

- [chat-adapter-imessage on npm](https://www.npmjs.com/package/chat-adapter-imessage)
- [Adapter source](https://github.com/photon-hq/vercel-chat-adapter-imessage)
- [Chat SDK docs](https://chat-sdk.dev/docs)
- [Spectrum Cloud webhooks](https://photon.codes/docs/webhooks/overview)
