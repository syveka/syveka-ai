import { describe, expect, it } from "vitest";
import { buildVoiceSystemPrompt } from "@/server/ai/prompts/voice";

const disclosure = "Start by disclosing that you are an AI assistant and the call may be recorded.";

describe("buildVoiceSystemPrompt", () => {
  it("falls back to just the disclosure and human-authored prompt when Business DNA is absent", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: null,
      assistantSystemPrompt: "You are a helpful receptionist.",
      transferNumber: null,
    });
    expect(result).toBe(`${disclosure}\n\nYou are a helpful receptionist.`);
    expect(result).not.toContain("business_profile");
  });

  it("includes the Business DNA block, wrapped as untrusted data, when present", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: {
        displayName: "Acme Bakery",
        industry: "Bakery",
        productsServices: "Custom cakes",
        supportedLocales: ["EN", "FI"],
        brandTone: "Warm",
        communicationStyle: null,
        openingHours: null,
        policies: "No refunds after pickup",
        pricingNotes: null,
        targetCustomer: null,
        keyFacts: ["Open since 1995"],
      },
      assistantSystemPrompt: "You are a helpful receptionist.",
      transferNumber: null,
    });
    expect(result).toContain("<business_profile>");
    expect(result).toContain("Acme Bakery");
    expect(result).toContain("No refunds after pickup");
    expect(result).toContain("Open since 1995");
    expect(result).toContain("EN, FI");
    expect(result).toContain("untrusted data");
    // The Business DNA block must come before the human-authored prompt.
    expect(result.indexOf("business_profile")).toBeLessThan(
      result.indexOf("You are a helpful receptionist."),
    );
  });

  it("never fabricates a field Business DNA left null", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: {
        displayName: "Acme Bakery",
        industry: null,
        productsServices: null,
        supportedLocales: [],
        brandTone: null,
        communicationStyle: null,
        openingHours: null,
        policies: null,
        pricingNotes: null,
        targetCustomer: null,
        keyFacts: [],
      },
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).toContain("Display name: Acme Bakery");
    expect(result).not.toContain("Industry:");
    expect(result).not.toContain("Policies:");
    expect(result).not.toContain("Key facts:");
  });

  it("omits the Business DNA block entirely when every field is empty", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: {
        displayName: null,
        industry: null,
        productsServices: null,
        supportedLocales: [],
        brandTone: null,
        communicationStyle: null,
        openingHours: null,
        policies: null,
        pricingNotes: null,
        targetCustomer: null,
        keyFacts: [],
      },
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).toBe(`${disclosure}\n\nPrompt.`);
  });

  it("formats well-formed opening hours and silently skips malformed days", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: {
        displayName: null,
        industry: null,
        productsServices: null,
        supportedLocales: [],
        brandTone: null,
        communicationStyle: null,
        openingHours: {
          monday: { closed: false, open: "09:00", close: "17:00" },
          tuesday: { closed: true },
          wednesday: { closed: false, open: "not-a-time", close: "17:00" },
          notADay: { closed: false, open: "10:00", close: "12:00" },
        },
        policies: null,
        pricingNotes: null,
        targetCustomer: null,
        keyFacts: [],
      },
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).toContain("Monday: 09:00–17:00");
    expect(result).toContain("Tuesday: closed");
    expect(result).not.toContain("Wednesday:");
    expect(result).not.toContain("notADay");
  });

  it("silently ignores a malformed (non-object) openingHours value", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: {
        displayName: "Acme",
        industry: null,
        productsServices: null,
        supportedLocales: [],
        brandTone: null,
        communicationStyle: null,
        openingHours: "not an object",
        policies: null,
        pricingNotes: null,
        targetCustomer: null,
        keyFacts: [],
      },
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).not.toContain("Opening hours:");
  });

  it("appends the transfer-number instruction last, after the human-authored prompt", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: null,
      assistantSystemPrompt: "Prompt.",
      transferNumber: "+358401234567",
    });
    expect(result).toBe(
      `${disclosure}\n\nPrompt.\n\nIf the caller asks for a human, transfer the call to +358401234567.`,
    );
  });
});
