import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  voiceAssistantFindFirstOrThrow: vi.fn(),
  voiceAssistantUpdate: vi.fn(async () => ({})),
  upsertVapiAssistant: vi.fn(async (_config: { systemPrompt: string }) => ({
    id: "vapi-assistant-1",
  })),
  buyPhoneNumber: vi.fn(async () => ({ id: "num-1", number: "+358401234567" })),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {
    voiceAssistant: {
      findFirstOrThrow: mocks.voiceAssistantFindFirstOrThrow,
      update: mocks.voiceAssistantUpdate,
    },
  },
}));
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: mocks.upsertVapiAssistant,
  buyPhoneNumber: mocks.buyPhoneNumber,
}));
vi.mock("@/server/ai/tools", () => ({
  TOOL_REGISTRY: [],
  zodToJsonSchema: vi.fn(() => ({})),
}));
vi.mock("@/server/services/audit", () => ({ audit: mocks.auditMock }));
vi.mock("@/env", () => ({
  getVapiEnv: () => ({
    VAPI_API_KEY: "test",
    VAPI_WEBHOOK_SECRET: "a".repeat(32),
    VAPI_WEBHOOK_CREDENTIAL_ID: "cred_test",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

import { activateAssistant } from "@/server/services/voice";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function assistantRow(orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "assistant-1",
    organizationId: orgId,
    vapiAssistantId: null,
    name: "Reception",
    language: "EN",
    voiceProvider: "azure",
    voiceId: null,
    firstMessage: "Hi there!",
    systemPrompt: "You are a helpful receptionist.",
    phoneNumber: null,
    enabledTools: [],
    useKnowledgeBase: false,
    transferNumber: null,
    ...overrides,
  };
}

function businessDnaMock(orgId: string, row: Record<string, unknown> | null) {
  return {
    voiceAssistant: {
      findFirstOrThrow: vi.fn(async () => assistantRow(orgId)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...assistantRow(orgId),
        ...data,
      })),
    },
    businessDNA: { findFirst: vi.fn(async () => row) },
    businessDnaService: { findMany: vi.fn(async () => []) },
  };
}

describe("voice assistant sync — Business DNA context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches Business DNA scoped to the caller's organization, not a hardcoded/global lookup", async () => {
    const dnaDb = businessDnaMock("org-a", {
      displayName: "Acme Bakery",
      industry: "Bakery",
      productsServices: null,
      supportedLocales: ["EN"],
      brandTone: null,
      communicationStyle: null,
      openingHours: null,
      otherPolicies: null,
      targetCustomer: null,
      keyFacts: [],
    });
    mocks.tenantDb.mockReturnValue(dnaDb);
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(assistantRow("org-a"));

    await activateAssistant(ctx("org-a"), "assistant-1");

    expect(mocks.tenantDb).toHaveBeenCalledWith("org-a");
    expect(dnaDb.businessDNA.findFirst).toHaveBeenCalledTimes(1);
    const config = mocks.upsertVapiAssistant.mock.calls[0]![0];
    expect(config.systemPrompt).toContain("Acme Bakery");
  });

  it("uses each organization's own Business DNA — org A's prompt never contains org B's facts", async () => {
    const dnaDbA = businessDnaMock("org-a", {
      displayName: "Org A Bakery",
      industry: null,
      productsServices: null,
      supportedLocales: [],
      brandTone: null,
      communicationStyle: null,
      openingHours: null,
      otherPolicies: null,
      targetCustomer: null,
      keyFacts: [],
    });
    const dnaDbB = businessDnaMock("org-b", {
      displayName: "Org B Consulting",
      industry: null,
      productsServices: null,
      supportedLocales: [],
      brandTone: null,
      communicationStyle: null,
      openingHours: null,
      otherPolicies: null,
      targetCustomer: null,
      keyFacts: [],
    });
    mocks.tenantDb.mockImplementation((orgId: string) => (orgId === "org-a" ? dnaDbA : dnaDbB));
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(assistantRow("org-a"));

    await activateAssistant(ctx("org-a"), "assistant-1");

    const config = mocks.upsertVapiAssistant.mock.calls[0]![0];
    expect(config.systemPrompt).toContain("Org A Bakery");
    expect(config.systemPrompt).not.toContain("Org B Consulting");
    expect(dnaDbB.businessDNA.findFirst).not.toHaveBeenCalled();
  });

  it("degrades gracefully to the human-authored prompt when Business DNA has not been set up yet", async () => {
    mocks.tenantDb.mockReturnValue(businessDnaMock("org-a", null));
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(assistantRow("org-a"));

    await activateAssistant(ctx("org-a"), "assistant-1");

    const config = mocks.upsertVapiAssistant.mock.calls[0]![0];
    expect(config.systemPrompt).toContain("You are a helpful receptionist.");
    expect(config.systemPrompt).not.toContain("business_profile");
  });

  it("still includes the mandatory AI disclosure ahead of Business DNA context", async () => {
    mocks.tenantDb.mockReturnValue(
      businessDnaMock("org-a", {
        displayName: "Acme",
        industry: null,
        productsServices: null,
        supportedLocales: [],
        brandTone: null,
        communicationStyle: null,
        openingHours: null,
        otherPolicies: null,
        targetCustomer: null,
        keyFacts: [],
      }),
    );
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(assistantRow("org-a"));

    await activateAssistant(ctx("org-a"), "assistant-1");

    const config = mocks.upsertVapiAssistant.mock.calls[0]![0];
    expect(config.systemPrompt.indexOf("AI assistant")).toBeLessThan(
      config.systemPrompt.indexOf("business_profile"),
    );
  });
});
