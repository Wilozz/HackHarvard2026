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

## Our Vision

Ensemble reimagines collaborative software development by bringing AI-powered coding directly into the conversations where ideas originate.

Instead of treating AI as an individual developer's assistant, Ensemble introduces a shared coding agent that understands the entire team, maintains project context, and turns collective decisions into working software.

## Built At

**HackHarvard 2026**

Built with Photon, Anthropic Claude, Daytona, Supabase, and GitHub.

---

**ensemble. — The group chat that builds.**
