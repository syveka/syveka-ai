import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Coverage for deactivateAssistant() (src/server/services/voice.ts) -- found
 * missing entirely during an adversarial rollback-safety review: there was
 * previously no operator-facing way to stop a Voice assistant at all, and
 * the webhook never checked isActive, so even manually flipping the DB flag
 * would have been cosmetic (see tests/unit/voice-webhook.test.ts for the
 * webhook-side enforcement half of this fix).
 */
const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  deleteVapiAssistant: vi.fn(),
  auditMock: vi.fn(async (_ctx: unknown, _input: unknown) => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {},
}));
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: vi.fn(),
  buyPhoneNumber: vi.fn(),
  deleteVapiAssistant: mocks.deleteVapiAssistant,
}));
vi.mock("@/server/services/audit", () => ({ audit: mocks.auditMock }));

import { deactivateAssistant } from "@/server/services/voice";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function assistantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "assistant-1",
    organizationId: "org-a",
    vapiAssistantId: "vapi-assistant-1",
    phoneNumber: "+358401234567",
    isActive: true,
    ...overrides,
  };
}

describe("deactivateAssistant", () => {
  let db: {
    voiceAssistant: {
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.deleteVapiAssistant.mockResolvedValue(undefined);
  });

  it("sets isActive: false and clears vapiAssistantId/phoneNumber so a re-activation is a clean restart", async () => {
    const result = await deactivateAssistant(ctx(), "assistant-1");

    expect(result.isActive).toBe(false);
    expect(result.vapiAssistantId).toBeNull();
    expect(result.phoneNumber).toBeNull();
  });

  it("deletes the Vapi-side assistant so Vapi itself stops answering the number", async () => {
    await deactivateAssistant(ctx(), "assistant-1");

    expect(mocks.deleteVapiAssistant).toHaveBeenCalledWith("vapi-assistant-1");
  });

  it("still deactivates (DB-side) even when the Vapi deletion fails -- the guaranteed containment must not depend on the external call", async () => {
    const providerSecret = "provider-secret-must-not-be-logged";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteVapiAssistant.mockRejectedValue(
      new Error(`Vapi is unreachable: ${providerSecret}`),
    );

    const result = await deactivateAssistant(ctx(), "assistant-1");

    expect(result.isActive).toBe(false);
    expect(db.voiceAssistant.update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(providerSecret);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"errorType":"Error"'));
    consoleSpy.mockRestore();
  });

  it("skips the Vapi delete call entirely for an assistant that was never synced", async () => {
    db.voiceAssistant.findFirstOrThrow.mockResolvedValue(
      assistantRow({ vapiAssistantId: null, phoneNumber: null }),
    );

    await deactivateAssistant(ctx(), "assistant-1");

    expect(mocks.deleteVapiAssistant).not.toHaveBeenCalled();
  });

  it("audits the deactivation", async () => {
    await deactivateAssistant(ctx(), "assistant-1");

    expect(mocks.auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "voice_assistant.deactivate" }),
    );
  });
});
