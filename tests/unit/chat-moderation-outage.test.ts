import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * When the moderation provider can't be reached (down, rate-limited, not
 * configured) the chat fails closed and legibly: "could not check" is a
 * structured 503, distinct from "flagged" (422). Nothing unmoderated reaches
 * the model or the client, and the quota reservation is given back.
 * Real: the chat route and the reservation module. Faked: Redis (in-memory
 * reservation scripts), moderation, the model, usage and the other services
 * (same shape as ai-chat-quota-reservation.test.ts).
 */
const m = vi.hoisted(() => ({
  /** Reservation sorted sets: key → (id → expiry ms). */
  sets: new Map<string, Map<string, number>>(),
  events: [] as string[],
  streamClaude: vi.fn(),
  moderation: vi.fn(async (): Promise<boolean> => false),
  recordUsage: vi.fn(async (_org: string, _metric: string, _quantity: number, _meta?: unknown) => {
    m.events.push("record");
  }),
  messageCreate: vi.fn(async () => ({})),
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
  limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
  redis: {
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      const set = m.sets.get(keys[0]!) ?? new Map<string, number>();
      m.sets.set(keys[0]!, set);
      if (script.includes("ZADD")) {
        set.set(args[2]!, Number(args[1]));
        m.events.push("reserve");
        return set.size;
      }
      if (script.includes("ZREM")) {
        m.events.push("release");
        return set.delete(args[0]!) ? 1 : 0;
      }
      throw new Error("unexpected script");
    }),
  },
}));
vi.mock("@/server/integrations/openai", () => ({ isFlaggedByModeration: m.moderation }));
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
vi.mock("@/server/ai/prompts/system", () => ({ buildSystemPrompt: vi.fn(() => "system") }));
vi.mock("@/server/business-dna/context", () => ({
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
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class EntitlementError extends Error {},
  getMonthUsage: vi.fn(async () => 0),
  assertWithinLimit: vi.fn(async () => ({})),
  recordUsage: m.recordUsage,
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => null),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

// Loaded here first, so every importer (the route and the reservation module)
// gets this file's mock, as in ai-chat-quota-reservation.test.ts.
import "@/server/integrations/redis";
import { POST } from "@/app/api/v1/ai/chat/route";

const PRIVATE_TEXT = "my private question";
const MODEL_REPLY = "An unchecked answer";

function chat() {
  return POST(
    new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "33333333-3333-4333-8333-333333333333",
        message: PRIVATE_TEXT,
      }),
    }),
  );
}

const inFlight = () => [...m.sets.values()].reduce((n, s) => n + s.size, 0);
const usageRows = () =>
  m.recordUsage.mock.calls.map((c) => [c[1], c[2]] as [string, number]).sort();
const savedRoles = () =>
  (m.messageCreate.mock.calls as unknown as Array<[{ data: { role: string } }]>).map(
    (c) => c[0].data.role,
  );

/** A provider failure whose message quotes the user's text and the provider's response body. */
function providerDown() {
  return Object.assign(
    new Error(`503 {"error":{"message":"upstream overloaded"}} input: "${PRIVATE_TEXT}"`),
    { name: "APIConnectionError", status: 503 },
  );
}

let consoleError: MockInstance<typeof console.error>;
const logLines = () => consoleError.mock.calls.map((c) => c.map(String).join(" "));

beforeEach(() => {
  vi.clearAllMocks();
  m.sets.clear();
  m.events = [];
  m.moderation.mockReset();
  m.moderation.mockResolvedValue(false);
  m.messageCreate.mockReset();
  m.messageCreate.mockResolvedValue({});
  m.streamClaude.mockImplementation(async ({ callbacks }) => {
    callbacks.onText(MODEL_REPLY);
    callbacks.onUsage(100, 20);
    return { tokensIn: 100, tokensOut: 20, stopReason: "end_turn" };
  });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("input moderation unavailable", () => {
  it.each([
    ["the provider is unreachable", providerDown, "APIConnectionError"],
    [
      "the provider key is not configured",
      () => new Error("Invalid OpenAI environment variables: OPENAI_API_KEY"),
      "Error",
    ],
  ])("%s: structured 503, fail closed", async (_case, failure, loggedName) => {
    m.moderation.mockRejectedValueOnce(failure());

    const res = await chat();

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: { code: "moderation_unavailable" } });
    // Fail closed: no model call, nothing stored, nothing metered.
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(m.messageCreate).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
    // The quota slot is given back.
    expect(m.events).toEqual(["reserve", "release"]);
    expect(inFlight()).toBe(0);
    // One structured line: the error's class name only.
    expect(logLines()).toHaveLength(1);
    expect(JSON.parse(logLines()[0]!)).toEqual({
      event: "ai_chat_moderation_unavailable",
      stage: "input",
      name: loggedName,
    });
    expect(logLines()[0]).not.toContain(PRIVATE_TEXT);
    expect(logLines()[0]).not.toContain("upstream overloaded");
    expect(logLines()[0]).not.toContain("OPENAI_API_KEY");
  });

  it("an error name that isn't a class name is not logged verbatim", async () => {
    m.moderation.mockRejectedValueOnce(
      Object.assign(new Error("down"), { name: `leak: ${PRIVATE_TEXT}` }),
    );
    const res = await chat();
    expect(res.status).toBe(503);
    expect(JSON.parse(logLines()[0]!).name).toBe("unknown");
    expect(logLines().join("\n")).not.toContain(PRIVATE_TEXT);
  });

  it("flagged input is unchanged: 422 content_flagged, not the outage code", async () => {
    m.moderation.mockResolvedValueOnce(true);
    const res = await chat();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "content_flagged" } });
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
    expect(m.events).toEqual(["reserve", "release"]);
    expect(logLines()).toHaveLength(0);
  });
});

describe("output moderation unavailable", () => {
  it("the reply is withheld and the stream ends with generation_failed", async () => {
    m.moderation.mockResolvedValueOnce(false).mockRejectedValueOnce(providerDown());

    const res = await chat();
    expect(res.status).toBe(200);
    const body = await res.text();

    // A well-formed stream whose last event is the error the client translates.
    const events = body
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as { type: string; code?: string });
    expect(events.map((e) => e.type)).toEqual(["meta", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", code: "generation_failed" });
    // Fail closed: the unchecked reply is neither sent nor stored.
    expect(body).not.toContain(MODEL_REPLY);
    expect(savedRoles()).toEqual(["USER"]);

    // Existing policy for a turn that fails after the provider produced
    // output: the generation was paid for, so its message and tokens count.
    expect(usageRows()).toEqual([
      ["AI_MESSAGES", 1],
      ["AI_TOKENS_IN", 100],
      ["AI_TOKENS_OUT", 20],
    ]);
    expect(m.recordUsage).toHaveBeenCalledWith(
      expect.any(String),
      "AI_MESSAGES",
      1,
      expect.objectContaining({ stoppedBy: "failed" }),
    );
    // Recorded first, then the reservation is released (after the stream closes).
    await vi.waitFor(() => expect(inFlight()).toBe(0));
    expect(m.events.at(-1)).toBe("release");

    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toContain('"event":"ai_chat_stream_failed"');
    expect(logLines()[0]).toContain('"name":"APIConnectionError"');
    expect(logLines()[0]).not.toContain(PRIVATE_TEXT);
    expect(logLines()[0]).not.toContain(MODEL_REPLY);
    expect(logLines()[0]).not.toContain("upstream overloaded");
  });

  it("flagged output is unchanged: content_flagged, metered as blocked by moderation", async () => {
    m.moderation.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const body = await (await chat()).text();
    expect(body).toContain('"type":"error","code":"content_flagged"');
    expect(body).not.toContain(MODEL_REPLY);
    expect(usageRows()).toEqual([
      ["AI_MESSAGES", 1],
      ["AI_TOKENS_IN", 100],
      ["AI_TOKENS_OUT", 20],
    ]);
    expect(m.recordUsage).toHaveBeenCalledWith(
      expect.any(String),
      "AI_MESSAGES",
      1,
      expect.objectContaining({ blockedByModeration: true }),
    );
    await vi.waitFor(() => expect(inFlight()).toBe(0));
  });
});
