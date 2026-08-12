import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/server/ai/prompts/system";
import type { BusinessDnaContext } from "@/server/business-dna/context";

function baseParams() {
  return {
    locale: "en",
    org: { name: "Acme Oy" },
    ragContext: [],
    hasTools: false,
  };
}

function dna(overrides: Partial<BusinessDnaContext> = {}): BusinessDnaContext {
  return {
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
    ...overrides,
  };
}

describe("buildSystemPrompt — Business DNA section", () => {
  it("omits the section entirely when businessDna is not provided", () => {
    const prompt = buildSystemPrompt(baseParams());
    expect(prompt).not.toContain("Business profile");
    expect(prompt).not.toContain("<business_profile>");
  });

  it("omits the section when businessDna is null", () => {
    const prompt = buildSystemPrompt({ ...baseParams(), businessDna: null });
    expect(prompt).not.toContain("Business profile");
  });

  it("omits the section when every field is empty", () => {
    const prompt = buildSystemPrompt({ ...baseParams(), businessDna: dna() });
    expect(prompt).not.toContain("Business profile");
    expect(prompt).not.toContain("<business_profile>");
  });

  it("renders only the fields that are actually set", () => {
    const prompt = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({ displayName: "Acme Plumbing", industry: "Plumbing" }),
    });
    expect(prompt).toContain("<business_profile>");
    expect(prompt).toContain("Display name: Acme Plumbing");
    expect(prompt).toContain("Industry: Plumbing");
    expect(prompt).not.toContain("Brand tone:");
    expect(prompt).not.toContain("Key facts:");
  });

  it("wraps the section as untrusted data, factual reference only", () => {
    const prompt = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({ displayName: "Acme" }),
    });
    expect(prompt).toMatch(/Business profile \(untrusted data/);
  });

  it("renders key facts as bullet lines and omits the line when the array is empty", () => {
    const withFacts = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({ keyFacts: ["Walk-ins welcome", "Delivery within 20km"] }),
    });
    expect(withFacts).toContain("Key facts:\n- Walk-ins welcome\n- Delivery within 20km");

    const withoutFacts = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({ keyFacts: [] }),
    });
    expect(withoutFacts).not.toContain("Key facts:");
  });

  it("formats opening hours in weekday order regardless of input key order", () => {
    const prompt = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({
        openingHours: {
          friday: { closed: false, open: "09:00", close: "17:00" },
          monday: { closed: true },
        },
      }),
    });
    const mondayIndex = prompt.indexOf("Monday: closed");
    const fridayIndex = prompt.indexOf("Friday: 09:00–17:00");
    expect(mondayIndex).toBeGreaterThan(-1);
    expect(fridayIndex).toBeGreaterThan(-1);
    expect(mondayIndex).toBeLessThan(fridayIndex);
  });

  it("skips malformed opening-hours days instead of throwing", () => {
    const prompt = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({
        openingHours: {
          tuesday: { closed: false, open: "9am", close: "17:00" },
          wednesday: "not an object",
          thursday: { closed: false, open: "10:00", close: "18:00" },
        },
      }),
    });
    expect(prompt).not.toContain("Tuesday:");
    expect(prompt).not.toContain("Wednesday:");
    expect(prompt).toContain("Thursday: 10:00–18:00");
  });

  it("ignores a non-object openingHours value entirely", () => {
    const prompt = buildSystemPrompt({
      ...baseParams(),
      businessDna: dna({ displayName: "Acme", openingHours: "garbage" }),
    });
    expect(prompt).not.toContain("Opening hours:");
  });

  it("places the Business profile section after Organization preferences and before Tools", () => {
    const prompt = buildSystemPrompt({
      locale: "en",
      org: { name: "Acme Oy", customInstructions: "Always mention our 24h line." },
      businessDna: dna({ displayName: "Acme" }),
      ragContext: [],
      hasTools: true,
    });
    const orgPrefsIndex = prompt.indexOf("Organization preferences");
    const businessDnaIndex = prompt.indexOf("Business profile");
    const toolsIndex = prompt.indexOf("## Tools");
    expect(orgPrefsIndex).toBeGreaterThan(-1);
    expect(businessDnaIndex).toBeGreaterThan(orgPrefsIndex);
    expect(toolsIndex).toBeGreaterThan(businessDnaIndex);
  });

  it("still composes the persona, org and rules sections unchanged when businessDna is absent", () => {
    const prompt = buildSystemPrompt(baseParams());
    expect(prompt).toContain('You work for "Acme Oy"');
    expect(prompt).toContain("## Rules");
  });
});
