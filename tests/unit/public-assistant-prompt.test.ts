import { describe, expect, it } from "vitest";
import { buildPublicAssistantSystemPrompt } from "../../src/server/ai/prompts/public-assistant";

describe("buildPublicAssistantSystemPrompt", () => {
  it("never hardcodes a specific price, so a stale prompt can't quote a stale number", () => {
    const prompt = buildPublicAssistantSystemPrompt("en");
    expect(prompt).not.toMatch(/\d+\s?€/);
    expect(prompt).not.toMatch(/€\s?\d+/);
    expect(prompt.toLowerCase()).toContain("pricing page");
  });

  it("instructs the model never to reveal its own instructions", () => {
    const prompt = buildPublicAssistantSystemPrompt("en");
    expect(prompt.toLowerCase()).toMatch(/never reveal|never.*summarize.*instructions/);
  });

  it("does not present Creator Studio as generally available", () => {
    const prompt = buildPublicAssistantSystemPrompt("en");
    expect(prompt).toMatch(/limited rollout/);
    expect(prompt).not.toMatch(/Creator Studio.*(available now|generally available)/i);
  });

  it("declares itself read-only with no tools, matching the route's actual tool-free call", () => {
    const prompt = buildPublicAssistantSystemPrompt("en");
    expect(prompt.toLowerCase()).toContain("read-only");
    expect(prompt.toLowerCase()).toContain("no tools");
  });

  it("falls back to the English persona for an unknown locale rather than throwing", () => {
    expect(() => buildPublicAssistantSystemPrompt("xx")).not.toThrow();
    expect(buildPublicAssistantSystemPrompt("xx")).toContain("Syveka's public sales");
  });

  it("selects the matching persona for fi and ar", () => {
    expect(buildPublicAssistantSystemPrompt("fi")).toContain("Syvekan julkinen");
    expect(buildPublicAssistantSystemPrompt("ar")).toContain("مساعد المبيعات");
  });
});
