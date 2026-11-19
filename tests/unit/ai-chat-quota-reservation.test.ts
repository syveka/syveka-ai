import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The monthly AI message quota is enforced atomically: each chat turn
 * reserves a slot (Redis) before the paid model call, so concurrent turns
 * can't overspend the quota, and a turn that stopped after the provider
 * produced output still counts. Real: the chat route and the reservation
 * module. Faked: Redis (an in-memory version of the reservation scripts),
 * recorded usage, the model and the other services.
 */
const m = vi.hoisted(() => ({
  /** Reservation sorted sets: key → (id → expiry ms). */
  gate(parties: number) {
    let open = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    m.monthUsageGate = { waiting: 0, parties, open, opened };
  },
  sets: new Map<string, Map<string, number>>(),
  /** Recorded AI_MESSAGES this month (the database). */
  recorded: 0,
  limit: 50,
  events: [] as string[],
  /** While set, releasing a reservation waits for it (a slow Redis). */
  releaseHold: null as null | Promise<void>,
  monthUsageGate: null as null | {
    waiting: number;
    parties: number;
    open: () => void;
    opened: Promise<void>;
  },
  streamClaude: vi.fn(),
  moderation: vi.fn(async () => false),
  recordUsage: vi.fn(async (_org: string, metric: string, quantity: number) => {
    if (metric === "AI_MESSAGES") {
      m.recorded += quantity;
      m.events.push("record:AI_MESSAGES");
    }
  }),
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
// The scripts are told apart by their commands: importing the reservation
// module here would import this mocked module from its own factory.
vi.mock("@/server/integrations/redis", () => {
  return {
    limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
    redis: {
      eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
        const set = m.sets.get(keys[0]!) ?? new Map<string, number>();
        m.sets.set(keys[0]!, set);
        if (script.includes("ZADD")) {
          const [now, expiresAt, id] = args;
          for (const [member, exp] of set) if (exp <= Number(now)) set.delete(member);
          set.set(id!, Number(expiresAt));
          m.events.push("reserve");
          return set.size;
        }
        if (script.includes("ZREM")) {
          if (m.releaseHold) await m.releaseHold;
          m.events.push("release");
          return set.delete(args[0]!) ? 1 : 0;
        }
        throw new Error("unexpected script");
      }),
    },
  };
});
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
    message: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
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
vi.mock("@/server/services/billing/entitlements", () => {
  class EntitlementError extends Error {
    readonly code = "entitlement_exceeded";
    constructor(readonly limit: string) {
      super("Monthly AI message quota reached.");
    }
  }
  return {
    EntitlementError,
    getMonthUsage: vi.fn(async () => {
      const value = m.recorded;
      const gate = m.monthUsageGate;
      if (gate) {
        // Hold every caller until all concurrent requests have read the count.
        gate.waiting += 1;
        if (gate.waiting === gate.parties) gate.open();
        await gate.opened;
      }
      return value;
    }),
    // Same comparison as the real guard.
    assertWithinLimit: vi.fn(async (_org: string, check: { orgMonthCount: number }) => {
      if (check.orgMonthCount >= m.limit) throw new EntitlementError("aiMessagesPerOrgMonth");
      return {};
    }),
    recordUsage: m.recordUsage,
  };
});
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => null),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

// Loaded here first, so every importer (the route and the reservation module)
// gets this file's mock.
import { redis } from "@/server/integrations/redis";
import { POST } from "@/app/api/v1/ai/chat/route";

function chat(message = "Hello") {
  return POST(
    new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "33333333-3333-4333-8333-333333333333", message }),
    }),
  );
}

/**
 * n overlapping requests that all read the recorded count before any of them
 * records usage (the race). Each starts once the previous one is waiting at
 * the count: started in the same tick, the route's first-use module loading
 * would race vitest's mocking instead.
 */
async function concurrentChats(n: number) {
  m.gate(n);
  const pending: Array<Promise<Response>> = [];
  for (let i = 0; i < n; i++) {
    pending.push(chat());
    await vi.waitFor(() => expect(m.monthUsageGate!.waiting).toBe(i + 1));
  }
  return Promise.all(pending);
}

const inFlight = () => [...m.sets.values()].reduce((n, s) => n + s.size, 0);
const usageRows = () =>
  m.recordUsage.mock.calls.map((c) => [c[1], c[2]] as [string, number]).sort();

beforeEach(() => {
  vi.clearAllMocks();
  m.sets.clear();
  m.recorded = 0;
  m.limit = 50;
  m.events = [];
  m.monthUsageGate = null;
  m.moderation.mockResolvedValue(false);
  m.streamClaude.mockImplementation(async ({ callbacks }) => {
    callbacks.onText("An answer");
    callbacks.onUsage(100, 20);
    return { tokensIn: 100, tokensOut: 20, stopReason: "end_turn" };
  });
});

describe("AI message quota reservation", () => {
  it("two concurrent requests at limit-1: exactly one reaches the model", async () => {
    m.recorded = 49;
    const responses = await concurrentChats(2);
    const statuses = responses.map((r) => r.status).sort();
    await Promise.all(responses.map((r) => r.text()));
    expect(statuses).toEqual([200, 402]);
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
    expect(m.recorded).toBe(50);
    expect(inFlight()).toBe(0);
  });

  it("five concurrent requests with two left: exactly two reach the model", async () => {
    m.recorded = 48;
    const responses = await concurrentChats(5);
    await Promise.all(responses.map((r) => r.text()));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(2);
    expect(responses.filter((r) => r.status === 402)).toHaveLength(3);
    expect(m.streamClaude).toHaveBeenCalledTimes(2);
    expect(m.recorded).toBe(50);
  });

  it("the quota refusal keeps the existing 402 shape", async () => {
    m.recorded = 50;
    const res = await chat();
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: { code: "entitlement_exceeded", limit: "aiMessagesPerOrgMonth" },
    });
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(inFlight()).toBe(0);
  });

  it("Redis unavailable: refused with 503 (fail closed), the model is never called", async () => {
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await chat();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "service_unavailable" } });
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("a completed turn records its message before releasing the reservation", async () => {
    const res = await chat();
    expect(await res.text()).toContain('"type":"done"');
    expect(m.events).toEqual(["reserve", "record:AI_MESSAGES", "release"]);
    expect(inFlight()).toBe(0);
  });

  it("a slow release doesn't hold the finished stream open", async () => {
    let unblock: () => void = () => undefined;
    m.releaseHold = new Promise<void>((resolve) => (unblock = resolve));
    try {
      const res = await chat();
      // The body ends (controller closed) while the release is still waiting.
      const body = await Promise.race([
        res.text(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("stream still open")), 1_000),
        ),
      ]);
      expect(body).toContain('"type":"done"');
      expect(m.events).toEqual(["reserve", "record:AI_MESSAGES"]);
    } finally {
      unblock();
      m.releaseHold = null;
    }
    await vi.waitFor(() => expect(m.events).toContain("release"));
  });

  it("refused before the model call (input moderation): reservation released, nothing recorded", async () => {
    m.moderation.mockResolvedValueOnce(true);
    const res = await chat();
    expect(res.status).toBe(422);
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(m.events).toEqual(["reserve", "release"]);
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("an error thrown before the model call still releases the reservation", async () => {
    const { unscopedPrisma } = await import("@/server/db/tenant");
    vi.mocked(unscopedPrisma.organization.findUniqueOrThrow).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(chat()).rejects.toThrow("db down");
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(m.events).toEqual(["reserve", "release"]);
  });

  it("an aborted typed turn after the provider produced output: tokens and the message count", async () => {
    m.streamClaude.mockImplementation(async ({ callbacks }) => {
      callbacks.onText("Partial");
      callbacks.onUsage(1_200, 40);
      throw new DOMException("Request aborted", "AbortError");
    });
    await (await chat()).text();
    expect(usageRows()).toEqual([
      ["AI_MESSAGES", 1],
      ["AI_TOKENS_IN", 1_200],
      ["AI_TOKENS_OUT", 40],
    ]);
    expect(m.recordUsage).toHaveBeenCalledWith(
      expect.any(String),
      "AI_MESSAGES",
      1,
      expect.objectContaining({ aborted: true }),
    );
    expect(m.events.at(-1)).toBe("release");
    expect(inFlight()).toBe(0);
  });

  it("a typed turn that fails after the model call: tokens and the message count", async () => {
    const { unscopedPrisma } = await import("@/server/db/tenant");
    // The model finished; saving the reply fails (generic generation_failed path).
    vi.mocked(unscopedPrisma.message.create)
      .mockResolvedValueOnce({} as never) // the user's message
      .mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await (await chat()).text();
    expect(body).toContain('"code":"generation_failed"');
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
    expect(inFlight()).toBe(0);
  });

  it("a failure recording partial usage logs one event with the error name only; the turn ends as before", async () => {
    m.streamClaude.mockImplementation(async ({ callbacks }) => {
      callbacks.onText("Partial");
      callbacks.onUsage(1_200, 40);
      throw new Error("provider failed");
    });
    const usageError = Object.assign(new Error("usage write failed for tenant detail"), {
      name: "UsageWriteError",
    });
    m.recordUsage
      .mockRejectedValueOnce(usageError)
      .mockRejectedValueOnce(usageError)
      .mockRejectedValueOnce(usageError);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const body = await (await chat("private synthetic question")).text();

    expect(body).toContain('"code":"generation_failed"');
    expect(m.events.at(-1)).toBe("release");
    expect(inFlight()).toBe(0);
    const lines = log.mock.calls.map(([line]) => String(line));
    const events = lines.filter((line) => line.includes("ai_chat_partial_usage_record_failed"));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!)).toEqual({
      event: "ai_chat_partial_usage_record_failed",
      name: "UsageWriteError",
    });
    for (const line of lines) {
      expect(line).not.toContain("usage write failed");
      expect(line).not.toContain("private synthetic question");
    }
  });

  it("the provider fails before producing anything: nothing recorded, reservation released", async () => {
    m.streamClaude.mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await (await chat()).text();
    expect(body).toContain('"code":"generation_failed"');
    expect(m.recordUsage).not.toHaveBeenCalled();
    expect(m.events).toEqual(["reserve", "release"]);
  });

  it("aborted before the provider produced anything: nothing recorded, reservation released", async () => {
    m.streamClaude.mockRejectedValue(new DOMException("Request aborted", "AbortError"));
    await (await chat()).text();
    expect(m.recordUsage).not.toHaveBeenCalled();
    expect(m.events).toEqual(["reserve", "release"]);
  });
});
