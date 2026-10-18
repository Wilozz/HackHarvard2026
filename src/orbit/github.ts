import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { config } from "../config";

/**
 * The GitHub token, re-read from .env on every use, so a new token works
 * without restarting Ensemble. Falls back to what was loaded at startup.
 */
export function githubToken(): string | undefined {
  try {
    if (existsSync(".env")) {
      const fresh = parse(readFileSync(".env", "utf8")).GITHUB_TOKEN?.trim();
      if (fresh) return fresh;
    }
  } catch {
    // unreadable .env: use the startup value
  }
  return config.GITHUB_TOKEN;
}

/** A GitHub repository someone pasted into the chat. */
export interface RepoRef {
  owner: string;
  name: string;
  /** https://github.com/owner/name */
  url: string;
}

/** "owner/name" (or a github.com link) → a RepoRef, or undefined if it doesn't look like one. */
export function parseRepo(text: string): RepoRef | undefined {
  const link = findRepoUrl(text);
  if (link) return link;
  const m = text.trim().match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  return m ? { owner: m[1]!, name: m[2]!.replace(/\.git$/i, ""), url: `https://github.com/${m[1]}/${m[2]!.replace(/\.git$/i, "")}` } : undefined;
}

/** The first github.com repository link in a message, if any. */
export function findRepoUrl(text: string): RepoRef | undefined {
  const m = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})/i);
  if (!m) return undefined;
  const owner = m[1]!;
  const name = m[2]!.replace(/\.git$/i, "").replace(/[.,!?)]+$/, "");
  if (!name) return undefined;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

async function gh<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // not JSON
    }
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The repo's default branch and whether we can push to it. Throws if it doesn't exist or isn't visible to our token. */
export async function getRepo(ref: RepoRef): Promise<{ defaultBranch: string; private: boolean; canPush: boolean }> {
  const r = await gh<{ default_branch: string; private: boolean; permissions?: { push?: boolean } }>("GET", `/repos/${ref.owner}/${ref.name}`);
  return { defaultBranch: r.default_branch, private: r.private, canPush: !!r.permissions?.push };
}

/** Open a pull request, or return the one already open for this branch. */
export async function openPullRequest(ref: RepoRef, args: { head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
  const open = await gh<{ html_url: string; number: number }[]>("GET", `/repos/${ref.owner}/${ref.name}/pulls?state=open&head=${ref.owner}:${encodeURIComponent(args.head)}`);
  if (open[0]) return { url: open[0].html_url, number: open[0].number };
  const pr = await gh<{ html_url: string; number: number }>("POST", `/repos/${ref.owner}/${ref.name}/pulls`, args);
  return { url: pr.html_url, number: pr.number };
}

export interface PullRequestStatus {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  /** GitHub's verdict: "clean" can merge; "dirty" has conflicts; "blocked" needs reviews or checks; "behind" is out of date; "unstable" has failing checks. */
  mergeableState: string;
  head: string;
  base: string;
  changedFiles: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pull request's merge status. GitHub works out mergeability in the background, so this waits briefly for it. */
export async function getPullRequest(ref: RepoRef, number: number): Promise<PullRequestStatus> {
  for (let attempt = 0; ; attempt++) {
    const pr = await gh<{
      number: number;
      html_url: string;
      title: string;
      state: "open" | "closed";
      merged: boolean;
      mergeable_state: string;
      head: { ref: string };
      base: { ref: string };
      changed_files: number;
    }>("GET", `/repos/${ref.owner}/${ref.name}/pulls/${number}`);
    if (pr.mergeable_state !== "unknown" || attempt >= 5) {
      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        state: pr.state,
        merged: pr.merged,
        mergeableState: pr.mergeable_state,
        head: pr.head.ref,
        base: pr.base.ref,
        changedFiles: pr.changed_files,
      };
    }
    await sleep(1500);
  }
}

/** Squash-merge a pull request. Returns the merge commit. */
export async function mergePullRequest(ref: RepoRef, number: number, title: string): Promise<{ sha: string }> {
  const res = await gh<{ sha: string; merged: boolean; message: string }>("PUT", `/repos/${ref.owner}/${ref.name}/pulls/${number}/merge`, {
    merge_method: "squash",
    commit_title: `${title} (#${number})`,
  });
  if (!res.merged) throw new Error(res.message || "GitHub didn't merge it");
  return { sha: res.sha };
}

/** Delete a branch on GitHub (after its pull request is merged). */
export async function deleteRemoteBranch(ref: RepoRef, branch: string): Promise<void> {
  await gh("DELETE", `/repos/${ref.owner}/${ref.name}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
}
