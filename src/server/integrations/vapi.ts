import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

const VAPI_BASE = "https://api.vapi.ai";

async function vapiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.VAPI_API_KEY}`,
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
  serverUrlSecret: string;
  tools: Array<{ name: string; description: string; parameters: object }>;
  maxDurationSeconds: number;
};

function toVapiPayload(cfg: VapiAssistantConfig) {
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
        : {
            provider: "azure",
            voiceId:
              cfg.voiceId ?? (cfg.language === "fi" ? "fi-FI-SelmaNeural" : "en-US-JennyNeural"),
          },
    transcriber: { provider: "deepgram", model: "nova-2", language: cfg.language },
    server: { url: cfg.serverUrl, secret: cfg.serverUrlSecret },
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
  const expected = createHmac("sha256", env.VAPI_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
