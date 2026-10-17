import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config";
import type { RepoState } from "./repo";

export interface Version {
  n: number;
  /** What this version was asked to do. */
  brief: string;
  requestedBy: string;
  at: string;
  status: "live" | "failed";
  url?: string;
  error?: string;
  /** Console errors found by the quality check and sent back to be fixed. */
  fixedErrors?: number;
  buildMs?: number;
  /** Time spent writing the design spec (new apps only). */
  specMs?: number;
}

/** A photo from the chat that's part of an app. Its JPEG lives in the image cache by id. */
export interface ProjectImage {
  id: string;
  sentBy: string;
}

export interface Project {
  id: string;
  title: string;
  /** Photos used in the app, in placeholder order (ORBIT_IMAGE_1 is the first). */
  images?: ProjectImage[];
  /** Everything the app does so far: the first brief plus each change. */
  summary: string;
  createdBy: string;
  createdAt: string;
  sandboxId?: string;
  versions: Version[];
}

export interface PendingBuild {
  action: "build" | "edit";
  /** The app's photos for this build: the project's existing ones first, then new ones. */
  images?: ProjectImage[];
  title: string;
  brief: string;
  requestedBy: string;
  at: string;
}

export interface PendingRepoTask {
  action: "change" | "update" | "rollback";
  title: string;
  brief: string;
  requestedBy: string;
  at: string;
  /** For update/rollback: the Ensemble branch it applies to. */
  branch?: string;
  rollbackMode?: "undo" | "restore";
  rollbackCommit?: string;
}

export interface OrbitChat {
  chatId: string;
  projects: Project[];
  currentProjectId?: string;
  pending?: PendingBuild;
  /** Whatever is running for this chat (a build or a repo task). One at a time. */
  building?: { label: string; startedAt: string };
  /** Repo mode: the GitHub repo this chat is working on. */
  repo?: RepoState;
  /** A repo change, follow-up or rollback waiting for "ship it". */
  pendingRepo?: PendingRepoTask;
}

/**
 * Projects, versions and links per chat, plus each version's HTML on disk.
 * A JSON file is plenty for a hackathon and doesn't depend on the database.
 */
export class OrbitStore {
  private chats: Record<string, OrbitChat>;

  constructor(
    /** null keeps everything in memory (tests). */
    private readonly file: string | null = config.ORBIT_FILE,
    private readonly appsDir: string = config.ORBIT_APPS_DIR,
  ) {
    this.chats = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, OrbitChat>) : {};
    // A build can't survive a restart.
    for (const chat of Object.values(this.chats)) delete chat.building;
  }

  chat(chatId: string): OrbitChat {
    return (this.chats[chatId] ??= { chatId, projects: [] });
  }

  current(chat: OrbitChat): Project | undefined {
    return chat.projects.find((p) => p.id === chat.currentProjectId);
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.chats, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  htmlPath(projectId: string, version: number): string {
    return join(this.appsDir, projectId, `v${version}`, "index.html");
  }

  writeHtml(projectId: string, version: number, html: string): void {
    const path = this.htmlPath(projectId, version);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }

  writeFile(projectId: string, version: number, name: string, content: string): void {
    const path = join(this.appsDir, projectId, `v${version}`, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  readHtml(projectId: string, version: number): string | undefined {
    const path = this.htmlPath(projectId, version);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
}
