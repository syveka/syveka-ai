import { describe, expect, it } from "vitest";
import { buildVoiceSystemPrompt } from "@/server/ai/prompts/voice";
import {
  BUSINESS_FACT_RULES,
  NO_BUSINESS_PROFILE_NOTE,
  type BusinessDnaContext,
} from "@/server/business-dna/context";

const disclosure = "Start by disclosing that you are an AI assistant and the call may be recorded.";

function dna(overrides: Partial<BusinessDnaContext> = {}): BusinessDnaContext {
  return {
    displayName: null,
    industry: null,
    description: null,
    productsServices: null,
    supportedLocales: [],
    timezone: null,
    brandTone: null,
    communicationStyle: null,
    responseInstructions: null,
    openingHours: null,
    cancellationPolicy: null,
    bookingPolicy: null,
    refundPolicy: null,
    paymentPolicy: null,
    otherPolicies: null,
    currency: null,
    quoteInstructions: null,
    pricingNotes: null,
    targetCustomer: null,
    keyFacts: [],
    services: [],
    ...overrides,
  };
}

describe("buildVoiceSystemPrompt", () => {
  it("says there is no business profile, and keeps the human-authored prompt, when Business DNA is absent", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: null,
      assistantSystemPrompt: "You are a helpful receptionist.",
      transferNumber: null,
    });
    expect(
      result.startsWith(
        `${disclosure}\n\n${NO_BUSINESS_PROFILE_NOTE}\n\nYou are a helpful receptionist.`,
      ),
    ).toBe(true);
    expect(result).not.toContain("business_profile");
    expect(result).toContain(BUSINESS_FACT_RULES);
  });

  it("includes the Business DNA block, wrapped as untrusted data, when present", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: dna({
        displayName: "Acme Bakery",
        industry: "Bakery",
        productsServices: "Custom cakes",
        supportedLocales: ["EN", "FI"],
        brandTone: "Warm",
        otherPolicies: "No refunds after pickup",
        keyFacts: ["Open since 1995"],
      }),
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
      businessDna: dna({ displayName: "Acme Bakery" }),
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).toContain("Display name: Acme Bakery");
    expect(result).not.toContain("Industry:");
    expect(result).not.toContain("Other policies:");
    expect(result).not.toContain("Key facts:");
  });

  it("treats a profile with every field empty as no profile", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: dna(),
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).not.toContain("<business_profile>");
    expect(result).toContain(NO_BUSINESS_PROFILE_NOTE);
  });

  it("formats well-formed opening hours and silently skips malformed days", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: dna({
        openingHours: {
          monday: { closed: false, open: "09:00", close: "17:00" },
          tuesday: { closed: true },
          wednesday: { closed: false, open: "not-a-time", close: "17:00" },
          notADay: { closed: false, open: "10:00", close: "12:00" },
        },
      }),
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
      businessDna: dna({ displayName: "Acme", openingHours: "not an object" }),
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result).not.toContain("Opening hours:");
  });

  it("ends with the shared business-fact rules, then the ways of reaching a person", () => {
    const result = buildVoiceSystemPrompt({
      disclosure,
      businessDna: dna({ displayName: "Acme Bakery" }),
      assistantSystemPrompt: "Prompt.",
      transferNumber: null,
    });
    expect(result.indexOf("Prompt.")).toBeLessThan(result.indexOf(BUSINESS_FACT_RULES));
    expect(result.indexOf(BUSINESS_FACT_RULES)).toBeLessThan(
      result.indexOf("## Reaching a person"),
    );
  });
});

describe("buildVoiceSystemPrompt — reaching a person", () => {
  function prompt(transferNumber: string | null) {
    return buildVoiceSystemPrompt({
      disclosure,
      businessDna: null,
      assistantSystemPrompt: "Prompt.",
      transferNumber,
    });
  }

  it("offers a transfer with the transferCall tool when a valid number is configured", () => {
    const result = prompt("+358401234567");
    expect(result).toContain("use the transferCall tool to transfer the call to +358401234567");
    expect(result).toContain("If the transfer does not go through, say so honestly.");
    expect(result).not.toContain("You cannot transfer this call");
  });

  it("offers the same normalized number Vapi's transferCall tool gets for a legacy formatted value", () => {
    expect(prompt("+358 40 123-4567")).toContain("transfer the call to +358401234567");
  });

  it("offers no transfer when the stored number can't become a transferCall tool", () => {
    for (const stored of ["040 1234567", "not a number", ""]) {
      const result = prompt(stored);
      expect(result).toContain("You cannot transfer this call");
      expect(result).not.toContain("transferCall");
      expect(result).not.toContain("transfer the call to");
    }
  });

  it("without a transfer, points only to a contact method the business profile states", () => {
    const result = prompt(null);
    expect(result).toContain("You cannot transfer this call");
    expect(result).toContain(
      "If the business profile states a phone number, email or other way to reach the business, give it",
    );
    expect(result).toContain("say you can't confirm how to reach the team");
  });

  it("never offers or promises a callback, with or without a transfer", () => {
    for (const transferNumber of ["+358401234567", null]) {
      const result = prompt(transferNumber);
      expect(result).toContain("this assistant has no way to pass a callback request to the team");
      expect(result).toContain("don't ask for the caller's name or number for one");
      expect(result).toContain("never say that someone will call back");
      expect(result).toContain(
        "Never promise that someone will follow up, reply or call back unless a tool in this conversation recorded that request and reported success.",
      );
    }
  });
});
