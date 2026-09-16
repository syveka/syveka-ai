import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { VoiceAssistantInput } from "@/lib/validators/voice";

/**
 * Dedicated coverage for upsertAssistant()'s entitlement gate
 * (src/server/services/voice.ts) -- this throw is the only thing standing
 * between a FREE-plan org and unlimited Voice assistants, and had no direct
 * test before this file (voice-business-dna.test.ts and
 * voice-activation-*.test.ts both cover activateAssistant, not the create
 * path's own limit check).
 */
const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  getEntitlements: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  upsertVapiAssistant: vi.fn(),
  buyPhoneNumber: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: { voiceAssistant: { findFirstOrThrow: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
}));
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: mocks.upsertVapiAssistant,
  buyPhoneNumber: mocks.buyPhoneNumber,
}));
vi.mock("@/server/services/audit", () => ({ audit: mocks.auditMock }));

import { upsertAssistant } from "@/server/services/voice";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function input(overrides: Partial<VoiceAssistantInput> = {}): VoiceAssistantInput {
  return {
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
  };
}

describe("upsertAssistant — entitlement gate on creation", () => {
  let db: {
    voiceAssistant: {
      count: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      voiceAssistant: {
        count: vi.fn(),
        create: vi.fn(async ({ data }) => ({
          id: "new-assistant",
          vapiAssistantId: null,
          ...data,
        })),
        update: vi.fn(async ({ data }) => ({ id: "assistant-1", vapiAssistantId: null, ...data })),
      },
    };
    mocks.tenantDb.mockReturnValue(db);
  });

  it("rejects a new assistant once the org is already at its plan's limit", async () => {
    mocks.getEntitlements.mockResolvedValue({ voiceAssistants: 1 });
    db.voiceAssistant.count.mockResolvedValue(1);

    await expect(upsertAssistant(ctx(), input())).rejects.toThrow(
      "Voice assistant limit reached for your plan",
    );
    expect(db.voiceAssistant.create).not.toHaveBeenCalled();
  });

  it("allows creation while strictly under the limit", async () => {
    mocks.getEntitlements.mockResolvedValue({ voiceAssistants: 2 });
    db.voiceAssistant.count.mockResolvedValue(1);

    const assistant = await upsertAssistant(ctx(), input());

    expect(assistant.id).toBe("new-assistant");
    expect(db.voiceAssistant.create).toHaveBeenCalledTimes(1);
  });

  it("counts an internal-pilot entitlement grant toward the limit (0 + 1 grant = exactly 1 allowed)", async () => {
    // Mirrors the FREE-plan + VOICE_ASSISTANTS grant path used for the
    // Syveka Test pilot org: getEntitlements() already sums plan baseline +
    // active grants (src/server/services/billing/entitlements.ts) -- this
    // just proves upsertAssistant() correctly enforces whatever number it
    // returns, without re-deriving the grant math itself.
    mocks.getEntitlements.mockResolvedValue({ voiceAssistants: 1 });
    db.voiceAssistant.count.mockResolvedValue(0);

    const assistant = await upsertAssistant(ctx(), input());

    expect(assistant.id).toBe("new-assistant");
  });

  it("does not re-check or re-count the limit when updating an existing assistant", async () => {
    db.voiceAssistant.update.mockResolvedValue({
      id: "assistant-1",
      vapiAssistantId: null,
    });

    await upsertAssistant(ctx(), input({ name: "Renamed" }), "assistant-1");

    expect(mocks.getEntitlements).not.toHaveBeenCalled();
    expect(db.voiceAssistant.count).not.toHaveBeenCalled();
    expect(db.voiceAssistant.update).toHaveBeenCalledTimes(1);
  });
});
