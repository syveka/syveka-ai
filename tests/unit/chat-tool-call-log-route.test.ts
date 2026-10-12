import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat route saves, with the reply, which read-only tools ran and -- for
 * an availability lookup -- the requested date, slot count and hours flag,
 * but never the tool's result. Only data access and the model are mocked.
 */
const m = vi.hoisted(() => ({
  streamClaude: vi.fn(),
  executeTool: vi.fn(),
  messageCreate: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})),
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
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: m.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    conversation: {
      findFirst: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", model: null })),
      create: vi.fn(),
    },
  })),
  unscopedPrisma: {
    message: { findMany: vi.fn(async () => []), create: m.messageCreate },
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
  anthropicToolsFor: vi.fn(() => [{ name: "getCalendarAvailability" }]),
  executeTool: m.executeTool,
  READ_ONLY_TOOL_NAMES: ["getCalendarAvailability", "searchContacts"],
  WRITE_TOOL_NAMES: [],
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

const AVAILABILITY_RESULT = JSON.stringify({
  date: "2026-10-19",
  timezone: "Europe/Helsinki",
  durationMinutes: 30,
  freeSlotCount: 15,
  freeSlots: ["2026-10-19T06:00:00.000Z"],
  localTimes: ["09:00"],
  moreSlotsAvailable: false,
  usingOrgConfiguredHours: false,
});

/** Runs one chat turn in which the model calls the given tools, and returns the saved toolCalls. */
async function savedToolCalls(calls: Array<[string, unknown]>): Promise<unknown> {
  m.streamClaude.mockImplementation(async ({ callbacks }) => {
    for (const [name, input] of calls) await callbacks.onToolUse(name, input);
    callbacks.onText("ok");
    return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
  });
  const response = await POST(
    new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "33333333-3333-4333-8333-333333333333",
        message: "What times am I free on October 19, 2026?",
      }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
  const assistant = m.messageCreate.mock.calls
    .map(([args]) => args.data)
    .find((d) => d.role === "ASSISTANT");
  return assistant?.toolCalls;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.executeTool.mockImplementation(async (_id: unknown, name: string) =>
    name === "getCalendarAvailability"
      ? AVAILABILITY_RESULT
      : '[{"id":"c1","email":"jane@example.com"}]',
  );
});

describe("chat route: saved tool calls", () => {
  it("G: an availability lookup saves its date, slot count and hours flag, not its result", async () => {
    const toolCalls = await savedToolCalls([["getCalendarAvailability", { date: "2026-10-19" }]]);

    expect(toolCalls).toEqual([
      {
        name: "getCalendarAvailability",
        ok: true,
        details: { date: "2026-10-19", freeSlotCount: 15, usingOrgConfiguredHours: false },
      },
    ]);
    expect(JSON.stringify(toolCalls)).not.toContain("freeSlots");
  });

  it("G: a failed lookup is saved as failed", async () => {
    m.executeTool.mockResolvedValueOnce('{"error":"execution_failed"}');

    const toolCalls = await savedToolCalls([["getCalendarAvailability", { date: "2026-10-19" }]]);

    expect(toolCalls).toEqual([
      { name: "getCalendarAvailability", ok: false, details: { date: "2026-10-19" } },
    ]);
  });

  it("other read-only tools keep only their name and outcome", async () => {
    const toolCalls = await savedToolCalls([["searchContacts", { query: "Jane Doe" }]]);

    expect(toolCalls).toEqual([{ name: "searchContacts", ok: true }]);
    expect(JSON.stringify(toolCalls)).not.toMatch(/Jane|jane@example\.com/);
  });

  it("a reply without a lookup saves no tool calls", async () => {
    expect(await savedToolCalls([])).toBeUndefined();
  });
});
