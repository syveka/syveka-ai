import { describe, expect, it } from "vitest";
import { allowedVoiceTools, voiceAssistantSchema } from "@/lib/validators/voice";

const baseInput = {
  name: "Front desk",
  language: "FI" as const,
  voiceProvider: "azure" as const,
  firstMessage: "Hei!",
  systemPrompt: "You are the company front desk.",
  enabledTools: [],
  useKnowledgeBase: false,
};

describe("voiceAssistantSchema transfer destination", () => {
  it("accepts an empty destination so human transfer stays disabled", () => {
    expect(voiceAssistantSchema.safeParse({ ...baseInput, transferNumber: "" }).success).toBe(true);
  });

  it("accepts a canonical E.164 destination", () => {
    expect(
      voiceAssistantSchema.safeParse({ ...baseInput, transferNumber: "+358401234567" }).success,
    ).toBe(true);
  });

  it("normalizes the previously advertised human-friendly format to canonical E.164", () => {
    const parsed = voiceAssistantSchema.safeParse({
      ...baseInput,
      transferNumber: "+358 (40) 123-4567",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.transferNumber).toBe("+358401234567");
  });

  it("rejects a destination that cannot be normalized to E.164", () => {
    expect(
      voiceAssistantSchema.safeParse({ ...baseInput, transferNumber: "040 123 4567" }).success,
    ).toBe(false);
  });
});

describe("voice assistant tools exposed to anonymous callers", () => {
  it("cannot enable CRM contact search on a phone assistant", () => {
    expect(
      voiceAssistantSchema.safeParse({ ...baseInput, enabledTools: ["searchContacts"] }).success,
    ).toBe(false);
  });

  it("drops tools that are no longer allowed from an assistant's stored list", () => {
    expect(allowedVoiceTools(["searchContacts", "bookMeeting", 7])).toEqual(["bookMeeting"]);
  });

  it("cannot enable the organization's knowledge base on a phone assistant", () => {
    expect(
      voiceAssistantSchema.safeParse({ ...baseInput, enabledTools: ["searchKnowledgeBase"] })
        .success,
    ).toBe(false);
  });

  it("a new assistant gets no knowledge-base access by default", () => {
    const parsed = voiceAssistantSchema.parse({
      name: baseInput.name,
      firstMessage: baseInput.firstMessage,
      systemPrompt: baseInput.systemPrompt,
    });

    expect(parsed.enabledTools).toEqual([]);
    expect(parsed.useKnowledgeBase).toBe(false);
    expect(allowedVoiceTools(parsed.enabledTools)).not.toContain("searchKnowledgeBase");
  });

  it("an existing assistant that stored knowledge-base access no longer gets it", () => {
    // The previous defaults: enabledTools ["searchKnowledgeBase"], useKnowledgeBase true.
    expect(allowedVoiceTools(["searchKnowledgeBase", "createContact"])).toEqual(["createContact"]);
  });

  it("missing or malformed stored settings allow nothing", () => {
    expect(allowedVoiceTools(null)).toEqual([]);
    expect(allowedVoiceTools(undefined)).toEqual([]);
    expect(allowedVoiceTools("searchKnowledgeBase")).toEqual([]);
    expect(allowedVoiceTools({ 0: "searchKnowledgeBase" })).toEqual([]);
  });
});
