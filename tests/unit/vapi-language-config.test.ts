import { describe, expect, it } from "vitest";
import { toVapiPayload, type VapiAssistantConfig } from "@/server/integrations/vapi";

function baseConfig(overrides: Partial<VapiAssistantConfig> = {}): VapiAssistantConfig {
  return {
    name: "Fruppi Assistant",
    firstMessage: "Hei!",
    systemPrompt: "You are a helpful assistant.",
    language: "fi",
    voiceProvider: "azure",
    voiceId: null,
    serverUrl: "https://staging.invalid/api/v1/voice/webhook",
    serverCredentialId: "cred-1",
    tools: [],
    maxDurationSeconds: 900,
    ...overrides,
  };
}

describe("toVapiPayload — Vapi-accepted model ID", () => {
  // Regression for the 2026-09-15 production incident: Vapi's POST /assistant
  // rejected model.model with a 400 because vapi.ts hardcoded a model string
  // ("claude-sonnet-4-5") that isn't in Vapi's own accepted-model allowlist.
  // Vapi's error response explicitly confirmed "claude-haiku-4-5-20251001" as
  // accepted -- the exact string the voice route already used elsewhere in
  // src/server/ai/router.ts. The fix sources vapi.ts's model from that same
  // canonical router instead of a second, independently-drifting literal.
  it("sends the canonical voice-route model id, not a stale duplicate literal", () => {
    const payload = toVapiPayload(baseConfig());
    expect((payload.model as { model: string }).model).toBe("claude-haiku-4-5-20251001");
    expect((payload.model as { provider: string }).provider).toBe("anthropic");
  });

  it("is unaffected by language or voice provider (model id is language/voice-independent)", () => {
    for (const language of ["fi", "en", "ar"] as const) {
      const payload = toVapiPayload(baseConfig({ language, voiceProvider: "elevenlabs" }));
      expect((payload.model as { model: string }).model).toBe("claude-haiku-4-5-20251001");
    }
  });
});

describe("toVapiPayload — per-language transcriber/voice selection", () => {
  it("Finnish: nova-2 transcriber, Selma voice (unchanged default)", () => {
    const payload = toVapiPayload(baseConfig({ language: "fi" }));
    expect(payload.transcriber).toEqual({ provider: "deepgram", model: "nova-2", language: "fi" });
    expect(payload.voice).toEqual({ provider: "azure", voiceId: "fi-FI-SelmaNeural" });
  });

  it("English: nova-2 transcriber, Jenny voice (unchanged default)", () => {
    const payload = toVapiPayload(baseConfig({ language: "en" }));
    expect(payload.transcriber).toEqual({ provider: "deepgram", model: "nova-2", language: "en" });
    expect(payload.voice).toEqual({ provider: "azure", voiceId: "en-US-JennyNeural" });
  });

  it("Arabic: nova-3 transcriber (nova-2 has no Arabic support), Arabic Azure voice — not the English fallback", () => {
    const payload = toVapiPayload(baseConfig({ language: "ar" }));
    expect(payload.transcriber).toEqual({ provider: "deepgram", model: "nova-3", language: "ar" });
    expect(payload.voice).toEqual({ provider: "azure", voiceId: "ar-SA-ZariyahNeural" });
    // The bug this regression test targets: Arabic must never fall through
    // to an English-only voice, since en-US-JennyNeural cannot speak Arabic.
    expect((payload.voice as { voiceId: string }).voiceId).not.toBe("en-US-JennyNeural");
  });

  it("an explicit voiceId always overrides the per-language default, for every language", () => {
    for (const language of ["fi", "en", "ar"] as const) {
      const payload = toVapiPayload(baseConfig({ language, voiceId: "custom-voice-id" }));
      expect(payload.voice).toEqual({ provider: "azure", voiceId: "custom-voice-id" });
    }
  });

  it("elevenlabs provider is unaffected by the per-language Azure defaults", () => {
    const payload = toVapiPayload(
      baseConfig({ language: "ar", voiceProvider: "elevenlabs", voiceId: "el-voice-1" }),
    );
    expect(payload.voice).toEqual({ provider: "11labs", voiceId: "el-voice-1" });
    // Transcriber selection is independent of TTS provider.
    expect(payload.transcriber).toEqual({ provider: "deepgram", model: "nova-3", language: "ar" });
  });
});
