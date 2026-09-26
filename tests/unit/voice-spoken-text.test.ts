import { describe, expect, it } from "vitest";
import { speechLangFor, splitForSpeech, toSpokenText } from "@/lib/voice/spoken-text";

describe("toSpokenText", () => {
  it("drops citation markers, markdown and URLs that would be read aloud literally", () => {
    const reply =
      "## Hours\n- **Mon–Fri** 9–17 [doc:abc-123]\n- See [our site](https://example.com) or https://x.test/a\n`code` and *soft* emphasis";
    expect(toSpokenText(reply)).toBe(
      "Hours\nMon–Fri 9–17\nSee our site or\ncode and soft emphasis",
    );
  });

  it("removes fenced code blocks entirely", () => {
    expect(toSpokenText("Before\n```ts\nconst x = 1;\n```\nAfter")).toBe("Before\nAfter");
  });

  it("keeps Finnish and Arabic text intact", () => {
    expect(toSpokenText("Olemme **auki** klo 9–17.")).toBe("Olemme auki klo 9–17.");
    expect(toSpokenText("نحن **مفتوحون** من ٩ إلى ٥.")).toBe("نحن مفتوحون من ٩ إلى ٥.");
  });
});

describe("splitForSpeech", () => {
  it("keeps short text as one utterance", () => {
    expect(splitForSpeech("Hello there. How can I help?")).toEqual([
      "Hello there. How can I help?",
    ]);
  });

  it("splits long replies at sentence boundaries under the max length", () => {
    const sentence = "This is a fairly ordinary sentence for testing.";
    const chunks = splitForSpeech(Array(10).fill(sentence).join(" "), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join(" ")).toBe(Array(10).fill(sentence).join(" "));
  });

  it("hard-splits a single sentence longer than the max length", () => {
    const chunks = splitForSpeech("a".repeat(250), 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("returns no utterances for empty text", () => {
    expect(splitForSpeech("   ")).toEqual([]);
  });
});

describe("speechLangFor", () => {
  it("maps each supported app locale to a speech language", () => {
    expect(speechLangFor("fi")).toBe("fi-FI");
    expect(speechLangFor("en")).toBe("en-US");
    expect(speechLangFor("ar")).toBe("ar-SA");
    expect(speechLangFor("FI")).toBe("fi-FI");
  });

  it("falls back to English for an unknown locale", () => {
    expect(speechLangFor("xx")).toBe("en-US");
  });
});
