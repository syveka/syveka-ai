import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getVapiEnv } from "@/env";

const VAPI_BASE = "https://api.vapi.ai";

async function vapiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { VAPI_API_KEY } = getVapiEnv();
  const res = await fetch(`${VAPI_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Vapi ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 500)}`);
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
  return {
    name: cfg.name,
    firstMessage: cfg.firstMessage,
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [{ role: "system", content: cfg.systemPrompt }],
      tools: cfg.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
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
    server: { url: cfg.serverUrl, credentialId: cfg.serverCredentialId },
    maxDurationSeconds: cfg.maxDurationSeconds,
    recordingEnabled: true,
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

export async function deleteVapiAssistant(id: string): Promise<void> {
  await vapiFetch(`/assistant/${id}`, { method: "DELETE" });
}

export async function buyPhoneNumber(assistantId: string): Promise<{ id: string; number: string }> {
  return vapiFetch("/phone-number", {
    method: "POST",
    body: JSON.stringify({ provider: "vapi", assistantId, numberDesiredAreaCode: "358" }),
  });
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
