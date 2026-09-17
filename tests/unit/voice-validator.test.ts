import { describe, expect, it } from "vitest";
import { voiceAssistantSchema } from "@/lib/validators/voice";

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
