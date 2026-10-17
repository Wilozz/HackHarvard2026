import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { z } from "zod";
import { config } from "../config";
import { log } from "../log";
import { PhotonError, type PhotonApi, type PhotonUser } from "./api";
import type { Group, GroupMember, GroupRegistry } from "./groups";
import { signupPage } from "./signup-page";

/** People per group, not counting the agent. Two or more makes it a group chat. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 10;
const MAX_BODY_BYTES = 16 * 1024;

export interface SignupInput {
  title?: string;
  members: { name: string; phone: string }[];
}

/**
 * E.164 for a typed phone number. Numbers with a leading + keep their country
 * code; 10-digit numbers without one are taken as US/Canada.
 */
export function normalizePhone(raw: string): string | undefined {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  let e164: string;
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) e164 = `+1${digits}`;
  else if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) e164 = `+${digits}`;
  else return undefined;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : undefined;
}

const formSchema = z.object({
  title: z.string().optional(),
  consent: z.boolean().optional(),
  members: z.array(z.object({ name: z.string(), phone: z.string() })).max(50),
});

/** Check the form and clean it up. Errors are written for the person filling it in. */
export function parseSignup(body: unknown): { ok: true; input: SignupInput } | { ok: false; error: string } {
  const form = formSchema.safeParse(body);
  if (!form.success) return { ok: false, error: "Something's off with that form. Reload the page and try again." };

  const rows = form.data.members.map((m) => ({ name: m.name.trim(), phone: m.phone.trim() })).filter((m) => m.name || m.phone);
  if (rows.length < MIN_MEMBERS) return { ok: false, error: `Add at least ${MIN_MEMBERS} people to start a group chat.` };
  if (rows.length > MAX_MEMBERS) return { ok: false, error: `A group can have up to ${MAX_MEMBERS} people.` };

  const members: SignupInput["members"] = [];
  for (const row of rows) {
    if (!row.phone) return { ok: false, error: `Add a phone number for ${row.name}.` };
    const phone = normalizePhone(row.phone);
    if (!phone) return { ok: false, error: `"${row.phone}" doesn't look like a phone number. Include the country code, like +61 4…` };
    if (!row.name) return { ok: false, error: `Add a name for ${row.phone}.` };
    if (row.name.length > 40) return { ok: false, error: `Keep names under 40 characters.` };
    if (members.some((m) => m.phone === phone)) return { ok: false, error: `${row.phone} is on the list twice.` };
    members.push({ name: row.name, phone });
  }
  if (form.data.consent !== true) return { ok: false, error: "Check the box to confirm everyone agreed to be added." };

  const title = form.data.title?.trim().slice(0, 80);
  return { ok: true, input: { members, ...(title ? { title } : {}) } };
}

function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function welcomeText(group: Group): string {
  const n = config.AGENT_NAME;
  return [
    `Hi ${listNames(group.members.map((m) => m.name))}! I'm ${n}, an AI travel agent, and I'm here to help you all plan ${group.title ?? "your next trip"}.`,
    `Talk here like you normally would about when you're free, where you want to go, and what you want to spend. Whenever you're ready, text "@${n} give us a trip idea" and I'll suggest a trip that works for everyone.`,
  ].join("\n\n");
}

/** The line that starts group chats: PHOTON_AGENT_USER_ID if set, else the project's dedicated line. */
export async function groupLine(api: PhotonApi): Promise<PhotonUser> {
  const agents = await api.listAgents();
  const line = config.PHOTON_AGENT_USER_ID
    ? agents.find((a) => a.id === config.PHOTON_AGENT_USER_ID)
    : agents.find((a) => a.details?.type === "dedicated");
  if (!line) throw new Error("This Photon project has no dedicated iMessage line, and group chats need one.");
  return line;
}

/**
 * What createGroup.ts did, plus a personal welcome: create or get each
 * person's User, create or get the group with the line first (so it starts
 * the chat), then greet everyone by name. Signing up the same people again
 * returns the same chat and updates names without a second welcome.
 */
export async function createGroupChat(
  api: PhotonApi,
  groups: GroupRegistry,
  line: PhotonUser,
  input: SignupInput,
): Promise<{ group: Group; existing: boolean }> {
  const members: GroupMember[] = [];
  const started = Date.now();
  const step = (event: string, fields: Record<string, string | number> = {}) => log.info(event, { ...fields, ms: Date.now() - started });
  for (const person of input.members) {
    const user = await api.createUser(person.phone);
    members.push({ name: person.name, handle: person.phone, userId: user.id });
    step("signup_user", { n: members.length, of: input.members.length });
  }
  step("signup_creating_space", { people: members.length });
  const space = await api.createSpace([line.id, ...members.map((m) => m.userId)]);
  step("signup_space", { spaceId: space.id });

  const before = groups.get(space.id);
  const title = input.title ?? before?.title;
  const group: Group = {
    spaceId: space.id,
    createdAt: before?.createdAt ?? new Date().toISOString(),
    members,
    ...(title ? { title } : {}),
  };
  if (!before) {
    await api.sendText({ spaceId: space.id, senderId: line.id, text: welcomeText(group), idempotencyKey: `welcome:${space.id}` });
    step("signup_welcome_sent");
  }
  groups.upsert(group);
  return { group, existing: !!before };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The React signup page (web/), once built with `npm run web:build`. */
const WEB_DIST = resolve("web/dist");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Serve a file from web/dist if the page has been built. False means not found, so the caller falls back. */
function serveBuiltPage(path: string, res: ServerResponse): boolean {
  if (!existsSync(resolve(WEB_DIST, "index.html"))) return false;
  const file = resolve(WEB_DIST, path === "/" ? "index.html" : `.${decodeURIComponent(path)}`);
  // Never serve anything outside web/dist.
  if (!file.startsWith(WEB_DIST + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  const immutable = file.includes(`${sep}assets${sep}`);
  res
    .writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    })
    .end(readFileSync(file));
  return true;
}

/** The signup page and its one endpoint, POST /api/groups. */
export function startSignupServer(api: PhotonApi, groups: GroupRegistry): void {
  if (config.SIGNUP_PORT === 0) return;
  // One signup at a time, so two submissions can't race on the same people.
  let busy: Promise<void> = Promise.resolve();

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Requiring JSON also makes browsers preflight cross-site posts, which this server never approves.
    if (!req.headers["content-type"]?.startsWith("application/json")) return sendJson(res, 415, { error: "Expected JSON." });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "Something's off with that form. Reload the page and try again." });
    }
    const parsed = parseSignup(body);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

    try {
      const line = await groupLine(api);
      const { group, existing } = await createGroupChat(api, groups, line, parsed.input);
      log.info("signup_group", { spaceId: group.spaceId, members: group.members.length, existing });
      sendJson(res, 200, { spaceId: group.spaceId, names: group.members.map((m) => m.name), agentPhone: line.handle, existing });
    } catch (err) {
      log.error("signup_failed", err);
      const error = err instanceof PhotonError ? `Photon couldn't start the chat: ${err.message}` : err instanceof Error ? err.message : "Something went wrong.";
      sendJson(res, 502, { error });
    }
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && serveBuiltPage(path, res)) return;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(signupPage(config.AGENT_NAME, MAX_MEMBERS));
      return;
    }
    if (req.method === "POST" && path === "/api/groups") {
      busy = busy.then(() => create(req, res)).catch((err) => log.error("signup_request_failed", err));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  });
  server.on("error", (err) => log.error("signup_server_failed", err));
  server.listen(config.SIGNUP_PORT, config.SIGNUP_HOST, () =>
    log.info("signup_server", { url: `http://${config.SIGNUP_HOST === "0.0.0.0" ? "localhost" : config.SIGNUP_HOST}:${config.SIGNUP_PORT}` }),
  );
}
