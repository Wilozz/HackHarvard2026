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
}): Promise<z.infer<S>> {
  const res = await client.beta.messages.parse({
    model: config.CLAUDE_MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    system: args.system,
    messages: [{ role: "user", content: args.user }],
    output_config: { effort: args.effort, format: betaZodOutputFormat(args.schema) },
  });
  checkStop(res.stop_reason);
  if (res.parsed_output == null) throw new LlmError("reply did not match the schema");
  return res.parsed_output as z.infer<S>;
}

/** One request with a plain-text reply. */
export async function complete(args: { system: string; user: string; effort: Effort }): Promise<string> {
  const res = await client.beta.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    system: args.system,
    messages: [{ role: "user", content: args.user }],
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
