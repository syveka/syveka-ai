import { beforeEach, describe, expect, it, vi } from "vitest";

// Ensures no paid external call ever happens in CI/tests (Phase 22/26):
// streamClaude is fully mocked, never hitting the real Anthropic API.
const { streamClaudeMock } = vi.hoisted(() => ({ streamClaudeMock: vi.fn() }));

vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: streamClaudeMock }));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 512 }),
}));

import { ClaudeCaptionProvider } from "@/server/ai/creator/caption-provider";

function mockStreamedText(text: string) {
  streamClaudeMock.mockImplementation(
    async ({ callbacks }: { callbacks: { onText: (d: string) => void } }) => {
      callbacks.onText(text);
      return { tokensIn: 10, tokensOut: 20, stopReason: "end_turn" };
    },
  );
}

describe("ClaudeCaptionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a well-formed JSON caption response", async () => {
    mockStreamedText(
      JSON.stringify({
        primary: "Discover our new collection.",
        short: "New collection!",
        cta: "Shop now",
        hashtags: ["#new", "#collection"],
      }),
    );

    const provider = new ClaudeCaptionProvider();
    const result = await provider.generateCaption({ platform: "INSTAGRAM", language: "EN" });

    expect(result.primary).toBe("Discover our new collection.");
    expect(result.hashtags).toEqual(["#new", "#collection"]);
    expect(result.providerRequestId).toMatch(/^anthropic_/);
  });

  it("tolerates surrounding prose around the JSON object", async () => {
    mockStreamedText(
      `Here you go:\n${JSON.stringify({ primary: "p", short: "s", cta: "c", hashtags: [] })}\nEnjoy!`,
    );

    const provider = new ClaudeCaptionProvider();
    const result = await provider.generateCaption({ platform: "TIKTOK", language: "FI" });
    expect(result.primary).toBe("p");
  });

  it("throws on a response with no JSON object at all", async () => {
    mockStreamedText("Sorry, I can't help with that.");

    const provider = new ClaudeCaptionProvider();
    await expect(
      provider.generateCaption({ platform: "INSTAGRAM", language: "EN" }),
    ).rejects.toThrow();
  });

  it("throws when the JSON is missing required fields", async () => {
    mockStreamedText(JSON.stringify({ primary: "only this" }));

    const provider = new ClaudeCaptionProvider();
    await expect(
      provider.generateCaption({ platform: "INSTAGRAM", language: "EN" }),
    ).rejects.toThrow();
  });

  it("never calls the real network client — only the mocked streamClaude", async () => {
    mockStreamedText(JSON.stringify({ primary: "p", short: "s", cta: "c", hashtags: [] }));
    const provider = new ClaudeCaptionProvider();
    await provider.generateCaption({ platform: "INSTAGRAM", language: "EN" });
    expect(streamClaudeMock).toHaveBeenCalledTimes(1);
  });
});
