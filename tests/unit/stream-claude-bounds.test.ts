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

  it("after cancellation no new model call or tool call starts; completed usage is reported", async () => {
    const controller = new AbortController();
    const twoTools = {
      ...toolUseMessage,
      content: [
        { type: "tool_use", id: "t1", name: "searchContacts", input: {} },
        { type: "tool_use", id: "t2", name: "searchContacts", input: {} },
      ],
    };
    m.stream.mockImplementation(() => ok(twoTools));
    const onUsage = vi.fn();
    const onToolUse = vi.fn(async () => {
      controller.abort(); // the user presses End while the first tool runs
      return "{}";
    });
    await expect(
      streamClaude({
        model: "claude-sonnet-4-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 400,
        callbacks: { onText: vi.fn(), onToolUse, onUsage },
        signal: controller.signal,
        maxToolRounds: 2,
      }),
    ).rejects.toThrow(/abort/i);
    expect(m.stream).toHaveBeenCalledTimes(1); // no second model call
    expect(onToolUse).toHaveBeenCalledTimes(1); // the second tool never ran
    expect(onUsage).toHaveBeenCalledWith(100, 10); // the billed first call is reported
  });

  it("beforeModelCall sees the full request before EVERY call; throwing prevents that call", async () => {
    m.stream.mockImplementation(() => ok(toolUseMessage));
    const seen: number[] = [];
    const beforeModelCall = vi.fn((request: { messages: unknown[] }) => {
      seen.push(request.messages.length);
      if (seen.length === 2) throw new Error("over budget");
    });
    await expect(
      streamClaude({
        model: "claude-sonnet-4-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 400,
        callbacks: { onText: vi.fn(), onToolUse: vi.fn(async () => "{}") },
        maxToolRounds: 2,
        beforeModelCall,
      }),
    ).rejects.toThrow("over budget");
    // Call 1: the user message; call 2 would add the tool request and its result.
    expect(seen).toEqual([1, 3]);
    expect(m.stream).toHaveBeenCalledTimes(1);
  });

  it("an already-cancelled request makes no model call", async () => {
    const controller = new AbortController();
    controller.abort();
    m.stream.mockImplementation(() => ok(toolUseMessage));
    await expect(
      streamClaude({
        model: "claude-sonnet-4-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 400,
        callbacks: { onText: vi.fn() },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(m.stream).not.toHaveBeenCalled();
  });

  it("without maxAttempts, the configured retries still apply (typed chat unchanged)", async () => {
    m.stream.mockImplementation(fail);
    await expect(run()).rejects.toThrow("overloaded");
    expect(m.stream).toHaveBeenCalledTimes(3);
  });
});
