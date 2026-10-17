import { config } from "../config";

/** A GitHub repository someone pasted into the chat. */
export interface RepoRef {
  owner: string;
  name: string;
  /** https://github.com/owner/name */
  url: string;
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

async function gh<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(config.GITHUB_TOKEN ? { Authorization: `Bearer ${config.GITHUB_TOKEN}` } : {}),
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
