import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A new conversation's first request carries no earlier messages: the route
 * creates the conversation through the tenant-scoped client for the session's
 * organization and loads history only by that conversation's id. A request
 * for another tenant's (or another user's) conversation finds nothing.
 * Synthetic in-memory store; data access and the model are mocked.
 */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "22222222-2222-4222-8222-222222222222";
const OLD_A = "33333333-3333-4333-8333-333333333333";
const OTHER_TENANT = "44444444-4444-4444-8444-444444444444";
const NEW_ID = "55555555-5555-4555-8555-555555555555";

const s = vi.hoisted(() => ({
  conversations: [] as Array<{ id: string; organizationId: string; userId: string }>,
  messages: [] as Array<{ conversationId: string; role: string; content: string }>,
  tenantOrgs: [] as string[],
  streamClaude: vi.fn(),
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
vi.mock("@/server/integrations/redis", () => ({
  limitAiChat: vi.fn(async () => ({
    success: true,
    reset: Date.now() + 60_000,
    limit: 30,
    remaining: 29,
  })),
}));
vi.mock("@/server/integrations/openai", () => ({
  isFlaggedByModeration: vi.fn(async () => false),
}));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: s.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  // The tenant client only ever sees its own organization's rows.
  tenantDb: vi.fn((orgId: string) => {
    s.tenantOrgs.push(orgId);
    return {
      conversation: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
          const row = s.conversations.find(
            (c) => c.organizationId === orgId && c.id === where.id && c.userId === where.userId,
          );
          return row ? { ...row, model: null, summary: null } : null;
        }),
        create: vi.fn(async ({ data }: { data: { organizationId: string; userId: string } }) => {
          const row = { id: "55555555-5555-4555-8555-555555555555", ...data };
          s.conversations.push(row);
          return { ...row, model: null, summary: null };
        }),
      },
    };
  }),
  unscopedPrisma: {
    message: {
      findMany: vi.fn(async ({ where }: { where: { conversationId: string } }) =>
        s.messages
          .filter((m) => m.conversationId === where.conversationId)
          .map((m) => ({ role: m.role, content: m.content })),
      ),
      create: vi.fn(async () => ({})),
    },
    organization: { findUniqueOrThrow: vi.fn(async () => ({ name: "Acme", settings: {} })) },
    conversation: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: vi.fn(() => ({ model: "claude-sonnet-4-5", maxTokens: 4096 })),
}));
vi.mock("@/server/business-dna/context", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBusinessDnaContext: vi.fn(async () => null),
}));
vi.mock("@/server/ai/rag", () => ({
  retrieveChunks: vi.fn(async () => []),
  extractValidCitations: vi.fn(() => []),
}));
vi.mock("@/server/ai/tools", () => ({
  anthropicToolsFor: vi.fn(() => []),
  executeTool: vi.fn(),
  READ_ONLY_TOOL_NAMES: [],
  WRITE_TOOL_NAMES: [],
}));
// The quota reservation (Redis) is covered by ai-chat-quota-reservation.test.ts.
vi.mock("@/server/services/billing/ai-message-reservation", () => ({
  reserveAiMessage: vi.fn(async () => ({ key: "reservation", id: "r1", inFlightAhead: 0 })),
  releaseAiMessage: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => undefined),
  getMonthUsage: vi.fn(async () => 0),
  recordUsage: vi.fn(async () => undefined),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => ""),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

import { POST } from "@/app/api/v1/ai/chat/route";

function chat(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** What the model was sent, as role/content pairs. */
const modelMessages = () =>
  (s.streamClaude.mock.calls.at(-1)![0] as { messages: Array<{ role: string; content: unknown }> })
    .messages;

beforeEach(() => {
  vi.clearAllMocks();
  s.tenantOrgs = [];
  s.conversations = [
    { id: OLD_A, organizationId: ORG_A, userId: USER },
    { id: OTHER_TENANT, organizationId: ORG_B, userId: USER },
  ];
  s.messages = [
    { conversationId: OLD_A, role: "USER", content: "Earlier question in A" },
    { conversationId: OLD_A, role: "ASSISTANT", content: "Earlier answer in A" },
    { conversationId: OTHER_TENANT, role: "USER", content: "Tenant B secret" },
  ];
  s.streamClaude.mockImplementation(async ({ callbacks }) => {
    callbacks.onText("ok");
    return { tokensIn: 1, tokensOut: 1, stopReason: "end_turn" };
  });
});

describe("chat route: a new conversation starts without history", () => {
  it("creates the conversation in the session's tenant and sends only the new message", async () => {
    const response = await chat({ message: "Fresh question" });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain(`"conversationId":"${NEW_ID}"`);

    expect(s.tenantOrgs).toEqual([ORG_A]);
    expect(s.conversations.find((c) => c.id === NEW_ID)).toMatchObject({
      organizationId: ORG_A,
      userId: USER,
    });
    expect(modelMessages()).toEqual([{ role: "user", content: "Fresh question" }]);
    const sent = JSON.stringify(modelMessages());
    expect(sent).not.toContain("Earlier");
    expect(sent).not.toContain("Tenant B secret");
  });

  it("an existing conversation still gets its own history, and only its own", async () => {
    const response = await chat({ conversationId: OLD_A, message: "Follow-up" });
    expect(response.status).toBe(200);
    await response.text();
    const sent = JSON.stringify(modelMessages());
    expect(sent).toContain("Earlier question in A");
    expect(sent).not.toContain("Tenant B secret");
  });

  it("another tenant's conversation id is not found and nothing reaches the model", async () => {
    const response = await chat({ conversationId: OTHER_TENANT, message: "Leak?" });
    expect(response.status).toBe(404);
    expect(s.streamClaude).not.toHaveBeenCalled();
  });
});
