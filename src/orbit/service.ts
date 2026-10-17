import { randomBytes } from "node:crypto";
import { config } from "../config";
import { log } from "../log";
import { findMemberByHandle, sameHandle, type Member } from "../members";
import type { GroupRegistry } from "../photon/groups";
import { writeBrief } from "./brief";
import { generateApp } from "./builder";
import { writeSpec } from "./spec";
import { findRepoUrl } from "./github";
import type { ChangeResult, RepoWorker } from "./repo";
import { writeRepoPlan } from "./repoPlan";
import { DaytonaHost, type AppHost } from "./hosts";
import { inlineImages, readCachedImage, stripImages, type ChatImage } from "./images";
import type { LlmImage } from "../agent/llm";
import { checkApp } from "./quality";
import type { OrbitChat, OrbitStore, PendingBuild, PendingRepoTask, Project, ProjectImage, Version } from "./store";

export type OrbitCommand =
  | { kind: "ship" }
  | { kind: "cancel" }
  | { kind: "versions" }
  | { kind: "help" }
  | { kind: "request"; text: string };

const SHIP = /^(?:ship it|ship|build it|do it|send it|go for it|yes,? (?:build|ship) it)[.!]*$/i;

/** A bare "ship it" (no mention) counts while a build is waiting for one. */
export function isShipIt(text: string): boolean {
  return SHIP.test(text.trim());
}

export function parseOrbitCommand(body: string): OrbitCommand {
  const t = body.trim();
  if (SHIP.test(t)) return { kind: "ship" };
  if (/^(?:cancel|never ?mind|nvm|scrap (?:it|that))[.!]*$/i.test(t)) return { kind: "cancel" };
  if (/^(?:versions|links|history|list|what have you (?:made|built))[?.!]*$/i.test(t)) return { kind: "versions" };
  if (t === "" || /^(?:help|what can you do|how does this work)[?.!]*$/i.test(t)) return { kind: "help" };
  return { kind: "request", text: t };
}

/** The steps Claude and the browser do, injectable for tests. */
export interface OrbitSteps {
  writeBrief: typeof writeBrief;
  writeSpec: typeof writeSpec;
  writeRepoPlan: typeof writeRepoPlan;
  generateApp: typeof generateApp;
  checkApp: typeof checkApp;
}

export interface OrbitTurn {
  chatId: string;
  /** Message text with the @mention removed. */
  body: string;
  askedBy: string;
  /** Photon's handle for the sender: who's allowed is decided by this, never by the text. */
  senderHandle: string;
  /** Recent chat as transcript lines, fetched only when a brief needs it. */
  transcript: () => Promise<string>;
  /** The whole chat, oldest first, for the design spec. */
  fullTranscript: () => Promise<string>;
  /** Photos sent in the chat recently (downloaded and converted to JPEG). */
  images: () => Promise<ChatImage[]>;
  /** Post a message in the chat. `key` makes the send idempotent. */
  say: (text: string, key: string) => Promise<void>;
}

/** At most n characters, cut at a word boundary. Only for internal text and error notes; replies to people are sent whole. */
const short = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > n / 2 ? cut.slice(0, space) : cut}…`;
};

/**
 * Orbit's chat flow: a request becomes a build brief, the group says "ship it",
 * Claude writes the app, a sandbox serves it, and the link goes back to the
 * chat. Later requests edit the same app and post v2, v3… at their own links.
 */
export class OrbitService {
  private readonly steps: OrbitSteps;
  private readonly running = new Set<Promise<void>>();
  /** Design specs being written while the group reads the plan, keyed by chat. */
  private readonly specJobs = new Map<string, { pending: PendingBuild; spec: Promise<string> }>();

  constructor(
    private readonly store: OrbitStore,
    private readonly host: AppHost,
    private readonly roster: Member[],
    private readonly groups: GroupRegistry,
    steps: Partial<OrbitSteps> = {},
    /** Repo mode (clone, change, PR, rollback). Needs Daytona; off without it. */
    private readonly repos?: Pick<RepoWorker, "attach" | "ask" | "change" | "rollback">,
  ) {
    this.steps = { writeBrief, writeSpec, writeRepoPlan, generateApp, checkApp, ...steps };
  }

  /** Only roster numbers (ORBIT_ALLOWED, else members.json and the signup groups) can start builds. */
  isAllowed(handle: string): boolean {
    if (config.orbitAllowed.length > 0) return config.orbitAllowed.some((h) => sameHandle(h, handle));
    if (findMemberByHandle(this.roster, handle)) return true;
    return this.groups.list().some((g) => g.members.some((m) => sameHandle(m.handle, handle)));
  }

  hasPending(chatId: string): boolean {
    const chat = this.store.chat(chatId);
    return !!chat.pending || !!chat.pendingRepo;
  }

  /** Handle one message aimed at Orbit. Builds run in the background; this returns once the first reply is out. */
  async handle(turn: OrbitTurn): Promise<void> {
    if (!this.isAllowed(turn.senderHandle)) {
      log.info("orbit_ignored_sender", { chatId: turn.chatId });
      return;
    }
    const chat = this.store.chat(turn.chatId);
    const cmd = parseOrbitCommand(turn.body);
    const project = this.store.current(chat);
    const n = config.AGENT_NAME;

    switch (cmd.kind) {
      case "help":
        await turn.say(
          [
            `I'm ${n}. Tell me what to build and I'll make it and send you a link, like "@${n} make flappy bird with a cat and neon colors".`,
            `I'll write up the plan first; reply "ship it" to build it. After that, ask for changes ("@${n} make it faster") and I'll post a new version.`,
            `"@${n} versions" lists every link. "@${n} cancel" drops a plan I haven't built.`,
            `To work on code instead, paste a GitHub link: "@${n} work on github.com/you/repo". I'll clone it, make changes on their own branches and open pull requests.`,
          ].join("\n\n"),
          "help",
        );
        return;

      case "versions": {
        if (chat.repo) {
          const r = chat.repo;
          const branches = r.branches.map((b) => `${b.title}: ${b.name}${b.prUrl ? ` ${b.prUrl}` : ""} (${b.commits.length} commit${b.commits.length === 1 ? "" : "s"})`);
          await turn.say(branches.length > 0 ? `${r.owner}/${r.name}\n${branches.join("\n")}` : `No branches on ${r.owner}/${r.name} yet. Ask me for a change.`, "versions");
          return;
        }
        const lines = chat.projects.flatMap((p) =>
          p.versions.filter((v) => v.status === "live").map((v) => `${p.title} v${v.n}: ${v.url}`),
        );
        await turn.say(lines.length > 0 ? lines.join("\n") : `Nothing built yet. Try "@${n} make a game where…"`, "versions");
        return;
      }

      case "cancel":
        if (!chat.pending && !chat.pendingRepo) {
          await turn.say("There's nothing waiting to build.", "cancel");
          return;
        }
        delete chat.pending;
        delete chat.pendingRepo;
        this.specJobs.delete(turn.chatId);
        this.store.save();
        await turn.say("Okay, scrapped that plan.", "cancel");
        return;

      case "ship":
        if (chat.building) {
          await turn.say(`Still working on ${chat.building.label}. I'll post here when it's done.`, "busy");
          return;
        }
        if (chat.pendingRepo && chat.repo) {
          this.startRepoTask(chat, chat.pendingRepo, turn);
          return;
        }
        if (!chat.pending) {
          await turn.say(`There's nothing waiting to build. Tell me what to make: "@${n} make a game where…"`, "ship");
          return;
        }
        this.startBuild(chat, chat.pending, turn);
        return;

      case "request": {
        if (chat.building) {
          await turn.say(`I'm still working on ${chat.building.label}. Ask again once it's done.`, "busy");
          return;
        }
        const ref = findRepoUrl(cmd.text);
        if (ref) {
          if (!this.repos) {
            await turn.say(`Working on GitHub repos needs a Daytona sandbox, and there's no DAYTONA_API_KEY set.`, "repo");
            return;
          }
          const worker = this.repos;
          this.startJob(chat, `cloning ${ref.owner}/${ref.name}`, turn, `clone:${ref.owner}/${ref.name}`, async () => {
            const repo = await worker.attach(ref);
            chat.repo = repo;
            delete chat.pendingRepo;
            this.store.save();
            const push = repo.canPush ? "" : "\n\nThere's no GitHub token that can push here, so changes will stay in the sandbox (no branches pushed or pull requests opened).";
            return `Cloned ${repo.owner}/${repo.name} (${repo.defaultBranch}). ${repo.summary}\n\nAsk me for a change, like "@${n} add a dark mode toggle", or anything about the code or its history.${push}`;
          });
          await turn.say(`Cloning ${ref.owner}/${ref.name} into a sandbox and reading through it. This takes a minute or two.`, "cloning");
          return;
        }
        if (chat.repo && this.repos) {
          await this.repoRequest(chat, cmd.text, turn);
          return;
        }
        const current = project ? { title: project.title, brief: project.summary, version: latestLive(project)?.n ?? 0 } : undefined;
        const photos = await turn.images().catch((err) => {
          log.error("orbit_images_failed", err, { chatId: turn.chatId });
          return [] as ChatImage[];
        });
        const brief = await this.steps.writeBrief({
          transcript: await turn.transcript(),
          askedBy: turn.askedBy,
          request: cmd.text,
          current,
          images: photos.map((p) => ({ label: `Photo sent by ${p.sentBy}:`, data: p.data })),
        });
        if (brief.action === "reply") {
          await turn.say(brief.reply || `Tell me what to build, like "@${n} make snake with emoji".`, "reply");
          return;
        }
        const pending: PendingBuild = {
          action: brief.action,
          title: brief.title || project?.title || "Untitled app",
          brief: brief.brief,
          requestedBy: turn.askedBy,
          at: new Date().toISOString(),
          ...(photos.length > 0 ? { images: photos.map((p) => ({ id: p.id, sentBy: p.sentBy })) } : {}),
        };
        if (pending.action === "edit" && !config.ORBIT_CONFIRM_EDITS) {
          this.startBuild(chat, pending, turn);
          return;
        }
        chat.pending = pending;
        this.store.save();
        // Start the design spec now, so it's usually ready by the time someone says "ship it".
        if (pending.action === "build" && config.ORBIT_SPEC) {
          const images = numbered(cachedOnly(pending.images ?? []));
          const spec = turn.fullTranscript().then((transcript) => this.steps.writeSpec({ title: pending.title, brief: pending.brief, transcript, images }));
          spec.catch(() => undefined); // a failure is retried at build time
          this.specJobs.set(turn.chatId, { pending, spec });
        }
        const next = pending.action === "edit" && project ? `v${(project.versions.at(-1)?.n ?? 0) + 1} of ${project.title}` : `${pending.title} (v1)`;
        await turn.say(`Here's the plan for ${next}:\n\n${pending.brief}\n\nReply "ship it" to build it, or tell me what to change.`, "plan");
        return;
      }
    }
  }

  /** Kick off a build without blocking the chat. The link (or the error) is posted when it's done. */
  private startBuild(chat: OrbitChat, pending: PendingBuild, turn: OrbitTurn): void {
    let project = pending.action === "edit" ? this.store.current(chat) : undefined;
    if (!project) {
      project = {
        id: randomBytes(4).toString("hex"),
        title: pending.title,
        summary: pending.brief,
        createdBy: pending.requestedBy,
        createdAt: new Date().toISOString(),
        versions: [],
      };
      chat.projects.push(project);
      chat.currentProjectId = project.id;
    }
    const n = (project.versions.at(-1)?.n ?? 0) + 1;
    delete chat.pending;
    chat.building = { label: `v${n} of ${project.title}`, startedAt: new Date().toISOString() };
    this.store.save();
    log.info("orbit_build_started", { chatId: chat.chatId, projectId: project.id, version: n, action: pending.action });

    const target = project;
    const job = (async () => {
      await turn.say(
        n === 1 ? `Building ${target.title}. Give me about a minute.` : `On it: v${n} of ${target.title}. ${pending.brief}`,
        `start:${target.id}:v${n}`,
      );
      const early = this.specJobs.get(chat.chatId);
      this.specJobs.delete(chat.chatId);
      const version = await this.build(target, n, pending, turn, early?.pending === pending ? early.spec : undefined);
      chat.building = undefined;
      target.versions.push(version);
      if (version.status === "live" && pending.action === "edit") target.summary = trimSummary(`${target.summary} Then: ${pending.brief}`);
      this.store.save();
      log.info("orbit_build_finished", { chatId: chat.chatId, projectId: target.id, version: n, status: version.status, ms: version.buildMs });
      if (version.status === "live") {
        const tip = n === 1 ? `\n\nWant changes? "@${config.AGENT_NAME} make it faster" and I'll post v2.` : "";
        await turn.say(`v${n} of ${target.title} is live: ${version.url}${tip}`, `live:${target.id}:v${n}`);
      } else {
        await turn.say(`v${n} didn't build (${short(version.error ?? "unknown error", 140)}). Try again, or describe it a different way.`, `failed:${target.id}:v${n}`);
      }
    })().catch((err) => log.error("orbit_build_crashed", err, { chatId: chat.chatId }));
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
  }

  /** Repo mode: work out what the message wants, then answer, or post a plan that waits for "ship it". */
  private async repoRequest(chat: OrbitChat, text: string, turn: OrbitTurn): Promise<void> {
    const repo = chat.repo!;
    const worker = this.repos!;
    const plan = await this.steps.writeRepoPlan({ repo, transcript: await turn.transcript(), askedBy: turn.askedBy, request: text });
    const branch = plan.branch ? repo.branches.find((b) => b.name === plan.branch) : repo.branches.find((b) => b.name === repo.currentBranch);

    if (plan.action === "leave") {
      delete chat.repo;
      delete chat.pendingRepo;
      this.store.save();
      await turn.say(`Done with ${repo.owner}/${repo.name}. Back to building apps.`, "leave");
      return;
    }
    if (plan.action === "question") {
      this.startJob(chat, "a question about the code", turn, "answer", () => worker.ask(repo, plan.brief || text));
      return;
    }
    const pending: PendingRepoTask = {
      action: plan.action === "update" && !branch ? "change" : plan.action,
      title: plan.title || "Update from the group chat",
      brief: plan.brief,
      requestedBy: turn.askedBy,
      at: new Date().toISOString(),
      ...(branch && plan.action !== "change" ? { branch: branch.name } : {}),
      ...(plan.action === "rollback" ? { rollbackMode: plan.rollbackMode === "restore" ? ("restore" as const) : ("undo" as const) } : {}),
      ...(plan.action === "rollback" && plan.rollbackCommit ? { rollbackCommit: plan.rollbackCommit } : {}),
    };
    chat.pendingRepo = pending;
    this.store.save();
    const where = pending.branch ? `${pending.branch}${branch?.prUrl ? ` (${branch.prUrl})` : ""}` : `a new branch off ${repo.defaultBranch}`;
    let message: string;
    if (pending.action === "rollback") {
      const what =
        pending.rollbackMode === "restore"
          ? `restore the code to how it was at ${pending.rollbackCommit ?? "the latest commit"}`
          : `undo ${pending.rollbackCommit ?? "the latest commit"}`;
      message = `I'll ${what} on ${where}, as a new commit, so nothing is erased from the history. Reply "ship it" to go ahead.`;
    } else {
      message = `Here's the plan for ${repo.owner}/${repo.name}:\n\n${pending.brief}\n\nI'll do it on ${where}${repo.canPush ? " and open a pull request" : ""}. Reply "ship it" to start.`;
    }
    await turn.say(message, "repo-plan");
  }

  /** Run a confirmed repo change, follow-up or rollback in the background and post the result. */
  private startRepoTask(chat: OrbitChat, task: PendingRepoTask, turn: OrbitTurn): void {
    const repo = chat.repo!;
    const worker = this.repos!;
    delete chat.pendingRepo;
    const branch = task.branch ? repo.branches.find((b) => b.name === task.branch) : undefined;
    this.startJob(chat, task.title, turn, `repo:${task.at}`, async () => {
      const result: ChangeResult =
        task.action === "rollback"
          ? await worker.rollback(repo, { mode: task.rollbackMode ?? "undo", commit: task.rollbackCommit, title: task.title, requestedBy: task.requestedBy, branch })
          : await worker.change(repo, { brief: task.brief, title: task.title, requestedBy: task.requestedBy, branch });
      this.store.save();
      log.info("repo_task_finished", { chatId: chat.chatId, action: task.action, changed: result.changed, pushed: result.pushed });
      if (!result.changed) return `I didn't end up changing anything. ${result.report}`;
      const c = result.commit!;
      const pr = result.pushed
        ? `Pull request: ${result.branch.prUrl}`
        : "Not pushed: add a GITHUB_TOKEN that can push to this repo and I'll push the branch and open a pull request.";
      return `Done on ${result.branch.name}: ${result.stat} (commit ${c.sha}, "${c.message}").\n\n${result.report}\n\n${pr}`;
    });
    void turn.say(`On it: ${task.title}. I'll post here when it's done.`, `repo-start:${task.at}`);
  }

  /** Run one piece of background work for a chat (one at a time), then post what it returns, or what went wrong. */
  private startJob(chat: OrbitChat, label: string, turn: OrbitTurn, key: string, work: () => Promise<string>): void {
    chat.building = { label, startedAt: new Date().toISOString() };
    this.store.save();
    const job = (async () => {
      let text: string;
      try {
        text = await work();
      } catch (err) {
        log.error("orbit_job_failed", err, { chatId: chat.chatId, label });
        text = `That didn't work: ${short(err instanceof Error ? err.message : String(err), 200)}`;
      }
      chat.building = undefined;
      this.store.save();
      await turn.say(text, `done:${key}`);
    })().catch((err) => log.error("orbit_job_crashed", err, { chatId: chat.chatId }));
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
  }

  /** Resolves once every build in progress has posted its result. */
  async idle(): Promise<void> {
    await Promise.all([...this.running]);
  }

  /** Write, publish and check one version. Never throws: failures come back as a failed version. */
  private async build(project: Project, n: number, pending: PendingBuild, turn: OrbitTurn, earlySpec?: Promise<string>): Promise<Version> {
    const started = Date.now();
    const version: Version = { n, brief: pending.brief, requestedBy: pending.requestedBy, at: new Date().toISOString(), status: "failed" };
    const previous = latestLive(project);
    // The app's photos: an edit keeps the ones already in it (same placeholders) and adds new ones.
    const known = cachedOnly(project.images ?? []);
    const photos = cachedOnly(
      pending.action === "edit" ? [...known, ...(pending.images ?? []).filter((p) => !known.some((k) => k.id === p.id))] : (pending.images ?? []),
    );
    const images = numbered(photos);
    const buffers = images.map((i) => i.data);
    const stored = previous ? this.store.readHtml(project.id, previous.n) : undefined;
    // Claude sees placeholders, not hundreds of KB of base64.
    const previousHtml = stored ? stripImages(stored, numbered(known).map((i) => i.data)) : undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`took longer than ${config.ORBIT_BUILD_TIMEOUT_S}s`)), config.ORBIT_BUILD_TIMEOUT_S * 1000);
    });
    try {
      await Promise.race([
        (async () => {
          // New apps get a detailed design spec from the whole chat first; edits stay targeted.
          let spec: string | undefined;
          if (!previousHtml && config.ORBIT_SPEC) {
            const specStarted = Date.now();
            spec = await (earlySpec ?? Promise.reject(new Error("no early spec"))).catch(async () =>
              this.steps.writeSpec({ title: project.title, brief: pending.brief, transcript: await turn.fullTranscript(), images }),
            );
            this.store.writeFile(project.id, n, "SPEC.md", spec);
            version.specMs = Date.now() - specStarted;
          }
          let html = await this.write(project, n, pending, previousHtml, spec, images);
          let published = await this.publish(project, n, html);
          // Quality check: load it like a phone, and send any errors back for one fix.
          const report = await this.steps.checkApp(published, `${config.ORBIT_APPS_DIR}/${project.id}/v${n}/screenshot.png`);
          if (report.ran && report.errors.length > 0) {
            log.warn("orbit_quality_errors", { projectId: project.id, version: n, errors: report.errors.length });
            html = inlineImages(
              await this.steps.generateApp({ title: project.title, brief: pending.brief, previousHtml: stripImages(html, buffers), errors: report.errors, images }),
              buffers,
            );
            this.store.writeHtml(project.id, n, html);
            published = await this.publish(project, n, html);
            version.fixedErrors = report.errors.length;
          }
          version.url = published;
          version.status = "live";
          if (photos.length > 0) project.images = photos;
        })(),
        timeout,
      ]);
    } catch (err) {
      version.error = err instanceof Error ? err.message : String(err);
      log.error("orbit_build_failed", err, { projectId: project.id, version: n });
    } finally {
      clearTimeout(timer);
      version.buildMs = Date.now() - started;
    }
    return version;
  }

  private async write(
    project: Project,
    n: number,
    pending: PendingBuild,
    previousHtml: string | undefined,
    spec: string | undefined,
    images: (LlmImage & { data: Buffer })[],
  ): Promise<string> {
    const buffers = images.map((i) => i.data);
    const raw =
      config.orbitBuilder === "claude-code" && this.host instanceof DaytonaHost
        ? await this.host.buildWithClaudeCode(project, n, spec ?? pending.brief, previousHtml, config.ORBIT_BUILD_TIMEOUT_S, buffers)
        : await this.steps.generateApp({ title: project.title, brief: pending.brief, spec, previousHtml, images });
    // Swap the placeholders for the real photos, so the published file is self-contained.
    const html = inlineImages(raw, buffers);
    this.store.writeHtml(project.id, n, html);
    return html;
  }

  private async publish(project: Project, n: number, html: string): Promise<string> {
    const { url, sandboxId } = await this.host.publish(project, n, html);
    if (sandboxId) project.sandboxId = sandboxId;
    return url;
  }
}

/** Keep the app's running summary under 2,000 characters: the original description and the newest changes, not the middle. */
function trimSummary(summary: string): string {
  if (summary.length <= 2000) return summary;
  return `${summary.slice(0, 700)} … ${summary.slice(-1250)}`;
}

/** Only the photos still in the image cache, so numbering always matches what gets inlined. */
function cachedOnly(photos: ProjectImage[]): ProjectImage[] {
  return photos.filter((p) => readCachedImage(p.id));
}

/** Photos as Claude sees them: "Image 1, sent by Harsh", in placeholder order. Call with cachedOnly() photos. */
function numbered(photos: ProjectImage[]): LlmImage[] {
  return photos.map((p, i) => ({ label: `Image ${i + 1}, sent by ${p.sentBy} (use it as ORBIT_IMAGE_${i + 1}):`, data: readCachedImage(p.id)! }));
}

function latestLive(project: Project): Version | undefined {
  return [...project.versions].reverse().find((v) => v.status === "live");
}
