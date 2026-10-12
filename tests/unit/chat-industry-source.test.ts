import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chat's "## Organization" line takes the industry from Business DNA, the
 * profile the owner edits. The legacy `organization.settings.industry`
 * (written by onboarding before Business DNA got it, and editable nowhere) is
 * used only by an organization with no profile at all -- so a Business DNA
 * edit, including clearing the industry, is never contradicted by the old value. The real system prompt is
 * built; only data access and the model are mocked.
 */
const m = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  businessDna: null as Record<string, unknown> | null,
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
    organization: {
      findUniqueOrThrow: vi.fn(async () => ({ name: "Acme", settings: m.settings })),
    },
    conversation: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: vi.fn(() => ({ model: "claude-sonnet-4-5", maxTokens: 4096 })),
}));
vi.mock("@/server/business-dna/context", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBusinessDnaContext: vi.fn(async () => m.businessDna),
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

function profile(industry: string | null) {
  return {
    displayName: null,
    industry,
    description: null,
    productsServices: null,
    supportedLocales: [],
    timezone: null,
    brandTone: null,
    communicationStyle: null,
    responseInstructions: null,
    openingHours: null,
    cancellationPolicy: null,
    bookingPolicy: null,
    refundPolicy: null,
    paymentPolicy: null,
    otherPolicies: null,
    currency: null,
    quoteInstructions: null,
    pricingNotes: null,
    targetCustomer: null,
    keyFacts: [],
    services: [],
  };
}

/** The system prompt the model receives for one chat turn. */
async function systemPrompt(): Promise<string> {
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
  await response.text();
  expect(m.streamClaude).toHaveBeenCalledTimes(1);
  return (m.streamClaude.mock.calls[0]![0] as { system: string }).system;
}

function organizationLine(system: string): string {
  return system.split("\n").find((line) => line.startsWith('You work for "Acme"')) ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  m.settings = {};
  m.businessDna = null;
  m.streamClaude.mockImplementation(async ({ callbacks }) => {
    callbacks.onText("ok");
    return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
  });
});

describe("chat's organization industry", () => {
  it("comes from Business DNA when the profile has one", async () => {
    m.businessDna = profile("Hair salon");

    expect(organizationLine(await systemPrompt())).toBe(
      'You work for "Acme" (industry: Hair salon).',
    );
  });

  it("is never contradicted by the old onboarding copy once Business DNA is edited", async () => {
    m.settings = { industry: "Retail" };
    m.businessDna = profile("Hair salon");

    const system = await systemPrompt();
    expect(organizationLine(system)).toBe('You work for "Acme" (industry: Hair salon).');
    expect(system).not.toContain("Retail");
  });

  it("falls back to the old onboarding copy only when there is no Business DNA", async () => {
    m.settings = { industry: "Retail" };
    m.businessDna = null;

    expect(organizationLine(await systemPrompt())).toBe('You work for "Acme" (industry: Retail).');
  });

  it.each([
    ["an industry cleared in Business DNA", profile(null)],
    ["a blank industry in Business DNA", profile("   ")],
  ])("never brings the old onboarding copy back with %s", async (_case, dna) => {
    m.settings = { industry: "Retail" };
    m.businessDna = dna;

    const system = await systemPrompt();
    expect(organizationLine(system)).toBe('You work for "Acme".');
    expect(system).not.toContain("Retail");
  });

  it("names no industry when neither has one", async () => {
    expect(organizationLine(await systemPrompt())).toBe('You work for "Acme".');
  });

  it("keeps the organization's own AI instructions from settings", async () => {
    m.settings = { industry: "Retail", aiInstructions: "Always answer briefly." };
    m.businessDna = profile("Hair salon");

    expect(await systemPrompt()).toContain("Always answer briefly.");
  });
});
