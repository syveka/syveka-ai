import { afterEach, describe, expect, it, vi } from "vitest";
import { isChatTranscriptionEnabled } from "@/env";

/** Voice input is opt-in (paid provider calls) and must fail closed, never throw. */
afterEach(() => vi.unstubAllEnvs());

describe("isChatTranscriptionEnabled", () => {
  it('is off unless the flag is exactly "1"', () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      vi.stubEnv("AI_TRANSCRIPTION_ENABLED", value as string);
      expect(isChatTranscriptionEnabled()).toBe(false);
    }
    vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "1");
    expect(isChatTranscriptionEnabled()).toBe(true);
  });

  it("stays off, without throwing, when the OpenAI key is missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SKIP_ENV_VALIDATION", "");
    vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => isChatTranscriptionEnabled()).not.toThrow();
    expect(isChatTranscriptionEnabled()).toBe(false);
  });
});
