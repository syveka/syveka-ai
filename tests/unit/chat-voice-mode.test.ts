import type * as VoiceModule from "@/server/ai/voice-conversation";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live voice turns reach the normal chat route carrying a single-use server
 * grant (issued by the turn route); voice mode is derived from the grant.
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
  consume: 1,
  active: 0,
  consumeArgs: [] as string[],
  history: [] as Array<{ role: string; content: string }>,
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
    locale: "fi",
  })),
}));
vi.mock("@/server/integrations/redis", async () => {
  const voice = await vi.importActual<typeof VoiceModule>("@/server/ai/voice-conversation");
  return {
    limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
    redis: {
      eval: vi.fn(async (script: string, _keys: string[], args: string[]) => {
        if (script === voice.CONSUME_GRANT_SCRIPT) {
          mocks.consumeArgs = args;
          return mocks.consume;
        }
        if (script === voice.ACTIVE_SESSION_SCRIPT) return mocks.active;
        throw new Error("unexpected script");
      }),
    },
  };
});
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
    message: { findMany: vi.fn(async () => mocks.history), create: vi.fn(async () => ({})) },
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

const GRANT = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeArgs = [];
  vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "1");
  mocks.consume = 1;
  mocks.active = 0;
  mocks.history = [];
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
    const res = await chat({ message: "Varaa tapaaminen huomiseksi", voiceGrant: GRANT });
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

  it.each(["voice", "speech_to_speech"])(
    "rejects a client-supplied responseMode (%s): voice mode is never client-controlled",
    async (mode) => {
      const res = await chat({ message: "x", responseMode: mode });
      expect(res.status).toBe(400);
      expect(mocks.streamClaude).not.toHaveBeenCalled();
    },
  );

  it.each([
    [-1, "voice_turn_invalid"],
    [-2, "voice_turn_invalid"],
    [-3, "voice_session_ended"],
  ])("a refused grant (store %s) → 409 %s, no generation", async (result, code) => {
    mocks.consume = result;
    const res = await chat({ message: "x", voiceGrant: GRANT });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code } });
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("a grant can't be combined with attached documents", async () => {
    const res = await chat({
      message: "x",
      voiceGrant: GRANT,
      documentIds: ["55555555-5555-4555-8555-555555555555"],
    });
    expect(res.status).toBe(400);
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("while the user has a live session, chat without a grant is refused", async () => {
    mocks.active = 1;
    const res = await chat({ message: "Varaa tapaaminen" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "live_voice_session_active" } });
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("a grant is checked against the conversation named in the request", async () => {
    await (await chat({ message: "x", voiceGrant: GRANT })).text();
    expect(mocks.consumeArgs[4]).toBe("33333333-3333-4333-8333-333333333333");
    mocks.consume = -4; // the grant belongs to another conversation
    const res = await chat({ message: "x", voiceGrant: GRANT });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "voice_turn_invalid" } });
  });

  it("a grant without a conversation id is rejected (400) before consumption", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "x", voiceGrant: GRANT }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.consumeArgs).toEqual([]);
    expect(mocks.streamClaude).not.toHaveBeenCalled();
  });

  it("a voice turn never triggers a paid summary; typed chat still does", async () => {
    const { ensureConversationSummary } = await import("@/server/services/conversations");
    await (await chat({ message: "x", voiceGrant: GRANT })).text();
    expect(ensureConversationSummary).not.toHaveBeenCalled();
    await (await chat({ message: "typed" })).text();
    expect(ensureConversationSummary).toHaveBeenCalledTimes(1);
  });

  it("voice history messages are clipped to 2,000 characters; typed chat is not", async () => {
    mocks.history = [{ role: "USER", content: "a".repeat(9_000) }];
    await (await chat({ message: "x", voiceGrant: GRANT })).text();
    const voiceCall = mocks.streamClaude.mock.calls[0]![0];
    expect(voiceCall.messages[0].content.length).toBeLessThanOrEqual(2_000 + " [truncated]".length);
    await (await chat({ message: "typed" })).text();
    expect(mocks.streamClaude.mock.calls[1]![0].messages[0].content).toHaveLength(9_000);
  });

  it("voice: at most 3 tool executions per turn, each result clipped to 4,000 characters", async () => {
    const { retrieveChunks } = await import("@/server/ai/rag");
    vi.mocked(retrieveChunks).mockResolvedValue([
      { chunkId: "c", documentId: "d", title: "t", content: "x".repeat(20_000), similarity: 1 },
    ]);
    const results: string[] = [];
    mocks.streamClaude.mockImplementation(async ({ callbacks }) => {
      for (let i = 0; i < 5; i++) {
        results.push(await callbacks.onToolUse("searchKnowledgeBase", { query: `q${i}` }));
      }
      return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
    });
    await (await chat({ message: "x", voiceGrant: GRANT })).text();
    expect(results.slice(0, 3).every((r) => r.length <= 4_000 + " [truncated]".length)).toBe(true);
    expect(results.slice(3)).toEqual([
      JSON.stringify({ error: "tool_limit_reached" }),
      JSON.stringify({ error: "tool_limit_reached" }),
    ]);
    // Only 3 searches ran (the embedding call inside each one is paid).
    expect(vi.mocked(retrieveChunks).mock.calls.filter((c) => c[0].count === 5)).toHaveLength(3);
  });

  it("ending mid-reply: completed model calls stay recorded; no reply is saved", async () => {
    const { recordUsage } = await import("@/server/services/billing/entitlements");
    const { unscopedPrisma } = await import("@/server/db/tenant");
    mocks.streamClaude.mockImplementation(async ({ callbacks }) => {
      callbacks.onUsage(1_200, 40); // round 1 completed (billed)
      throw new DOMException("Request aborted", "AbortError"); // End pressed during round 2
    });
    await (await chat({ message: "x", voiceGrant: GRANT })).text();
    const metrics = vi.mocked(recordUsage).mock.calls.map((c) => [c[1], c[2], c[3]?.aborted]);
    expect(metrics).toEqual([
      ["AI_TOKENS_IN", 1_200, true],
      ["AI_TOKENS_OUT", 40, true],
    ]);
    // Only the user's message was stored; no assistant reply.
    expect(vi.mocked(unscopedPrisma.message.create)).toHaveBeenCalledTimes(1);
  });

  it("with live voice disabled, typed chat never touches the voice store", async () => {
    vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "");
    const { redis } = await import("@/server/integrations/redis");
    const res = await chat({ message: "Hei" });
    await res.text();
    expect(res.status).toBe(200);
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
