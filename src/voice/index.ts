import { z } from "zod";
import { config } from "../config";
import { log } from "../log";
import { sameHandle } from "../members";

export interface CallRequest {
  to: string;
  hotelName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  guestCount: number;
  /** Name the reservation is held under. */
  guestName: string;
  maxNightlyUsd: number;
  specialRequests: string[];
  /** Stable per booking attempt; reused on retries so the call is not placed twice. */
  idempotencyKey: string;
}

export interface CallOutcome {
  status: "booked" | "failed" | "needs_input";
  confirmation?: string;
  quotedTotalUsd?: number;
  /** One or two sentences for the group chat. */
  summary: string;
}

export interface VoiceProvider {
  readonly name: string;
  /** Resolves when the call has ended and its outcome is known. */
  placeCall(req: CallRequest): Promise<CallOutcome>;
}

export class CallNotAllowedError extends Error {
  constructor() {
    super("number is not in CALL_ALLOWLIST");
    this.name = "CallNotAllowedError";
  }
}

function assertAllowed(to: string): void {
  if (!config.callAllowlist.some((n) => sameHandle(n, to))) throw new CallNotAllowedError();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulated front desk for development and as a demo fallback. */
class MockVoice implements VoiceProvider {
  readonly name = "mock";

  async placeCall(req: CallRequest): Promise<CallOutcome> {
    await sleep(config.MOCK_CALL_DELAY_MS);
    const quoted = Math.round(req.maxNightlyUsd * req.nights * req.rooms);
    switch (config.MOCK_CALL_OUTCOME) {
      case "needs_input":
        return {
          status: "needs_input",
          summary: `${req.hotelName} only has ${Math.max(1, req.rooms - 1)} room(s) open for those dates. They can add a suite for about $40 more per night.`,
        };
      case "failed":
        return { status: "failed", summary: `${req.hotelName} is fully booked for those dates.` };
      default:
        return {
          status: "booked",
          confirmation: `TC-${Math.floor(100000 + Math.random() * 900000)}`,
          quotedTotalUsd: quoted,
          summary: `${req.hotelName} is holding ${req.rooms} room(s) under ${req.guestName}, pay at the property.`,
        };
    }
  }
}

// Retell AI: https://docs.retellai.com/api-references/create-phone-call and /get-call.
// The agent (RETELL_AGENT_ID) is configured in the Retell dashboard with the
// prompt in docs/voice-agent.md and these post-call analysis fields:
//   booked (boolean), confirmation_number (string), quoted_total_usd (number),
//   needs_group_input (boolean), notes (string).
const RETELL_API = "https://api.retellai.com";

const retellCallSchema = z
  .object({
    call_id: z.string(),
    call_status: z.enum(["registered", "not_connected", "ongoing", "ended", "error"]),
    disconnection_reason: z.string().optional().nullable(),
    call_analysis: z
      .object({
        call_summary: z.string().optional().nullable(),
        call_successful: z.boolean().optional().nullable(),
        custom_analysis_data: z.record(z.string(), z.unknown()).optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

class RetellVoice implements VoiceProvider {
  readonly name = "retell";

  private async api(method: "GET" | "POST", path: string, body?: unknown): Promise<z.infer<typeof retellCallSchema>> {
    const res = await fetch(`${RETELL_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.RETELL_API_KEY}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Retell ${res.status} on ${path}: ${text.slice(0, 300)}`);
    return retellCallSchema.parse(JSON.parse(text));
  }

  async placeCall(req: CallRequest): Promise<CallOutcome> {
    const created = await this.api("POST", "/v2/create-phone-call", {
      from_number: config.RETELL_FROM_NUMBER,
      to_number: req.to,
      override_agent_id: config.RETELL_AGENT_ID,
      idempotency_key: req.idempotencyKey,
      retell_llm_dynamic_variables: {
        hotel_name: req.hotelName,
        guest_name: req.guestName,
        check_in: req.checkIn,
        check_out: req.checkOut,
        nights: String(req.nights),
        rooms: String(req.rooms),
        guest_count: String(req.guestCount),
        max_nightly_usd: String(req.maxNightlyUsd),
        special_requests: req.specialRequests.length > 0 ? req.specialRequests.join("; ") : "none",
      },
    });
    log.info("call_started", { provider: this.name, callId: created.call_id });

    const deadline = Date.now() + 15 * 60 * 1000;
    let call = created;
    while (call.call_status === "registered" || call.call_status === "ongoing") {
      if (Date.now() > deadline) return { status: "failed", summary: "The call ran past 15 minutes, so I stopped waiting." };
      await sleep(5000);
      call = await this.api("GET", `/v2/get-call/${encodeURIComponent(created.call_id)}`);
    }
    if (call.call_status !== "ended") {
      return { status: "failed", summary: `The call didn't connect (${call.disconnection_reason ?? call.call_status}).` };
    }

    // Post-call analysis can land a few seconds after the call ends.
    for (let i = 0; i < 12 && !call.call_analysis; i++) {
      await sleep(5000);
      call = await this.api("GET", `/v2/get-call/${encodeURIComponent(created.call_id)}`);
    }
    const data = call.call_analysis?.custom_analysis_data ?? {};
    const summary = call.call_analysis?.call_summary ?? "The call ended.";
    const notes = typeof data.notes === "string" && data.notes ? data.notes : summary;
    if (data.needs_group_input === true) return { status: "needs_input", summary: notes };
    if (data.booked === true) {
      return {
        status: "booked",
        confirmation: typeof data.confirmation_number === "string" ? data.confirmation_number : undefined,
        quotedTotalUsd: typeof data.quoted_total_usd === "number" ? data.quoted_total_usd : undefined,
        summary: notes,
      };
    }
    return { status: "failed", summary: notes };
  }
}

let provider: VoiceProvider | undefined;

export function getVoice(): VoiceProvider {
  provider ??= config.VOICE_PROVIDER === "retell" ? new RetellVoice() : new MockVoice();
  return provider;
}

export async function placeReservationCall(req: CallRequest): Promise<CallOutcome> {
  const voice = getVoice();
  // The mock never dials anyone; every real provider is limited to the allowlist.
  if (voice.name !== "mock") assertAllowed(req.to);
  return voice.placeCall(req);
}
