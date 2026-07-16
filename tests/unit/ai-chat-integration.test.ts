import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moderation: vi.fn(async () => false),
  streamClaude: vi.fn(),
  limitAiChat: vi.fn(async () => ({
    success: true,
    reset: Date.now() + 60_000,
    limit: 30,
    remaining: 29,
  })),
  messageFindMany: vi.fn(async () => []),
  messageCreate: vi.fn(async () => ({})),
  conversationUpdate: vi.fn(async () => ({})),
  recordUsage: vi.fn(async () => undefined),
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "MEMBER",
    locale: "EN",
  })),
}));
vi.mock("@/server/auth/permissions", () => ({ can: vi.fn(() => true) }));
vi.mock("@/server/integrations/redis", () => ({ limitAiChat: mocks.limitAiChat }));
vi.mock("@/server/integrations/openai", () => ({ isFlaggedByModeration: mocks.moderation }));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: mocks.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    conversation: {
      findFirst: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", model: null })),
      create: vi.fn(),
    },
  })),
  unscopedPrisma: {
    message: { findMany: mocks.messageFindMany, create: mocks.messageCreate },
    organization: { findUniqueOrThrow: vi.fn(async () => ({ name: "Acme", settings: {} })) },
    conversation: { update: mocks.conversationUpdate },
  },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: vi.fn(() => ({ model: "claude-sonnet-4-5", maxTokens: 4096 })),
}));
vi.mock("@/server/ai/prompts/system", () => ({ buildSystemPrompt: vi.fn(() => "system") }));
vi.mock("@/server/ai/rag", () => ({
  retrieveChunks: vi.fn(async () => []),
  extractValidCitations: vi.fn(() => []),
}));
vi.mock("@/server/ai/tools", () => ({
  anthropicToolsFor: vi.fn(() => []),
  executeTool: vi.fn(),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => undefined),
  getMonthUsage: vi.fn(async () => 0),
  recordUsage: mocks.recordUsage,
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => "Earlier context"),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

import { POST } from "@/app/api/v1/ai/chat/route";

describe("AI chat route integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moderation.mockResolvedValue(false);
    mocks.limitAiChat.mockResolvedValue({
      success: true,
      reset: Date.now() + 60_000,
      limit: 30,
      remaining: 29,
    });
    mocks.streamClaude.mockImplementation(async ({ callbacks }) => {
      callbacks.onText("A safe streamed answer");
      return { tokensIn: 1_000, tokensOut: 500, stopReason: "end_turn" };
    });
  });

  it("moderates both sides, streams SSE, and persists token cost", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: "33333333-3333-4333-8333-333333333333",
          message: "Hello",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"text"');
    expect(body).toContain('"estimatedCostUsd":0.0105');
    expect(mocks.moderation).toHaveBeenCalledTimes(2);
    expect(mocks.limitAiChat).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(mocks.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          estimatedCostUsd: 0.0105,
          tokensIn: 1_000,
          tokensOut: 500,
        }),
      }),
    );
    expect(mocks.streamClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        system: expect.stringContaining("Earlier context"),
      }),
    );
  });

  it("blocks an unsafe input before model invocation", async () => {
    mocks.moderation.mockResolvedValueOnce(true);
    const response = await POST(
      new Request("http://localhost/api/v1/ai/chat", {
        method: "POST",
        body: JSON.stringify({ message: "unsafe" }),
      }),
    );
    expect(response.status).toBe(422);
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("never releases or stores an unsafe model output", async () => {
    mocks.moderation.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const response = await POST(
      new Request("http://localhost/api/v1/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          conversationId: "33333333-3333-4333-8333-333333333333",
          message: "Hello",
        }),
      }),
    );
    const body = await response.text();
    expect(body).toContain('"type":"error","code":"content_flagged"');
    expect(body).not.toContain("A safe streamed answer");
    expect(mocks.messageCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ASSISTANT" }) }),
    );
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.any(String),
      "AI_TOKENS_OUT",
      500,
      expect.objectContaining({ blockedByModeration: true }),
    );
  });
});
