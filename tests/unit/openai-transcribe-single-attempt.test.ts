import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pilot rule: one paid provider attempt per reserved request. The OpenAI SDK
 * is mocked (no network); the test proves transcribeAudio neither wraps the
 * call in the app's retry helper nor lets the SDK retry.
 */
const create = vi.hoisted(() => vi.fn());
const clientOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("openai", () => {
  class OpenAI {
    audio = { transcriptions: { create } };
    constructor(options: unknown) {
      clientOptions.push(options);
    }
  }
  return {
    default: OpenAI,
    toFile: vi.fn(async (data: unknown, name: string) => ({ data, name })),
  };
});

import { TRANSCRIPTION_MODEL, transcribeAudio } from "@/server/integrations/openai";

beforeEach(() => {
  create.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("AI_RETRY_MAX_ATTEMPTS", "3");
});

describe("transcribeAudio", () => {
  it("makes exactly one provider call when it fails (retryable status included)", async () => {
    create.mockRejectedValue(Object.assign(new Error("server error"), { status: 503 }));
    await expect(transcribeAudio(new Uint8Array(8), "webm")).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({ maxRetries: 0 });
    expect(clientOptions.at(-1)).toMatchObject({ maxRetries: 0 });
  });

  it("returns the trimmed transcript from a single call", async () => {
    create.mockResolvedValue({ text: "  hei maailma " });
    expect(await transcribeAudio(new Uint8Array(8), "mp4")).toBe("hei maailma");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ model: TRANSCRIPTION_MODEL });
  });
});
