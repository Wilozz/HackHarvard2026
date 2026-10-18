import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../config";

// The SDK reads ANTHROPIC_API_KEY (or an `ant auth login` profile).
const client = new Anthropic();

// On a safety-classifier decline the API re-runs the request on Anthropic's
// recommended fallback model instead of returning a refusal.
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
};

type Effort = "low" | "medium" | "high";

/** The server-side refusal fallback, for models that support it (Haiku has none). */
function fallbackFor(model: string) {
  return /haiku/i.test(model) ? {} : FALLBACK;
}

/** A JPEG to show Claude, with a short label ("Image 1, sent by Harsh"). */
export interface LlmImage {
  label: string;
  data: Buffer;
}

/** The user turn: each image after its label, then the text. Plain text when there are no images. */
function userContent(text: string, images: LlmImage[] = []): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (images.length === 0) return text;
  return [
    ...images.flatMap((img): Anthropic.Beta.BetaContentBlockParam[] => [
      { type: "text", text: img.label },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.data.toString("base64") } },
    ]),
    { type: "text", text },
  ];
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

function checkStop(stopReason: string | null): void {
  if (stopReason === "refusal") throw new LlmError("model declined the request");
  if (stopReason === "max_tokens") throw new LlmError("response hit max_tokens");
}

/** One request whose reply is validated against a Zod schema. */
export async function structured<S extends z.ZodType>(args: {
  system: string;
  user: string;
  schema: S;
  effort: Effort;
  images?: LlmImage[];
  model?: string;
}): Promise<z.infer<S>> {
  const model = args.model ?? config.CLAUDE_MODEL;
  const res = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    ...fallbackFor(model),
    system: args.system,
    messages: [{ role: "user", content: userContent(args.user, args.images) }],
    output_config: { effort: args.effort, format: betaZodOutputFormat(args.schema) },
  });
  checkStop(res.stop_reason);
  if (res.parsed_output == null) throw new LlmError("reply did not match the schema");
  return res.parsed_output as z.infer<S>;
}

/** One request with a plain-text reply. */
export async function complete(args: { system: string; user: string; effort: Effort; model?: string; images?: LlmImage[] }): Promise<string> {
  const model = args.model ?? config.CLAUDE_MODEL;
  const res = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...fallbackFor(model),
    system: args.system,
    messages: [{ role: "user", content: userContent(args.user, args.images) }],
    output_config: { effort: args.effort },
  });
  checkStop(res.stop_reason);
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new LlmError("empty reply");
  return text;
}

/**
 * A long plain-text reply (a whole generated app), streamed so a large
 * max_tokens can't hit the HTTP timeout. Only the final text is returned.
 */
export async function streamText(args: { system: string; user: string; effort: Effort; maxTokens?: number; images?: LlmImage[]; model?: string }): Promise<string> {
  const model = args.model ?? config.CLAUDE_MODEL;
  const stream = client.beta.messages.stream({
    model,
    max_tokens: args.maxTokens ?? 64000,
    ...fallbackFor(model),
    system: args.system,
    messages: [{ role: "user", content: userContent(args.user, args.images) }],
    output_config: { effort: args.effort },
  });
  const res = await stream.finalMessage();
  checkStop(res.stop_reason);
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new LlmError("empty reply");
  return text;
}
