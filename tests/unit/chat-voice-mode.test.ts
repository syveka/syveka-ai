import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live voice turns reach the normal chat route with responseMode "voice".
 * An automatically submitted spoken turn is not a confirmation, so the route
 * must offer the model only read-only tools and refuse any write tool call.
 * Real: the chat route, the tool registry and executeTool, permissions,
 * the system prompt. Mocked: session, limits, moderation, the model stream,
 * the database and billing.
 */
const mocks = vi.hoisted(() => ({
  streamClaude: vi.fn(),
  eventCreate: vi.fn(),
  contactCreate: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
    locale: "fi",
  })),
}));
vi.mock("@/server/integrations/redis", () => ({
  limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
}));
vi.mock("@/server/integrations/openai", () => ({
  isFlaggedByModeration: vi.fn(async () => false),
}));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: mocks.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    conversation: {
      findFirst: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", model: null })),
      create: vi.fn(),
    },
    contact: { create: mocks.contactCreate },
    calendarEvent: { create: mocks.eventCreate },
  })),
  unscopedPrisma: {
    message: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    organization: { findUniqueOrThrow: vi.fn(async () => ({ name: "Acme Oy", settings: {} })) },
    conversation: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: vi.fn(() => ({ model: "claude-sonnet-4-5", maxTokens: 4096 })),
}));
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: vi.fn(async () => null),
}));
vi.mock("@/server/ai/rag", () => ({
  retrieveChunks: vi.fn(async () => []),
  extractValidCitations: vi.fn(() => []),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => undefined),
  getMonthUsage: vi.fn(async () => 0),
  recordUsage: vi.fn(async () => undefined),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => null),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

import { POST } from "@/app/api/v1/ai/chat/route";
import { READ_ONLY_TOOL_NAMES } from "@/server/ai/tools";

const WRITE_TOOLS = ["createContact", "logActivity", "bookMeeting"];

function chat(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "33333333-3333-4333-8333-333333333333", ...body }),
    }),
  );
}

let toolResults: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  toolResults = [];
  // The model "tries" to book a meeting and create a contact.
  mocks.streamClaude.mockImplementation(async ({ callbacks }) => {
    toolResults.push(
      await callbacks.onToolUse("bookMeeting", {
        title: "Demo",
        startsAt: "2026-10-01T09:00:00.000Z",
      }),
    );
    toolResults.push(await callbacks.onToolUse("createContact", { firstName: "Maija" }));
    callbacks.onText("Selvä.");
    return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
  });
});

describe("chat route voice mode", () => {
  it("read-only tools are exactly the ':read' tools", () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(
      ["getCalendarAvailability", "searchContacts", "searchKnowledgeBase"].sort(),
    );
  });

  it("offers only read-only tools and refuses write tool calls (nothing is written)", async () => {
    const res = await chat({ message: "Varaa tapaaminen huomiseksi", responseMode: "voice" });
    await res.text();
    const call = mocks.streamClaude.mock.calls[0]![0] as {
      tools: Array<{ name: string }>;
      system: string;
    };
    expect(call.tools.map((t) => t.name).sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());
    for (const name of WRITE_TOOLS) expect(call.tools.map((t) => t.name)).not.toContain(name);
    expect(toolResults).toEqual([
      JSON.stringify({ error: "not_available_in_voice_conversation" }),
      JSON.stringify({ error: "not_available_in_voice_conversation" }),
    ]);
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.contactCreate).not.toHaveBeenCalled();
    expect(call.system).toContain("## Live voice conversation");
  });

  it("typed chat keeps its existing tools and behaviour (write tools still offered)", async () => {
    const res = await chat({ message: "Varaa tapaaminen" });
    await res.text();
    const call = mocks.streamClaude.mock.calls[0]![0] as {
      tools: Array<{ name: string }>;
      system: string;
    };
    for (const name of WRITE_TOOLS) expect(call.tools.map((t) => t.name)).toContain(name);
    expect(call.system).not.toContain("## Live voice conversation");
    expect(toolResults[0]).not.toContain("not_available_in_voice_conversation");
  });

  it("rejects an unknown response mode", async () => {
    const res = await chat({ message: "x", responseMode: "speech_to_speech" });
    expect(res.status).toBe(400);
  });
});
