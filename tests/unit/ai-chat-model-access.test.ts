import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat model is decided on the server from the organization's verified
 * plan, and a generation whose text moderation withholds still uses a message.
 * Real: the chat route, the model router, model access and the reservation
 * module. Faked: Redis, recorded usage, the plan lookup, the model (no paid
 * call is ever made) and the other services.
 */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

const m = vi.hoisted(() => ({
  orgId: "",
  deepPlans: new Set<string>(),
  plans: new Map<string, string>(),
  planError: null as Error | null,
  planGate: null as null | {
    waiting: number;
    parties: number;
    open: () => void;
    opened: Promise<void>;
  },
  pinnedModel: null as string | null,
  sets: new Map<string, Map<string, number>>(),
  recorded: new Map<string, number>(),
  limit: 50,
  monthUsageGate: null as null | {
    waiting: number;
    parties: number;
    open: () => void;
    opened: Promise<void>;
  },
  streamClaude: vi.fn(),
  moderation: vi.fn(async (_text: string) => false),
  recordUsage: vi.fn(async (org: string, metric: string, quantity: number) => {
    if (metric === "AI_MESSAGES") m.recorded.set(org, (m.recorded.get(org) ?? 0) + quantity);
  }),
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({
    orgId: m.orgId,
    userId: "22222222-2222-4222-8222-222222222222",
    role: "MEMBER",
    locale: "EN",
  })),
}));
vi.mock("@/server/auth/permissions", () => ({ can: vi.fn(() => true) }));
vi.mock("@/lib/billing/plan-catalog", async (importActual) => ({
  ...(await importActual<object>()),
  DEEP_MODEL_PLANS: m.deepPlans,
}));
vi.mock("@/server/integrations/redis", () => ({
  limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
  redis: {
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      const set = m.sets.get(keys[0]!) ?? new Map<string, number>();
      m.sets.set(keys[0]!, set);
      if (script.includes("ZADD")) {
        set.set(args[2]!, Number(args[1]));
        return set.size;
      }
      if (script.includes("ZREM")) return set.delete(args[0]!) ? 1 : 0;
      throw new Error("unexpected script");
    }),
  },
}));
vi.mock("@/server/integrations/openai", () => ({ isFlaggedByModeration: m.moderation }));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: m.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    conversation: {
      findFirst: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        model: m.pinnedModel,
      })),
      create: vi.fn(),
    },
  })),
  unscopedPrisma: {
    message: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    organization: { findUniqueOrThrow: vi.fn(async () => ({ name: "Acme", settings: {} })) },
    conversation: { update: vi.fn(async () => ({})) },
  },
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
    getEntitlements: vi.fn(async (org: string) => {
      if (m.planError) throw m.planError;
      const gate = m.planGate;
      if (gate) {
        gate.waiting += 1;
        if (gate.waiting === gate.parties) gate.open();
        await gate.opened;
      }
      return { plan: m.plans.get(org) ?? "FREE" };
    }),
    getMonthUsage: vi.fn(async (org: string) => {
      const value = m.recorded.get(org) ?? 0;
      const gate = m.monthUsageGate;
      if (gate) {
        gate.waiting += 1;
        if (gate.waiting === gate.parties) gate.open();
        await gate.opened;
      }
      return value;
    }),
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

import { redis } from "@/server/integrations/redis";
import { routeModel } from "@/server/ai/router";
import { POST } from "@/app/api/v1/ai/chat/route";

const STANDARD = routeModel("chat").model;
const DEEP = routeModel("deep").model;

function chat(body: Record<string, unknown> = {}) {
  return POST(
    new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: CONVERSATION, message: "Hello", ...body }),
    }),
  );
}

async function concurrentChats(n: number) {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  m.monthUsageGate = { waiting: 0, parties: n, open, opened };
  const pending: Array<Promise<Response>> = [];
  for (let i = 0; i < n; i++) {
    pending.push(chat());
    await vi.waitFor(() => expect(m.monthUsageGate!.waiting).toBe(i + 1));
  }
  return Promise.all(pending);
}

const modelUsed = () => m.streamClaude.mock.calls[0]![0].model as string;
const inFlight = () => [...m.sets.values()].reduce((n, s) => n + s.size, 0);
/** Output moderation flags the generated text; input moderation passes. */
const flagOutput = () => m.moderation.mockImplementation(async (text) => text === "An answer");

beforeEach(() => {
  vi.clearAllMocks();
  m.orgId = ORG_A;
  m.deepPlans.clear();
  m.plans.clear();
  m.planError = null;
  m.pinnedModel = null;
  m.sets.clear();
  m.recorded.clear();
  m.limit = 50;
  m.monthUsageGate = null;
  m.planGate = null;
  m.moderation.mockImplementation(async () => false);
  m.streamClaude.mockImplementation(async ({ callbacks }) => {
    callbacks.onText("An answer");
    callbacks.onUsage(100, 20);
    return { tokensIn: 100, tokensOut: 20, stopReason: "end_turn" };
  });
});

describe("deep model access follows the verified plan", () => {
  it.each(["FREE", "STARTER", "PRO", "ENTERPRISE"])(
    "%s has no deep model until the catalog lists it: refused before any spend",
    async (plan) => {
      m.plans.set(ORG_A, plan);
      const res = await chat({ deepMode: true });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "model_not_allowed" } });
      expect(m.streamClaude).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
      expect(m.recordUsage).not.toHaveBeenCalled();
    },
  );

  it("a plan the catalog lists gets the deep model", async () => {
    m.deepPlans.add("PRO");
    m.plans.set(ORG_A, "PRO");
    const res = await chat({ deepMode: true });
    await res.text();
    expect(res.status).toBe(200);
    expect(modelUsed()).toBe(DEEP);
  });

  it("an unverifiable plan is refused, never assumed", async () => {
    m.deepPlans.add("FREE");
    m.planError = new Error("redis down");
    const res = await chat({ deepMode: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "service_unavailable" } });
    expect(m.streamClaude).not.toHaveBeenCalled();
  });

  it("the standard route needs no plan lookup and stays on the standard model", async () => {
    const res = await chat();
    await res.text();
    expect(res.status).toBe(200);
    expect(modelUsed()).toBe(STANDARD);
    const { getEntitlements } = await import("@/server/services/billing/entitlements");
    expect(getEntitlements).not.toHaveBeenCalled();
  });
});

describe("a stored conversation model can't buy more than the plan includes", () => {
  it("a deep pin on a plan without it runs on the standard model", async () => {
    m.pinnedModel = DEEP;
    await (await chat()).text();
    expect(modelUsed()).toBe(STANDARD);
  });

  it("an unknown pinned model is ignored", async () => {
    m.pinnedModel = "some-other-model";
    await (await chat()).text();
    expect(modelUsed()).toBe(STANDARD);
  });

  it("a deep pin is honored on a plan the catalog lists", async () => {
    m.deepPlans.add("PRO");
    m.plans.set(ORG_A, "PRO");
    m.pinnedModel = DEEP;
    await (await chat()).text();
    expect(modelUsed()).toBe(DEEP);
  });

  it("a pin is ignored when the plan can't be verified", async () => {
    m.deepPlans.add("FREE");
    m.pinnedModel = DEEP;
    m.planError = new Error("redis down");
    await (await chat()).text();
    expect(modelUsed()).toBe(STANDARD);
  });
});

describe("a generation withheld by output moderation uses a message", () => {
  it("records one message and the tokens, and releases the reservation", async () => {
    flagOutput();
    const body = await (await chat()).text();
    expect(body).toContain('"code":"content_flagged"');
    expect(m.recordUsage.mock.calls.map((c) => [c[1], c[2]]).sort()).toEqual([
      ["AI_MESSAGES", 1],
      ["AI_TOKENS_IN", 100],
      ["AI_TOKENS_OUT", 20],
    ]);
    expect(m.recordUsage).toHaveBeenCalledWith(
      ORG_A,
      "AI_MESSAGES",
      1,
      expect.objectContaining({ blockedByModeration: true }),
    );
    expect(m.recorded.get(ORG_A)).toBe(1);
    expect(inFlight()).toBe(0);
  });

  it("the quota stops repeated flagged generations", async () => {
    flagOutput();
    m.limit = 2;
    await (await chat()).text();
    await (await chat()).text();
    const refused = await chat();
    expect(refused.status).toBe(402);
    expect(m.streamClaude).toHaveBeenCalledTimes(2);
  });

  it("a message refused by input moderation made no generation and uses nothing", async () => {
    m.moderation.mockImplementation(async () => true);
    const res = await chat();
    expect(res.status).toBe(422);
    expect(m.recordUsage).not.toHaveBeenCalled();
  });
});

describe("concurrent requests", () => {
  it("two flagged generations at limit-1: only one reaches the model and one message is used", async () => {
    flagOutput();
    m.recorded.set(ORG_A, 49);
    const responses = await concurrentChats(2);
    await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
    expect(m.recorded.get(ORG_A)).toBe(50);
    expect(inFlight()).toBe(0);
  });

  it("concurrent refused deep requests reach no model and hold no reservation", async () => {
    // Started one at a time and held at the plan lookup so all three overlap. Started in
    // the same tick, the route's lazy imports would race vitest's module mocking.
    let open = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    m.planGate = { waiting: 0, parties: 3, open, opened };
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 3; i++) {
      pending.push(chat({ deepMode: true }));
      await vi.waitFor(() => expect(m.planGate!.waiting).toBe(i + 1));
    }
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(m.streamClaude).not.toHaveBeenCalled();
    expect(inFlight()).toBe(0);
  });
});

describe("organizations stay separate", () => {
  it("one organization's plan doesn't give another the deep model", async () => {
    m.deepPlans.add("PRO");
    m.plans.set(ORG_A, "PRO");
    m.plans.set(ORG_B, "FREE");
    m.orgId = ORG_B;
    const res = await chat({ deepMode: true });
    expect(res.status).toBe(403);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });

  it("one organization's exhausted quota and flagged usage don't touch another's", async () => {
    flagOutput();
    m.limit = 1;
    await (await chat()).text();
    expect((await chat()).status).toBe(402);
    m.orgId = ORG_B;
    const res = await chat();
    await res.text();
    expect(res.status).toBe(200);
    expect(m.recorded.get(ORG_A)).toBe(1);
    expect(m.recorded.get(ORG_B)).toBe(1);
    expect(
      m.recordUsage.mock.calls.filter((c) => c[0] === ORG_B && c[1] === "AI_MESSAGES"),
    ).toHaveLength(1);
  });

  it("a turn in flight counts only against its own organization", async () => {
    let finish = () => {};
    m.streamClaude.mockImplementationOnce(async ({ callbacks }) => {
      callbacks.onText("An answer");
      callbacks.onUsage(100, 20);
      await new Promise<void>((resolve) => (finish = resolve));
      return { tokensIn: 100, tokensOut: 20, stopReason: "end_turn" };
    });
    m.limit = 1;
    const first = await chat();
    await vi.waitFor(() => expect(m.streamClaude).toHaveBeenCalledTimes(1));
    expect((await chat()).status).toBe(402);
    m.orgId = ORG_B;
    const other = await chat();
    await other.text();
    expect(other.status).toBe(200);
    expect([...m.sets.keys()].some((key) => key.includes(ORG_A))).toBe(true);
    expect([...m.sets.keys()].some((key) => key.includes(ORG_B))).toBe(true);
    finish();
    await first.text();
  });
});
