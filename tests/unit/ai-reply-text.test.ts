import { describe, expect, it, vi } from "vitest";
import { replyText } from "@/server/ai/reply-text";
import { routeModel } from "@/server/ai/router";
import { toVapiPayload, type VapiAssistantConfig } from "@/server/integrations/vapi";

/**
 * Mock-only readiness checks for Haiku 5.5. Nothing here calls a model, and no route has been
 * switched. Reply shapes follow Anthropic's published migration guide.
 */
const thinking = { type: "thinking", thinking: "…", signature: "sig" };

describe("reading a model's reply", () => {
  it("reads a plain text reply, as Haiku 4.5 sends it", () => {
    expect(replyText([{ type: "text", text: "Hei" }])).toBe("Hei");
  });

  it("isn't fooled by a thinking block first", () => {
    expect(replyText([thinking, { type: "text", text: '{"summary":"ok"}' }])).toBe(
      '{"summary":"ok"}',
    );
  });

  it("joins several text blocks, and skips what isn't text", () => {
    expect(
      replyText([{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }]),
    ).toBe("ab");
  });

  it("is empty, not undefined, with no text: a refusal or a thinking-only reply", () => {
    expect(replyText([])).toBe("");
    expect(replyText([thinking])).toBe("");
  });

  it("ignores a malformed text block", () => {
    expect(replyText([{ type: "text" }])).toBe("");
  });
});

describe("the voice model", () => {
  it("is still Haiku 4.5: no switch has been made", () => {
    expect(routeModel("voice").model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("what Syveka sends Vapi, for a future Haiku 5.5 test", () => {
  const config: VapiAssistantConfig = {
    name: "Test",
    firstMessage: "Hei",
    systemPrompt: "Test",
    language: "fi",
    voiceProvider: "azure",
    voiceId: null,
    serverUrl: "https://staging.invalid/webhook",
    serverCredentialId: "cred-1",
    tools: [],
    transferNumber: null,
    maxDurationSeconds: 900,
  };

  it("sets none of the parameters Haiku 5.5 refuses", () => {
    const { model } = toVapiPayload(config);
    // Anthropic refuses these on Haiku 5.5. This pins only what Syveka sends: whether Vapi
    // adds its own default temperature is unknown, and needs a real, approved test.
    expect(model).not.toHaveProperty("temperature");
    expect(model).not.toHaveProperty("thinking");
    expect(model).not.toHaveProperty("topP");
    expect(model).not.toHaveProperty("topK");
  });

  it("takes the model id from the router, so a switch is one reviewed line", async () => {
    vi.resetModules();
    vi.doMock("@/server/ai/router", () => ({
      routeModel: () => ({ provider: "anthropic", model: "claude-haiku-5-5", maxTokens: 1024 }),
    }));
    const { toVapiPayload: payload } = await import("@/server/integrations/vapi");
    expect(payload(config).model.model).toBe("claude-haiku-5-5");
    vi.doUnmock("@/server/ai/router");
    vi.resetModules();
  });
});
