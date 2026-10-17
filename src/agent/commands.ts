import type { Phase } from "../trip/state";

export type Command =
  | { kind: "plan"; request: string }
  | { kind: "forget" }
  | { kind: "book" }
  | { kind: "approve" }
  | { kind: "payer" }
  | { kind: "vote"; option: number } // 1-based, as typed
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "ask"; question: string }
  | { kind: "none" };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the text mentions the agent ("@Tripchat" or "Tripchat"), and the text with the mention removed. */
export function findMention(text: string, agentName: string): { mentioned: boolean; body: string } {
  const normalized = text.replace(/[‘’]/g, "'").trim();
  const mention = new RegExp(`(^|\\s)@?${escapeRegExp(agentName)}\\b[,:]?`, "i");
  return {
    mentioned: mention.test(normalized),
    body: normalized.replace(mention, " ").replace(/\s+/g, " ").trim(),
  };
}

const VOTE = /^(?:i\s+)?(?:vote(?:\s+for)?|option|pick|go\s+with|choose)\s*#?\s*(\d)\b/;
const APPROVE = /^(?:i\s+)?approved?\b/;
const APPROVE_ONLY = /^(?:i\s+)?approved?[.!]*$/;

/**
 * Parse one chat message. In group chats the agent only acts when mentioned,
 * with two exceptions while a step is waiting on the group: "vote 2" during
 * voting and a bare "approve" while collecting shares.
 */
export function parseCommand(
  text: string,
  opts: { agentName: string; requireMention: boolean; phase: Phase },
): Command {
  const { mentioned, body } = findMention(text, opts.agentName);
  const lower = body.toLowerCase().replace(/[?!.]+$/, "");

  const vote = lower.match(VOTE);
  if (vote && (mentioned || opts.phase === "voting")) return { kind: "vote", option: Number(vote[1]) };
  if (opts.phase === "collecting" && (mentioned ? APPROVE.test(lower) : APPROVE_ONLY.test(lower))) {
    return { kind: "approve" };
  }

  if (!mentioned && opts.requireMention) return { kind: "none" };
  if (lower === "") return { kind: "help" };
  if (/^(?:forget|wipe|delete)\b/.test(lower)) return { kind: "forget" };
  if (/^(?:book|confirm|lock it in)\b/.test(lower)) return { kind: "book" };
  if (/^(?:i'?ll pay|i will pay|i can pay|i'?m paying|i'?ll be the payer|i'?m the payer)\b/.test(lower)) {
    return { kind: "payer" };
  }
  if (/^(?:status|where are we)\b/.test(lower)) return { kind: "status" };
  if (/^help\b/.test(lower)) return { kind: "help" };
  if (/^plan\b|\bplan (?:it|a trip|the trip|something)\b/.test(lower)) return { kind: "plan", request: body };
  return { kind: "ask", question: body };
}
