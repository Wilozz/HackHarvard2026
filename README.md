# ensemble.

**Collaborative coding, right in your group chat.**

Ensemble is an AI-powered collaborative development agent that lives directly inside your iMessage group chat. Powered by **Photon, Anthropic Claude, and Daytona**, Ensemble turns conversations into working software, allowing teams to brainstorm, plan, build, and ship projects together without leaving their messages.

## The Problem

Software development is collaborative, but AI coding tools are largely designed for individual developers.

Project ideas often begin in group chats, where teammates brainstorm features, discuss technical decisions, and assign responsibilities. However, turning those conversations into working code requires switching between messaging platforms, development environments, and project management tools.

Important context gets lost, decisions become fragmented, and progress slows down.

## Our Solution

Ensemble brings an AI coding teammate directly into your iMessage group chat.

Rather than requiring developers to individually prompt an AI assistant, Ensemble understands the entire team's conversation and uses that shared context to coordinate development.

Through Claude's reasoning capabilities and Daytona's sandboxed development environments, Ensemble can translate group discussions into actionable coding tasks, execute code, run tests, and integrate changes with GitHub.

**Your group chat becomes your development workspace.**

## Key Features

- **Native iMessage Integration:** Collaborate with an AI agent directly inside your existing group chat using Photon 2.0.
- **Shared Context & Memory:** Understand conversations across multiple teammates and retain project requirements, decisions, and preferences.
- **Collaborative AI Coding:** Generate, modify, and debug code based on instructions from multiple participants.
- **Sandboxed Code Execution:** Use Daytona to create isolated development environments for writing, executing, and testing code.
- **GitHub Integration:** Connect development workflows to repositories, branches, commits, and pull requests.
- **Project Planning:** Convert brainstorming discussions into structured development plans and actionable tasks.
- **Iterative Development:** Request changes, provide feedback, and review implementation progress directly through iMessage.

## How It Works

1. **Connect:** Add Ensemble to your iMessage group chat through Photon.
2. **Collaborate:** Discuss ideas, features, and technical decisions naturally with your teammates.
3. **Plan:** Ask Ensemble to summarize requirements and organize development tasks.
4. **Build:** Claude interprets the team's instructions and coordinates coding tasks inside a Daytona sandbox.
5. **Execute:** Daytona provides an isolated environment to write code, install dependencies, and run tests.
6. **Integrate:** Changes can be committed to GitHub and submitted as pull requests for review.
7. **Iterate:** Ensemble shares progress in the group chat, where teammates can request improvements and continue building.

## Example Conversation

**Alex:** Let's build a website that tracks shared expenses.

**Sam:** We should use Next.js and Supabase.

**Jordan:** Make sure it's mobile responsive.

**Alex:** @Ensemble summarize our project.

**Ensemble:** We're building a mobile-responsive expense tracking application using Next.js and Supabase. I'll organize the requirements into an implementation plan.

**Sam:** @Ensemble build the initial version.

**Ensemble:** Starting a Daytona development sandbox to scaffold the application and implement the initial features.

**Ensemble:** Initial implementation complete. Tests passed, and the changes are ready for review on GitHub.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Photon 2.0** | iMessage group chat messaging and communication |
| **Anthropic Claude** | AI reasoning, planning, and code generation |
| **Daytona** | Sandboxed development environments and agent execution |
| **TypeScript / Node.js** | Backend logic, messaging, and workflow orchestration |
| **Supabase / PostgreSQL** | Conversation history, project state, and persistent storage |
| **pgvector** | Semantic search and long-term project memory |
| **GitHub API** | Repository management, branches, commits, and pull requests |

## System Architecture

```text
                  iMessage Group Chat
                          |
                      Photon 2.0
                          |
                   TypeScript Backend
                          |
              +-----------+-----------+
              |                       |
       Conversation Memory       Claude AI Agent
        (Supabase + RAG)              |
              |                    Daytona
              |                       |
              |               Isolated Sandbox
              |               - Write Code
              |               - Run Commands
              |               - Execute Tests
              |                       |
              +-----------------------+
                                      |
                                  GitHub API
                                      |
                             Commits / Pull Requests
                                      |
                               Photon Response
                                      |
                              iMessage Group Chat
```

## Technical Architecture

### 1. Messaging — Photon

Photon provides the communication layer between Ensemble and iMessage.

Incoming messages are processed by the TypeScript backend, allowing Ensemble to understand requests from different members of the group and respond within the same conversation.

### 2. Intelligence — Anthropic Claude

Claude serves as Ensemble's reasoning and development engine.

It interprets team discussions, extracts requirements, generates implementation plans, and determines which development actions to execute.

### 3. Execution — Daytona

Daytona provides isolated development environments for Ensemble's coding workflows.

Within a sandbox, the agent can:

- Clone and initialize repositories.
- Create and modify project files.
- Install dependencies.
- Execute terminal commands.
- Run builds and automated tests.
- Prepare changes for GitHub integration.

This allows Ensemble to move beyond generating code suggestions and actually implement software.

### 4. Memory — Supabase & pgvector

Ensemble stores conversation history and project context in a persistent database.

Using retrieval-augmented generation (RAG), the agent can retrieve relevant discussions, technical decisions, and requirements without requiring teammates to repeat themselves.

### 5. Version Control — GitHub

GitHub connects Ensemble's coding workflows to real repositories.

The agent can prepare branches, commits, and pull requests, allowing teammates to review changes before merging them into the project.

## Running Ensemble

The chat flow that's built today: a request in the group becomes a short brief, someone replies `ship it`, and about a minute later a link to a working app arrives. Ask for changes and v2 arrives at its own link.

### Run it

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

### Where each sponsor's tech is used

- **Photon 2.0 beta** (`src/photon/`): the agent's iMessage line. Ensemble polls Photon for group messages, detects `@Ensemble`, and replies in the chat with briefs and links. The signup page (http://127.0.0.1:8788) starts a new group chat from the line.
- **Daytona** (`src/orbit/hosts.ts`): every app gets its own public sandbox (`public: true`, label `app=orbit`). Each version is uploaded to `v1/`, `v2/`… and served by a web server inside the sandbox; the link in the chat is the sandbox's preview URL. **Claude Code runs headless inside each sandbox** (`claude -p`, installed on first build) and writes the app there; that's the default once a Daytona key is set. `ORBIT_BUILDER=api` switches to writing the file through the Claude API instead. `npm run orbit:cleanup` deletes the sandboxes after the demo.
- **Claude** (`src/orbit/brief.ts`, `src/orbit/spec.ts`, `src/orbit/builder.ts`): Claude Opus 5.5 writes the short brief the group approves. While they read it, a second call (Claude Sonnet 5.5, `ORBIT_SPEC_MODEL`) turns the brief plus the **whole chat** into a detailed design spec (controls, numbers, palette, sound, screens, inside jokes, a pass/fail checklist), saved as `data/apps/<app>/v1/SPEC.md`. The builder works from that spec, so v1 comes out polished. `ORBIT_SPEC=false` skips it. Claude Code (in Daytona) or the Claude API then writes the whole app as one self-contained HTML file (about 45-60 s). If the post-build check finds console errors, they go back to Claude once for a fix before the link is posted.

**Several apps in one chat** (`src/orbit/service.ts`, segments in `data/orbit.json`): the chat is split into stretches, each tied to the app it was about. Talk after a link goes out belongs to no app until the next request; the brief step (which sees only that open stretch plus a one-line list of every app) decides whether it's a new app or a change to an existing one, including "go back to the cat game". A new app's design spec and photos come only from its own stretch, so app 2 never re-reads app 1's discussion. Edits work from that app's own code and running summary. Each brief or spec reads at most the newest 80 messages of its stretch.

**Repo mode** (`src/orbit/repo.ts`, `src/orbit/github.ts`, `src/orbit/repoPlan.ts`): paste a GitHub link (`@Ensemble work on github.com/you/repo`) and Ensemble clones it into its own Daytona sandbox (Daytona's git API, full history), then Claude Code reads it and posts a summary. After that, messages about the repo are routed by a small Claude call:

| Text | Ensemble does |
|---|---|
| `@Ensemble add a dark mode toggle` | Posts a plan; after `ship it`, Claude Code makes the change on a new `ensemble/…` branch and runs the repo's tests, then Ensemble commits it (Claude writes the message), pushes the branch and opens a pull request |
| `@Ensemble also make it remember the choice` | Same, but on the branch already in progress (same PR) |
| `@Ensemble show the last commits` / `what changed?` / `compare our branch to main` | Claude Code answers from `git log` and `git diff` with read-only tools |
| `@Ensemble undo that` / `restore it to 1a2b3c4` | Asks for `ship it`, then reverts (or restores files) as a new commit on the branch and pushes. Without a named commit it only undoes Ensemble's own latest commit |
| `@Ensemble versions` | Lists the branches and pull requests |
| `@Ensemble we're done with the repo` | Back to building apps |

Every change request gets its own branch and PR, and one task runs at a time per chat, so teammates never overwrite each other. Ensemble never pushes to the default branch and never force-pushes. The GitHub token is only passed to Daytona's clone, pull and push calls, never to Claude Code; Claude Code gets the Anthropic key and is told the repo's files are data, not instructions.

**Photos** (`src/orbit/images.ts`): Ensemble looks at photos sent in the chat in the last hour (up to four, including ones sent before the `@Ensemble` message). It downloads them from Photon, converts iPhone HEIC to JPEG and shrinks them to 1024 px, then shows them to Claude for the brief, the spec and the build. Generated code refers to each photo by a placeholder (`ORBIT_IMAGE_1`), which is swapped for the real image afterwards, so the published page is self-contained and edits never send base64 back to Claude. Converted photos are cached in `data/images/` (gitignored).

### Safety

- Only numbers in `ORBIT_ALLOWED` (or, if empty, `members.json` and the signup groups) can request or approve builds. Matching is by the sender's phone number from Photon, never by what the message says.
- Nothing builds until someone on the roster says `ship it`.
- Chat text is untrusted input: the brief and build prompts tell Claude to ignore instructions in it, and generated apps may not make network requests or collect personal data.
- No Photon key ever goes into a sandbox. With the Claude Code builder the sandbox gets the Anthropic key, passed only to the `claude` command; with `api` it holds only the app files.
- Builds time out after `ORBIT_BUILD_TIMEOUT_S`. Every build is recorded in `data/orbit.json` (who asked, the brief, result, link, build time), and each version's HTML and screenshot is kept in `data/apps/`.

### Photon notes

Replies never send `parentMessageId` (Photon rejects threaded replies on these Spaces). Group messages can arrive under a different Space than the one that can be sent to; `PHOTON_REPLY_SPACES` and the signup-group matching handle that. Details: [docs/photon-setup.md](docs/photon-setup.md).

## Our Vision

Ensemble reimagines collaborative software development by bringing AI-powered coding directly into the conversations where ideas originate.

Instead of treating AI as an individual developer's assistant, Ensemble introduces a shared coding agent that understands the entire team, maintains project context, and turns collective decisions into working software.

## Built At

**HackHarvard 2026**

Built with Photon, Anthropic Claude, Daytona, Supabase, and GitHub.

---

**ensemble. — The group chat that builds.**
