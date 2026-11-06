import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import {
  recordingChoice,
  recordingEnabledFor,
  recordingToApply,
  voiceAssistantSchema,
  type VoiceAssistantInput,
} from "@/lib/validators/voice";

/**
 * The owner's recording choice: off for new assistants, and for assistants made before the
 * setting, left as set in Vapi until someone chooses here. Vapi is mocked: no call is made.
 */
const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  findFirstOrThrow: vi.fn(),
  unscopedUpdate: vi.fn(async () => ({})),
  unscopedUpdateMany: vi.fn(async () => ({ count: 1 })),
  getEntitlements: vi.fn(async () => ({ voiceAssistants: 5 })),
  upsertVapiAssistant: vi.fn(async (_config: { recordingEnabled?: boolean | null }) => ({
    id: "vapi-1",
  })),
  buyPhoneNumber: vi.fn(async () => ({ id: "num-1", number: "+358401234567" })),
  audit: vi.fn(async () => undefined),
  auditCreate: vi.fn(async (_args: unknown) => ({})),
  transactionFailed: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {
    voiceAssistant: {
      findFirstOrThrow: mocks.findFirstOrThrow,
      update: mocks.unscopedUpdate,
      updateMany: mocks.unscopedUpdateMany,
    },
    $transaction: async (step: (tx: unknown) => Promise<unknown>) => {
      try {
        return await step({
          voiceAssistant: mocks.tenantDb().voiceAssistant,
          auditLog: { create: mocks.auditCreate },
        });
      } catch (error) {
        mocks.transactionFailed();
        throw error;
      }
    },
  },
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  EntitlementError: class extends Error {},
}));
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: mocks.upsertVapiAssistant,
  buyPhoneNumber: mocks.buyPhoneNumber,
}));
vi.mock("@/server/ai/tools", () => ({ TOOL_REGISTRY: [], zodToJsonSchema: vi.fn(() => ({})) }));
vi.mock("@/server/services/audit", () => ({
  audit: mocks.audit,
  auditLogData: async (_ctx: unknown, input: unknown) => input,
}));
vi.mock("@/env", () => ({
  getVapiEnv: () => ({
    VAPI_API_KEY: "test",
    VAPI_WEBHOOK_SECRET: "a".repeat(32),
    VAPI_WEBHOOK_CREDENTIAL_ID: "cred_test",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

const { activateAssistant, upsertAssistant, VoiceSyncFailedError } =
  await import("@/server/services/voice");

const ctx: TenantContext = {
  userId: "user-1",
  email: "u@example.com",
  orgId: "org-a",
  role: "OWNER",
  locale: "en",
};

const input = (overrides: Partial<VoiceAssistantInput> = {}): VoiceAssistantInput => ({
  name: "Reception",
  language: "FI",
  voiceProvider: "azure",
  voiceId: "",
  firstMessage: "Hei!",
  systemPrompt: "Olet avulias vastaanottovirkailija.",
  enabledTools: [],
  useKnowledgeBase: false,
  transferNumber: "",
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
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
  recordingEnabled: null,
  ...overrides,
});

type Mock = ReturnType<typeof vi.fn>;
let db: {
  voiceAssistant: { count: Mock; create: Mock; update: Mock; findFirstOrThrow: Mock };
  // Read by the sync's Business DNA context, which has none here.
  businessDNA: { findFirst: Mock };
  businessDnaService: { findMany: Mock };
};

beforeEach(() => {
  vi.clearAllMocks();
  db = {
    voiceAssistant: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({ ...row(), ...data, id: "new-assistant" })),
      update: vi.fn(async ({ data }) => ({ ...row(), ...data })),
      findFirstOrThrow: vi.fn(async () => row()),
    },
    businessDNA: { findFirst: vi.fn(async () => null) },
    businessDnaService: { findMany: vi.fn(async () => []) },
  };
  mocks.tenantDb.mockReturnValue(db);
});

const createdWith = () => db.voiceAssistant.create.mock.calls[0]![0].data;
const updatedWith = () => db.voiceAssistant.update.mock.calls[0]![0].data;
const sentToVapi = () => mocks.upsertVapiAssistant.mock.calls[0]![0].recordingEnabled;

describe("the form's choice", () => {
  it("accepts off, on and keep, and nothing else", () => {
    for (const recording of ["off", "on", "keep"]) {
      expect(voiceAssistantSchema.safeParse({ ...input(), recording }).success).toBe(true);
    }
    expect(voiceAssistantSchema.safeParse({ ...input(), recording: "true" }).success).toBe(false);
  });

  it("shows an assistant never set here as keep, and others as they are", () => {
    expect(recordingChoice(null)).toBe("keep");
    expect(recordingChoice(false)).toBe("off");
    expect(recordingChoice(true)).toBe("on");
  });

  it("applies off to an assistant not in Vapi, and leaves one there alone", () => {
    expect(recordingToApply(null, false)).toBe(false);
    expect(recordingToApply(null, true)).toBeNull();
    expect(recordingToApply(true, false)).toBe(true);
    expect(recordingToApply(false, true)).toBe(false);
  });

  it("makes keep, or no choice, mean off for a new assistant only", () => {
    expect(recordingEnabledFor(undefined, true)).toBe(false);
    expect(recordingEnabledFor("keep", true)).toBe(false);
    expect(recordingEnabledFor(undefined, false)).toBeUndefined();
    expect(recordingEnabledFor("keep", false)).toBeUndefined();
    expect(recordingEnabledFor("on", false)).toBe(true);
    expect(recordingEnabledFor("off", false)).toBe(false);
  });
});

describe("saving an assistant", () => {
  it("creates a new assistant with recording off by default", async () => {
    await upsertAssistant(ctx, input());
    expect(createdWith().recordingEnabled).toBe(false);
  });

  it("creates one with recording on only when chosen", async () => {
    await upsertAssistant(ctx, input({ recording: "on" }));
    expect(createdWith().recordingEnabled).toBe(true);
  });

  it("leaves an existing assistant's recording alone when kept", async () => {
    await upsertAssistant(ctx, input({ recording: "keep", name: "Renamed" }), "assistant-1");
    expect(updatedWith()).not.toHaveProperty("recordingEnabled");
    expect(updatedWith().name).toBe("Renamed");
  });

  it("stores an explicit choice for an existing assistant", async () => {
    await upsertAssistant(ctx, input({ recording: "off" }), "assistant-1");
    expect(updatedWith().recordingEnabled).toBe(false);
  });

  it("records the choice in the audit log", async () => {
    await upsertAssistant(ctx, input({ recording: "on" }));
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ after: expect.objectContaining({ recordingEnabled: true }) }),
    });
  });
});

describe("syncing to Vapi", () => {
  it("sends nothing for an assistant already in Vapi and never set here", async () => {
    mocks.findFirstOrThrow.mockResolvedValue(row({ vapiAssistantId: "vapi-1" }));
    await activateAssistant(ctx, "assistant-1");
    expect(sentToVapi()).toBeNull();
    expect(mocks.unscopedUpdate).not.toHaveBeenCalled();
    expect(mocks.unscopedUpdateMany).not.toHaveBeenCalled();
  });

  it("sends the stored choice for an assistant already in Vapi", async () => {
    mocks.findFirstOrThrow.mockResolvedValue(
      row({ vapiAssistantId: "vapi-1", recordingEnabled: true }),
    );
    await activateAssistant(ctx, "assistant-1");
    expect(sentToVapi()).toBe(true);
  });

  it("creates a Vapi assistant never set here with recording off, and stores that", async () => {
    // Also the case after deactivation, which deletes the Vapi assistant and its setting.
    mocks.findFirstOrThrow.mockResolvedValue(row());
    await activateAssistant(ctx, "assistant-1");
    expect(sentToVapi()).toBe(false);
    expect(mocks.unscopedUpdate).toHaveBeenCalledWith({
      where: { id: "assistant-1" },
      data: { vapiAssistantId: "vapi-1" },
    });
    // Only while still unset, so an "on" saved in the meantime isn't overwritten.
    expect(mocks.unscopedUpdateMany).toHaveBeenCalledWith({
      where: { id: "assistant-1", organizationId: "org-a", recordingEnabled: null },
      data: { recordingEnabled: false },
    });
  });

  it("records the recording applied when activating", async () => {
    mocks.findFirstOrThrow.mockResolvedValue(row());
    db.voiceAssistant.update.mockImplementation(async ({ data }) => ({
      ...row({ recordingEnabled: false }),
      ...data,
    }));
    await activateAssistant(ctx, "assistant-1");
    expect(mocks.audit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ after: expect.objectContaining({ recordingEnabled: false }) }),
    );
  });
});

describe("the audit trail when Vapi can't be reached", () => {
  const linked = row({ vapiAssistantId: "vapi-1", recordingEnabled: true });
  const providerError = "Vapi 500: secret-provider-detail";

  beforeEach(() => {
    db.voiceAssistant.findFirstOrThrow.mockResolvedValue(linked);
    mocks.findFirstOrThrow.mockResolvedValue({ ...linked, recordingEnabled: false });
    db.voiceAssistant.update.mockImplementation(async ({ data }) => ({ ...linked, ...data }));
  });

  it("records a saved change even though the sync fails, and reports that kind of failure", async () => {
    mocks.upsertVapiAssistant.mockRejectedValueOnce(new Error(providerError));

    await expect(upsertAssistant(ctx, input({ recording: "off" }), "assistant-1")).rejects.toThrow(
      VoiceSyncFailedError,
    );

    expect(updatedWith().recordingEnabled).toBe(false);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "voice_assistant.update",
        resourceId: "assistant-1",
        before: { recordingEnabled: true },
        after: expect.objectContaining({ recordingEnabled: false }),
      }),
    });
  });

  it("records that Vapi may still hold the old setting, without the provider's error", async () => {
    mocks.upsertVapiAssistant.mockRejectedValueOnce(new Error(providerError));

    const failure = await upsertAssistant(ctx, input({ recording: "off" }), "assistant-1").catch(
      (error: unknown) => error as Error,
    );

    expect(mocks.audit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        action: "voice_assistant.sync_failed",
        resourceId: "assistant-1",
        after: { recordingEnabled: false },
      }),
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret-provider-detail");
    expect((failure as Error).message).not.toContain("secret-provider-detail");
  });

  it("still reports the sync failure when that second audit row can't be written", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsertVapiAssistant.mockRejectedValueOnce(new Error(providerError));
    mocks.audit.mockRejectedValueOnce(new TypeError("audit database detail"));

    await expect(upsertAssistant(ctx, input({ recording: "off" }), "assistant-1")).rejects.toThrow(
      VoiceSyncFailedError,
    );

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toContain("voice_assistant_sync_failed_not_audited");
    expect(logged.mock.calls[0]![0]).toContain("TypeError");
    expect(logged.mock.calls[0]![0]).not.toContain("audit database detail");
    logged.mockRestore();
  });

  it("writes the audit row before contacting Vapi", async () => {
    await upsertAssistant(ctx, input({ recording: "off" }), "assistant-1");
    expect(mocks.auditCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.upsertVapiAssistant.mock.invocationCallOrder[0]!,
    );
  });

  it("writes one row when the sync succeeds", async () => {
    await upsertAssistant(ctx, input({ recording: "off" }), "assistant-1");
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("has no earlier value to record for a new assistant", async () => {
    await upsertAssistant(ctx, input());
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ before: expect.anything() }),
    });
  });

  it("changes nothing and doesn't contact Vapi when the audit row can't be written", async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit write failed"));

    await expect(upsertAssistant(ctx, input({ recording: "off" }), "assistant-1")).rejects.toThrow(
      "audit write failed",
    );

    expect(mocks.transactionFailed).toHaveBeenCalledTimes(1);
    expect(mocks.upsertVapiAssistant).not.toHaveBeenCalled();
  });

  it("scopes the save to the caller's organization", async () => {
    await upsertAssistant(ctx, input({ recording: "off" }), "assistant-1");
    expect(db.voiceAssistant.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "assistant-1", organizationId: "org-a" },
    });
    expect(db.voiceAssistant.update.mock.calls[0]![0].where).toEqual({
      id: "assistant-1",
      organizationId: "org-a",
    });
  });
});
