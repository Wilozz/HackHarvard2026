// Minimal client for the Photon 2.0 beta HTTP API (api.photon.codes/v1).
// Spec: https://api.photon.codes/openapi.json. This is not Spectrum: the beta
// uses a project API key (pho_sk_...) as a Bearer token.

/** The parts of a Photon User snapshot Tripchat reads. */
export interface PhotonUser {
  id: string;
  /** "agent" for the project's own lines, "human" for everyone else. */
  kind: string;
  handle: string;
  metadata?: { displayName?: string };
}

/** Text, attachment, or a group of parts (text + attachments sent together). */
export interface PhotonContent {
  type: string;
  format?: string;
  text?: string;
  parts?: PhotonContent[];
}

export interface PhotonMessage {
  id: string;
  platform: string;
  status: "received" | "dispatched" | "accepted" | "delivered" | "failed";
  createdAt: string;
  space: { id: string; kind: string; participantIds: string[] };
  sentBy: PhotonUser;
  /** Set on direct messages. Group messages carry no receivedBy. */
  receivedBy?: PhotonUser;
  content: PhotonContent;
  parentMessageId?: string;
  failure?: { code: string; message: string };
}

export interface ListMessagesQuery {
  platform?: string;
  direction?: "received" | "sent";
  order?: "asc" | "desc";
  /** Inclusive lower bound on createdAt, RFC 3339. */
  createdSince?: string;
  pageSize?: number;
}

export interface SendTextArgs {
  spaceId: string;
  senderId: string;
  text: string;
  parentMessageId?: string;
  /** Reuse only when retrying the same logical send. */
  idempotencyKey: string;
}

/** What the agent needs from Photon, so tests can swap in a fake. */
export interface PhotonApi {
  /** Every matching message, paging through nextPageToken. Stop iterating to stop fetching. */
  listMessages(query: ListMessagesQuery): AsyncIterable<PhotonMessage>;
  getMessage(id: string): Promise<PhotonMessage>;
  listAgentUserIds(): Promise<string[]>;
  sendText(args: SendTextArgs): Promise<PhotonMessage>;
  setTyping(spaceId: string, senderId: string, typing: boolean): Promise<void>;
}

export class PhotonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PhotonError";
  }
}

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPhotonClient(opts: { baseUrl: string; projectId: string; apiKey: string }): PhotonApi {
  const root = `${opts.baseUrl.replace(/\/+$/, "")}/projects/${opts.projectId}`;

  /**
   * One API call. 429s, 5xx and network errors are retried with the same
   * idempotency key, so a retried send can never post twice.
   */
  async function request<T>(method: "GET" | "POST", path: string, init: { query?: Record<string, string | undefined>; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

      const wait = retryAfterMs(res.headers.get("retry-after"));
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(wait ?? 500 * 2 ** attempt, 30_000));
        continue;
      }
      let problem: { code?: string; title?: string; detail?: string; requestId?: string } = {};
      try {
        problem = JSON.parse(text);
      } catch {
        // not problem+json
      }
      throw new PhotonError(
        res.status,
        problem.code,
        `Photon ${method} ${path} → ${res.status}${problem.code ? ` ${problem.code}` : ""}${problem.detail ? `: ${problem.detail}` : ""}`,
        problem.requestId ?? res.headers.get("x-request-id") ?? undefined,
        wait,
      );
    }
  }

  async function* paginate<T>(path: string, query: Record<string, string | undefined>): AsyncGenerator<T> {
    let pageToken: string | undefined;
    do {
      const page = await request<{ items: T[]; nextPageToken?: string }>("GET", path, { query: { ...query, pageToken } });
      yield* page.items;
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  return {
    listMessages(q) {
      return paginate<PhotonMessage>("/messages", {
        platform: q.platform,
        direction: q.direction,
        order: q.order,
        createdSince: q.createdSince,
        pageSize: String(q.pageSize ?? 200),
      });
    },

    getMessage(id) {
      return request<PhotonMessage>("GET", `/messages/${encodeURIComponent(id)}`);
    },

    async listAgentUserIds() {
      const ids: string[] = [];
      for await (const u of paginate<PhotonUser>("/users", { platform: "imessage", pageSize: "200" })) {
        if (u.kind === "agent") ids.push(u.id);
      }
      return ids;
    },

    sendText(args) {
      return request<PhotonMessage>("POST", "/messages", {
        idempotencyKey: args.idempotencyKey,
        body: {
          spaceId: args.spaceId,
          senderId: args.senderId,
          content: { type: "text", format: "plain", text: args.text },
          ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
        },
      });
    },

    async setTyping(spaceId, senderId, typing) {
      await request("POST", `/spaces/${encodeURIComponent(spaceId)}/typing`, { body: { senderId, typing } });
    },
  };
}
