import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type * as EntitlementsModule from "@/server/services/billing/entitlements";

const mocks = vi.hoisted(() => ({
  voiceAssistantCount: vi.fn(),
  voiceAssistantCreate: vi.fn(),
  voiceAssistantUpdate: vi.fn(),
  getEntitlementsMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    voiceAssistant: {
      count: mocks.voiceAssistantCount,
      create: mocks.voiceAssistantCreate,
      update: mocks.voiceAssistantUpdate,
    },
  }),
  unscopedPrisma: {},
}));
vi.mock("@/server/services/billing/entitlements", async () => {
  const actual = await vi.importActual<typeof EntitlementsModule>(
    "@/server/services/billing/entitlements",
  );
  return { ...actual, getEntitlements: mocks.getEntitlementsMock };
});
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: vi.fn(),
  buyPhoneNumber: vi.fn(),
}));
vi.mock("@/server/ai/tools", () => ({ TOOL_REGISTRY: [], zodToJsonSchema: vi.fn(() => ({})) }));
vi.mock("@/server/services/audit", () => ({ audit: mocks.auditMock }));
vi.mock("@/env", () => ({
  getVapiEnv: () => ({
    VAPI_API_KEY: "test",
    VAPI_WEBHOOK_SECRET: "a".repeat(32),
    VAPI_WEBHOOK_CREDENTIAL_ID: "cred_test",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

import { upsertAssistant } from "@/server/services/voice";
import { EntitlementError } from "@/server/services/billing/entitlements";
import type { VoiceAssistantInput } from "@/lib/validators/voice";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function assistantInput(): VoiceAssistantInput {
  return {
    name: "Front desk",
    language: "FI",
    voiceProvider: "azure",
    voiceId: "",
    firstMessage: "Hei!",
    systemPrompt: "You answer calls.",
    enabledTools: [],
    useKnowledgeBase: false,
    transferNumber: "",
  };
}

function entitlements(voiceAssistants: number) {
  return {
    plan: "FREE" as const,
    seats: 1,
    status: "ACTIVE",
    readOnly: false,
    maxSeats: 2,
    aiMessagesPerUserMonth: 25,
    voiceAssistants,
    voiceMinutesMonth: 0,
    kbStorageMb: 50,
    activeWorkflows: 0,
    maxContacts: 200,
    apiAccess: false,
    auditRetentionDays: 0,
    creatorCreditsPerMonth: 0,
  };
}

/**
 * Regression coverage for the Voice entitlement UX fix: upsertAssistant()
 * previously threw a plain Error("Voice assistant limit reached for your
 * plan") on creation past the plan's limit -- indistinguishable, client-side,
 * from any other unexpected failure, and with no way to render an upgrade
 * CTA. It now throws the shared EntitlementError (already used elsewhere in
 * billing/entitlements.ts), carrying a structured `code`/`limit` the action
 * layer and UI can key off of, matching Creator Studio's existing pattern.
 */
describe("upsertAssistant entitlement gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws EntitlementError (not a plain Error) when creating past the plan's voice-assistant limit", async () => {
    mocks.getEntitlementsMock.mockResolvedValue(entitlements(0));
    mocks.voiceAssistantCount.mockResolvedValue(0);

    await expect(upsertAssistant(ctx(), assistantInput())).rejects.toBeInstanceOf(EntitlementError);
    await expect(upsertAssistant(ctx(), assistantInput())).rejects.toMatchObject({
      code: "entitlement_exceeded",
      limit: "voiceAssistants",
    });
    expect(mocks.voiceAssistantCreate).not.toHaveBeenCalled();
  });

  it("throws when the org is already at (not just over) its limit", async () => {
    mocks.getEntitlementsMock.mockResolvedValue(entitlements(1));
    mocks.voiceAssistantCount.mockResolvedValue(1);

    await expect(upsertAssistant(ctx(), assistantInput())).rejects.toBeInstanceOf(EntitlementError);
  });

  it("succeeds when the org is under its limit", async () => {
    mocks.getEntitlementsMock.mockResolvedValue(entitlements(1));
    mocks.voiceAssistantCount.mockResolvedValue(0);
    mocks.voiceAssistantCreate.mockResolvedValue({ id: "assistant-1", vapiAssistantId: null });

    const result = await upsertAssistant(ctx(), assistantInput());

    expect(result).toMatchObject({ id: "assistant-1" });
    expect(mocks.voiceAssistantCreate).toHaveBeenCalledTimes(1);
  });

  it("does not re-check the limit when updating an existing assistant", async () => {
    mocks.voiceAssistantUpdate.mockResolvedValue({ id: "assistant-1", vapiAssistantId: null });

    await upsertAssistant(ctx(), assistantInput(), "assistant-1");

    expect(mocks.getEntitlementsMock).not.toHaveBeenCalled();
    expect(mocks.voiceAssistantCount).not.toHaveBeenCalled();
  });
});
