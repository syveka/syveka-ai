import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/server/ai/prompts/system";

const base = {
  locale: "fi",
  org: { name: "Acme" },
  businessDna: null,
  ragContext: [],
  hasTools: true,
};

describe("buildSystemPrompt response mode", () => {
  it("adds spoken-reply guidance only in voice mode", () => {
    const voice = buildSystemPrompt({ ...base, responseMode: "voice" });
    expect(voice).toContain("## Spoken conversation");
    expect(voice).toContain("Do not use markdown");
  });

  it("leaves the text-chat prompt unchanged by default", () => {
    const withoutMode = buildSystemPrompt(base);
    expect(withoutMode).not.toContain("## Spoken conversation");
    expect(buildSystemPrompt({ ...base, responseMode: "text" })).toBe(withoutMode);
  });

  it("keeps tools and platform rules in voice mode, with rules last", () => {
    const voice = buildSystemPrompt({ ...base, responseMode: "voice" });
    expect(voice).toContain("## Tools");
    expect(voice.indexOf("## Spoken conversation")).toBeLessThan(voice.indexOf("## Rules"));
    expect(voice.trimEnd().endsWith("professional verification.")).toBe(true);
  });
});
