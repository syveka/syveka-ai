import { describe, expect, it, vi } from "vitest";
import { estimateAiCost, estimateAiCostUsd } from "@/server/ai/cost";
import { isTransientAiError, retryDelayMs, withAiRetry } from "@/server/ai/retry";

describe("AI retry policy", () => {
  it("retries transient provider failures with exponential backoff", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("limited"), { status: 429 }))
      .mockResolvedValue("ok");

    await expect(
      withAiRetry(operation, { maxAttempts: 3, baseDelayMs: 0, random: () => 0 }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent or aborted failures", async () => {
    expect(isTransientAiError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(
      false,
    );
    expect(isTransientAiError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(retryDelayMs(3, 100, () => 0)).toBe(300);
  });
});

describe("AI cost estimation", () => {
  it("estimates prompt and completion cost using the routed model family", () => {
    expect(estimateAiCostUsd("claude-sonnet-4-5", { tokensIn: 1_000, tokensOut: 500 })).toBe(
      0.0105,
    );
    expect(estimateAiCost("claude-sonnet-4-5", { tokensIn: 1_000, tokensOut: 500 })).toEqual({
      promptUsd: 0.003,
      completionUsd: 0.0075,
      totalUsd: 0.0105,
    });
  });
});
