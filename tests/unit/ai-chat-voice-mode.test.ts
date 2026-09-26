import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Voice mode is not a separate backend: each spoken turn is a normal
 * `/api/v1/ai/chat` request with `responseMode: "voice"`. These tests prove
 * that path keeps every guarantee of text chat — server-derived tenant,
 * permission gate, rate limit, per-user conversation scoping — and that the
 * only thing voice changes is the reply style in the system prompt.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const ORG_B = "99999999-9999-4999-8999-999999999999";

const mocks = vi.hoisted(() => ({
  getTenantContext: vi.fn(),
  can: vi.fn(() => true),
  limitAiChat: vi.fn(),
  moderation: vi.fn(async () => false),
  streamClaude: vi.fn(),
  tenantDb: vi.fn(),
  conversationFindFirst: vi.fn(),
  getBusinessDnaContext: vi.fn(async () => null),
  retrieveChunks: vi.fn(async () => []),
  anthropicToolsFor: vi.fn(() => []),
  assertWithinLimit: vi.fn(async () => undefined),
  messageCreate: vi.fn(async () => ({})),
  EntitlementError: class EntitlementError extends Error {
    code = "entitlement_exceeded";
    limit = 100;
  },
}));

vi.mock("@/server/auth/session", () => ({ getTenantContext: mocks.getTenantContext }));
vi.mock("@/server/auth/permissions", () => ({ can: mocks.can }));
vi.mock("@/server/integrations/redis", () => ({ limitAiChat: mocks.limitAiChat }));
vi.mock("@/server/integrations/openai", () => ({ isFlaggedByModeration: mocks.moderation }));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: mocks.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {
    message: { findMany: vi.fn(async () => []), create: mocks.messageCreate },
    organization: { findUniqueOrThrow: vi.fn(async () => ({ name: "Acme", settings: {} })) },
    conversation: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: vi.fn(() => ({ model: "claude-sonnet-4-5", maxTokens: 4096 })),
}));
vi.mock("@/server/ai/prompts/system", () => ({ buildSystemPrompt: vi.fn(() => "system") }));
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: mocks.getBusinessDnaContext,
}));
vi.mock("@/server/ai/rag", () => ({
  retrieveChunks: mocks.retrieveChunks,
  extractValidCitations: vi.fn(() => []),
}));
vi.mock("@/server/ai/tools", () => ({
  anthropicToolsFor: mocks.anthropicToolsFor,
  executeTool: vi.fn(),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: mocks.assertWithinLimit,
  getMonthUsage: vi.fn(async () => 0),
  recordUsage: vi.fn(async () => undefined),
  EntitlementError: mocks.EntitlementError,
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => null),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

import { POST } from "@/app/api/v1/ai/chat/route";
import { buildSystemPrompt } from "@/server/ai/prompts/system";

function voiceRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What are our opening hours?", ...body }),
  });
}

describe("assistant voice mode — chat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantContext.mockResolvedValue({
      orgId: ORG_A,
      userId: USER_A,
      role: "MEMBER",
      locale: "fi",
    });
    mocks.can.mockReturnValue(true);
    mocks.limitAiChat.mockResolvedValue({
      success: true,
      reset: Date.now() + 60_000,
      limit: 30,
      remaining: 29,
    });
    mocks.moderation.mockResolvedValue(false);
    mocks.assertWithinLimit.mockResolvedValue(undefined);
    mocks.conversationFindFirst.mockResolvedValue({ id: CONVERSATION, model: null });
    mocks.tenantDb.mockImplementation(() => ({
      conversation: { findFirst: mocks.conversationFindFirst, create: vi.fn() },
    }));
    mocks.streamClaude.mockImplementation(async ({ callbacks }) => {
      callbacks.onText("We are open nine to five.");
      return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
    });
  });

  it("asks for a spoken reply style and streams the answer", async () => {
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("We are open nine to five.");
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: "voice" }),
    );
  });

  it("defaults existing text-chat clients to the text reply style", async () => {
    await (await POST(voiceRequest({ conversationId: CONVERSATION }))).text();
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: "text" }),
    );
  });

  it("uses the same tenant context (Business DNA, RAG, tools) as text chat, from the server session", async () => {
    await (
      await POST(voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }))
    ).text();
    expect(mocks.tenantDb).toHaveBeenCalledWith(ORG_A);
    expect(mocks.getBusinessDnaContext).toHaveBeenCalledWith(ORG_A);
    expect(mocks.retrieveChunks).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
    expect(mocks.anthropicToolsFor).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, userId: USER_A, role: "MEMBER" }),
    );
  });

  it("rejects a client-supplied organization id instead of trusting it", async () => {
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice", orgId: ORG_B }),
    );
    expect(response.status).toBe(400);
    expect(mocks.streamClaude).not.toHaveBeenCalled();
    expect(mocks.tenantDb).not.toHaveBeenCalledWith(ORG_B);
  });

  it("returns 401 for an unauthenticated voice turn", async () => {
    mocks.getTenantContext.mockRejectedValue(new Error("no session"));
    const response = await POST(voiceRequest({ responseMode: "voice" }));
    expect(response.status).toBe(401);
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("returns 403 when the role lacks chat:use", async () => {
    mocks.can.mockReturnValue(false);
    const response = await POST(voiceRequest({ responseMode: "voice" }));
    expect(response.status).toBe(403);
    expect(mocks.can).toHaveBeenCalledWith("MEMBER", "chat:use");
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("applies the same per-user/per-org rate limit as text chat", async () => {
    mocks.limitAiChat.mockResolvedValue({
      success: false,
      scope: "user",
      reset: Date.now() + 10_000,
      limit: 30,
      remaining: 0,
    });
    const response = await POST(voiceRequest({ responseMode: "voice" }));
    expect(response.status).toBe(429);
    expect(mocks.limitAiChat).toHaveBeenCalledWith(ORG_A, USER_A);
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("cannot continue another user's or another org's conversation", async () => {
    mocks.conversationFindFirst.mockResolvedValue(null);
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }),
    );
    expect(response.status).toBe(404);
    expect(mocks.tenantDb).toHaveBeenCalledWith(ORG_A);
    expect(mocks.conversationFindFirst).toHaveBeenCalledWith({
      where: { id: CONVERSATION, userId: USER_A, deletedAt: null },
    });
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("rejects an unknown response mode", async () => {
    const response = await POST(voiceRequest({ responseMode: "video" }));
    expect(response.status).toBe(400);
  });

  it("moderates the spoken transcript before any model call", async () => {
    mocks.moderation.mockResolvedValueOnce(true);
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }),
    );
    expect(response.status).toBe(422);
    expect(mocks.moderation).toHaveBeenCalledWith("What are our opening hours?", expect.anything());
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("never releases or stores a flagged reply that would otherwise be spoken", async () => {
    mocks.moderation.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }),
    );
    const body = await response.text();
    expect(body).toContain('"code":"content_flagged"');
    expect(body).not.toContain("We are open nine to five.");
    expect(mocks.messageCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ASSISTANT" }) }),
    );
  });

  it("enforces the same monthly AI quota as text chat", async () => {
    mocks.assertWithinLimit.mockRejectedValueOnce(new mocks.EntitlementError("quota"));
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }),
    );
    expect(response.status).toBe(402);
    expect(mocks.assertWithinLimit).toHaveBeenCalledWith(ORG_A, expect.anything());
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("never streams the system prompt or Business DNA to the browser", async () => {
    const { buildSystemPrompt: build } = await import("@/server/ai/prompts/system");
    vi.mocked(build).mockReturnValueOnce("SECRET-SYSTEM-PROMPT with BUSINESS-DNA-MARKER");
    const response = await POST(
      voiceRequest({ conversationId: CONVERSATION, responseMode: "voice" }),
    );
    const body = await response.text();
    expect(body).not.toContain("SECRET-SYSTEM-PROMPT");
    expect(body).not.toContain("BUSINESS-DNA-MARKER");
    expect(mocks.streamClaude).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining("SECRET-SYSTEM-PROMPT") }),
    );
  });
});
