import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-response bounds in streamClaude: live voice passes maxToolRounds and
 * maxAttempts; typed chat keeps the defaults. Mocked: the Anthropic SDK stream.
 */
const m = vi.hoisted(() => ({ stream: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  getAnthropicEnv: () => ({
    ANTHROPIC_API_KEY: "test",
    AI_RETRY_MAX_ATTEMPTS: 3,
    AI_RETRY_BASE_DELAY_MS: 0,
  }),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: m.stream };
  },
}));

import { streamClaude } from "@/server/integrations/anthropic";

const toolUseMessage = {
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 10 },
  content: [{ type: "tool_use", id: "t1", name: "searchContacts", input: {} }],
};
const ok = (message: unknown) => ({ on: vi.fn(), finalMessage: async () => message });
const fail = () => ({
  on: vi.fn(),
  finalMessage: async () => {
    throw Object.assign(new Error("overloaded"), { status: 529 });
  },
});

const run = (extra: { maxToolRounds?: number; maxAttempts?: number } = {}) =>
  streamClaude({
    model: "claude-sonnet-4-5",
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 400,
    callbacks: { onText: vi.fn(), onToolUse: vi.fn(async () => "{}") },
    ...extra,
  });

beforeEach(() => m.stream.mockReset());

describe("streamClaude bounds", () => {
  it("stops after maxToolRounds model calls even if the model keeps calling tools", async () => {
    m.stream.mockImplementation(() => ok(toolUseMessage));
    const result = await run({ maxToolRounds: 2 });
    expect(m.stream).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ tokensIn: 200, tokensOut: 20, stopReason: "max_tool_rounds" });
    expect(m.stream.mock.calls[0]![0]).toMatchObject({ max_tokens: 400 });
  });

  it("defaults to 5 rounds (typed chat unchanged)", async () => {
    m.stream.mockImplementation(() => ok(toolUseMessage));
    await run();
    expect(m.stream).toHaveBeenCalledTimes(5);
  });

  it("maxAttempts 1: a transient provider error is not retried", async () => {
    m.stream.mockImplementation(fail);
    await expect(run({ maxAttempts: 1 })).rejects.toThrow("overloaded");
    expect(m.stream).toHaveBeenCalledTimes(1);
  });

  it("without maxAttempts, the configured retries still apply (typed chat unchanged)", async () => {
    m.stream.mockImplementation(fail);
    await expect(run()).rejects.toThrow("overloaded");
    expect(m.stream).toHaveBeenCalledTimes(3);
  });
});
