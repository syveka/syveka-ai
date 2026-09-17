import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Regression coverage for the 2026-09-15 production incident: activating a
 * Voice assistant crashed the whole page when Vapi's native ("vapi" provider)
 * phone-number pool had no number available for the requested area code.
 * Vapi's native pool is US-only -- there is no real path to a Finnish +358
 * number through it, and Syveka has no Twilio/Vonage/BYO import integration
 * yet -- so a failure here must be treated as an expected, non-fatal outcome:
 * the already-synced Vapi assistant is preserved, and the caller gets a
 * controlled result instead of an uncaught exception.
 */
const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  voiceAssistantFindFirstOrThrow: vi.fn(),
  voiceAssistantUpdate: vi.fn(),
  upsertVapiAssistant: vi.fn(async (_config: unknown, existingId?: string | null) => ({
    id: existingId ?? "vapi-assistant-1",
  })),
  buyPhoneNumber: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  getBusinessDnaContext: vi.fn(async () => null),
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
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: mocks.getBusinessDnaContext,
  buildBusinessDnaPromptBlock: vi.fn(() => null),
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

function assistantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "assistant-1",
    organizationId: "org-a",
    vapiAssistantId: null,
    name: "Reception",
    language: "FI",
    voiceProvider: "azure",
    voiceId: null,
    firstMessage: "Hei!",
    systemPrompt: "Olet avulias vastaanottovirkailija.",
    phoneNumber: null,
    enabledTools: [],
    useKnowledgeBase: false,
    transferNumber: null,
    ...overrides,
  };
}

const VAPI_AREA_CODE_ERROR = new Error(
  'Vapi POST /phone-number → 400: {"message":"This area code is currently not available. ' +
    'Hint: Try one of 701, 279, 406.","error":"Bad Request","statusCode":400}',
);

describe("activateAssistant — phone-number provisioning failure handling", () => {
  let db: {
    voiceAssistant: {
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertVapiAssistant.mockImplementation(
      async (_config: unknown, existingId?: string | null) => ({
        id: existingId ?? "vapi-assistant-1",
      }),
    );
    db = {
      voiceAssistant: {
        findFirstOrThrow: vi.fn(async () => assistantRow()),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...assistantRow(),
          ...data,
        })),
      },
    };
    mocks.tenantDb.mockReturnValue(db);
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(assistantRow());
  });

  it("preserves the synced Vapi assistant and never throws when no compatible number is available", async () => {
    mocks.buyPhoneNumber.mockRejectedValue(VAPI_AREA_CODE_ERROR);

    const result = await activateAssistant(ctx(), "assistant-1");

    expect(result.phoneNumberError).toContain("area code is currently not available");
    expect(result.assistant.phoneNumber).toBeNull();
    expect(result.assistant.isActive).toBe(false);
    expect(result.assistant.vapiAssistantId).toBe("vapi-assistant-1");
  });

  it("does not persist the raw provider error in the audit trail", async () => {
    const providerSecret = "provider-secret-must-not-be-audited";
    mocks.buyPhoneNumber.mockRejectedValue(new Error(`Vapi 400: ${providerSecret}`));

    await activateAssistant(ctx(), "assistant-1");

    expect(JSON.stringify(mocks.auditMock.mock.calls)).not.toContain(providerSecret);
    expect(mocks.auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({ phoneNumberProvisioned: false }),
      }),
    );
  });

  it("never substitutes a US (or any other) number for the Finnish customer on failure", async () => {
    mocks.buyPhoneNumber.mockRejectedValue(VAPI_AREA_CODE_ERROR);

    const result = await activateAssistant(ctx(), "assistant-1");

    expect(result.assistant.phoneNumber).toBeNull();
    expect(db.voiceAssistant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phoneNumber: null }) }),
    );
  });

  it("persists vapiAssistantId even though phone provisioning failed, so a retry patches instead of duplicating", async () => {
    mocks.buyPhoneNumber.mockRejectedValue(VAPI_AREA_CODE_ERROR);

    await activateAssistant(ctx(), "assistant-1");

    expect(db.voiceAssistant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vapiAssistantId: "vapi-assistant-1" }),
      }),
    );
  });

  it("retrying after a partial activation PATCHes the existing Vapi assistant instead of creating a duplicate", async () => {
    // Simulate the DB state left behind by the first, phone-number-failed attempt.
    const partiallyActivated = assistantRow({ vapiAssistantId: "vapi-assistant-1" });
    db.voiceAssistant.findFirstOrThrow.mockResolvedValue(partiallyActivated);
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(partiallyActivated);
    mocks.buyPhoneNumber.mockRejectedValue(VAPI_AREA_CODE_ERROR);

    await activateAssistant(ctx(), "assistant-1");

    expect(mocks.upsertVapiAssistant).toHaveBeenCalledTimes(1);
    const existingIdArg = mocks.upsertVapiAssistant.mock.calls[0]![1];
    expect(existingIdArg).toBe("vapi-assistant-1");
  });

  it("fully activates (isActive: true, phoneNumberError: null) once a number is provisioned successfully", async () => {
    mocks.buyPhoneNumber.mockResolvedValue({ id: "num-1", number: "+358401234567" });

    const result = await activateAssistant(ctx(), "assistant-1");

    expect(result.phoneNumberError).toBeNull();
    expect(result.assistant.phoneNumber).toBe("+358401234567");
    expect(result.assistant.isActive).toBe(true);
  });

  it("does not call buyPhoneNumber again once a phone number is already on file", async () => {
    const alreadyNumbered = assistantRow({
      vapiAssistantId: "vapi-assistant-1",
      phoneNumber: "+358401234567",
    });
    db.voiceAssistant.findFirstOrThrow.mockResolvedValue(alreadyNumbered);
    mocks.voiceAssistantFindFirstOrThrow.mockResolvedValue(alreadyNumbered);

    const result = await activateAssistant(ctx(), "assistant-1");

    expect(mocks.buyPhoneNumber).not.toHaveBeenCalled();
    expect(result.assistant.isActive).toBe(true);
    expect(result.phoneNumberError).toBeNull();
  });
});
