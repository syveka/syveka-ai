import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getVapiEnv } from "@/env";
import { routeModel } from "@/server/ai/router";

const VAPI_BASE = "https://api.vapi.ai";

/**
 * Conservative, single-attempt timeout for every Vapi API call -- matches
 * the established pattern in src/server/security/url-ingestion.ts
 * (URL_FETCH_TIMEOUT_MS). Without this, a hung Vapi request blocked the
 * calling server action/webhook handler until the platform's own function
 * timeout, with no distinguishable error. This never retries -- a timeout
 * surfaces as a single, immediate, descriptive failure through the exact
 * same catch paths (activateAssistantAction, attachPhoneNumberAction) that
 * already turn any vapiFetch error into a controlled, non-leaking state; it
 * does not change idempotency or duplicate-provisioning behavior, since
 * vapiFetch itself never retried and callers already handle "did the write
 * actually happen" via their own idempotent-retry design (syncToVapi's
 * persist-immediately-on-success, attachPhoneNumber's lock-protected
 * re-check) rather than by trusting this call to resolve quickly.
 */
export const VAPI_FETCH_TIMEOUT_MS = 20_000;

/** A Vapi API error with its status, so a caller can tell "no such call" from an outage. */
export class VapiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "VapiHttpError";
  }
}

/**
 * Vapi doesn't retry a failed webhook unless told to. Client errors won't improve on a
 * retry. Anything lost after these attempts is recovered by the reconcile-voice-calls job.
 */
const WEBHOOK_BACKOFF_PLAN = {
  type: "exponential",
  maxRetries: 3,
  baseDelaySeconds: 2,
  excludedStatusCodes: [400, 401, 403, 404, 409],
} as const;

async function vapiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { VAPI_API_KEY } = getVapiEnv();
  let res: Response;
  try {
    res = await fetch(`${VAPI_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(VAPI_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `Vapi ${init?.method ?? "GET"} ${path} timed out after ${VAPI_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VapiHttpError(
      `Vapi ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 500)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/** Our VoiceAssistant row → Vapi assistant payload (§16.2). */
export type VapiAssistantConfig = {
  name: string;
  firstMessage: string;
  systemPrompt: string;
  language: "fi" | "en" | "ar";
  voiceProvider: string;
  voiceId?: string | null;
  serverUrl: string; // our webhook
  /** ID of a Vapi Custom Credential (HMAC) — never the secret value itself (§13.2). */
  serverCredentialId: string;
  tools: Array<{ name: string; description: string; parameters: object }>;
  /** Human-provided E.164 destination for Vapi's built-in transferCall tool. */
  transferNumber: string | null;
  maxDurationSeconds: number;
};

/**
 * Azure neural voice fallback per language (used only when no explicit
 * `voiceId` is configured). Arabic has its own entry rather than falling
 * through to the English default — `en-US-JennyNeural` cannot speak Arabic
 * text.
 */
const DEFAULT_AZURE_VOICE: Record<VapiAssistantConfig["language"], string> = {
  fi: "fi-FI-SelmaNeural",
  en: "en-US-JennyNeural",
  ar: "ar-SA-ZariyahNeural",
};

/**
 * Deepgram transcriber model per language. Nova-2 does not support Arabic
 * at all (Deepgram's own docs list its supported languages, and Arabic is
 * absent) — Arabic calls need the dedicated Nova-3 Arabic model instead.
 * Finnish and English stay on the already-verified nova-2 default.
 */
const DEEPGRAM_MODEL: Record<VapiAssistantConfig["language"], string> = {
  fi: "nova-2",
  en: "nova-2",
  ar: "nova-3",
};

/** Exported for direct unit testing of the per-language voice/transcriber selection. */
export function toVapiPayload(cfg: VapiAssistantConfig) {
  const tools: Array<Record<string, unknown>> = cfg.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  // Existing rows predate strict validation and may use the UI's former
  // human-friendly formatting. Normalize those safely at the provider boundary;
  // an invalid legacy value must not make the entire assistant sync fail.
  const transferNumber = cfg.transferNumber?.replace(/[\s().-]/g, "");
  if (transferNumber && /^\+[1-9]\d{1,14}$/.test(transferNumber)) {
    tools.push({
      type: "transferCall",
      destinations: [
        {
          type: "number",
          number: transferNumber,
          description: "Transfer to a human when the caller explicitly asks to speak with one.",
        },
      ],
    });
  }

  return {
    name: cfg.name,
    firstMessage: cfg.firstMessage,
    // The first message carries the mandatory AI and recording notice
    // (buildVoiceFirstMessage), so it is always spoken first and in full, never
    // replaced by a model-generated opening or cut off by the caller. Both are
    // Vapi's documented defaults; sending them keeps a dashboard edit from
    // turning the notice off, since every sync re-applies them.
    firstMessageMode: "assistant-speaks-first",
    firstMessageInterruptionsEnabled: false,
    model: {
      provider: "anthropic",
      // Sourced from the canonical model router, not a second hardcoded
      // literal -- a stale duplicate here is exactly what caused Vapi to
      // reject POST /assistant in production on 2026-09-15 (§ incident).
      model: routeModel("voice").model,
      messages: [{ role: "system", content: cfg.systemPrompt }],
      tools,
    },
    voice:
      cfg.voiceProvider === "elevenlabs"
        ? { provider: "11labs", voiceId: cfg.voiceId ?? "" }
        : { provider: "azure", voiceId: cfg.voiceId ?? DEFAULT_AZURE_VOICE[cfg.language] },
    transcriber: {
      provider: "deepgram",
      model: DEEPGRAM_MODEL[cfg.language],
      language: cfg.language,
    },
    // Custom Credential reference, not the legacy inline `server.secret` — Vapi
    // resolves the actual HMAC key server-side from the credential (§13.2).
    server: {
      url: cfg.serverUrl,
      credentialId: cfg.serverCredentialId,
      backoffPlan: WEBHOOK_BACKOFF_PLAN,
    },
    // Refusing a call relies on Live Call Control, so a sync restores it if it was changed.
    monitorPlan: { controlEnabled: true, controlAuthenticationEnabled: false },
    maxDurationSeconds: cfg.maxDurationSeconds,
    // Recording isn't set here. Syveka has no recording setting of its own, so a sync must not
    // override a choice made in Vapi's dashboard. Left unset on a new assistant, Vapi's default
    // applies. Whether calls are recorded is a pending legal decision, and the spoken notice
    // doesn't depend on it.
  };
}

export async function upsertVapiAssistant(
  cfg: VapiAssistantConfig,
  existingId?: string | null,
): Promise<{ id: string }> {
  if (existingId) {
    return vapiFetch(`/assistant/${existingId}`, {
      method: "PATCH",
      body: JSON.stringify(toVapiPayload(cfg)),
    });
  }
  return vapiFetch("/assistant", { method: "POST", body: JSON.stringify(toVapiPayload(cfg)) });
}

/** One call as Vapi has it. Read-only; the caller validates the untrusted shape. */
export async function getVapiCall(id: string, signal?: AbortSignal): Promise<unknown> {
  return vapiFetch(`/call/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
}

/** An assistant's recent calls, newest first. Read-only; the caller validates the shape. */
export async function listVapiCalls(
  assistantId: string,
  createdAtGe: Date,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const query = new URLSearchParams({
    assistantId,
    createdAtGe: createdAtGe.toISOString(),
    limit: "100",
  });
  const calls = await vapiFetch<unknown>(
    `/call?${query.toString()}`,
    signal ? { signal } : undefined,
  );
  // An unexpected shape is an outage to report, not "this assistant had no calls".
  if (!Array.isArray(calls)) throw new Error("Unexpected Vapi call list");
  return calls;
}

/** The assistant as Vapi holds it now, including anything changed in its dashboard. */
export async function getVapiAssistant(
  id: string,
  signal?: AbortSignal,
): Promise<{
  firstMessage?: string | null;
  firstMessageMode?: string | null;
  firstMessageInterruptionsEnabled?: boolean | null;
}> {
  return vapiFetch(`/assistant/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
}

export async function deleteVapiAssistant(id: string): Promise<void> {
  await vapiFetch(`/assistant/${id}`, { method: "DELETE" });
}

export async function buyPhoneNumber(assistantId: string): Promise<{ id: string; number: string }> {
  return vapiFetch("/phone-number", {
    method: "POST",
    body: JSON.stringify({ provider: "vapi", assistantId, numberDesiredAreaCode: "358" }),
  });
}

/**
 * Import a number the org already holds with an external carrier, instead of
 * buying one from Vapi's own (US/Canada-only) pool -- the only route to a
 * real +358 or other non-US/CA number today. Twilio credentials are used
 * only for this one request and are never persisted by any caller of this
 * function (see attachPhoneNumber() in server/services/voice.ts).
 */
export type PhoneImportParams =
  | {
      provider: "twilio";
      phoneNumber: string;
      twilioAccountSid: string;
      twilioAuthToken: string;
    }
  | {
      provider: "byo-phone-number";
      phoneNumber: string;
      sipUri: string;
    };

export async function importPhoneNumber(
  assistantId: string,
  params: PhoneImportParams,
): Promise<{ id: string; number: string }> {
  const body =
    params.provider === "twilio"
      ? {
          provider: "twilio",
          assistantId,
          number: params.phoneNumber,
          twilioAccountSid: params.twilioAccountSid,
          twilioAuthToken: params.twilioAuthToken,
        }
      : {
          provider: "byo-phone-number",
          assistantId,
          number: params.phoneNumber,
          credentialId: params.sipUri,
        };
  return vapiFetch("/phone-number", { method: "POST", body: JSON.stringify(body) });
}

/** HMAC verification for inbound Vapi webhooks (§13.2). */
export function verifyVapiSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const { VAPI_WEBHOOK_SECRET } = getVapiEnv();
  const expected = createHmac("sha256", VAPI_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
