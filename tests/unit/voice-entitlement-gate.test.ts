import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EntitlementsModule from "@/server/services/billing/entitlements";
import type { TenantContext } from "@/server/auth/session";

/**
 * Voice receptionist entitlement gate. activateAssistant (which buys a Vapi
 * number), attachPhoneNumber (Vapi number import), assistant edits and the
 * Business DNA re-sync used to reach the paid provider with no plan check at
 * all: only creation counted against the plan. An organization whose plan
 * plus grants includes no voice assistant (FREE, so every pilot) is now
 * refused before any provider call, keeps Deactivate, and sees no Voice UI
 * unless it already has an assistant. No real provider call is made here.
 */
const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  upsertVapiAssistant: vi.fn(async () => ({ id: "vapi-1" })),
  buyPhoneNumber: vi.fn(async () => ({ id: "num-1", number: "+15550000001" })),
  importPhoneNumber: vi.fn(async () => ({ id: "num-2", number: "+358401234567" })),
  deleteVapiAssistant: vi.fn(async () => undefined),
  assistant: {} as Record<string, unknown>,
  tenantUpdate: vi.fn(),
  tenantFindMany: vi.fn(),
  txUpdate: vi.fn(),
}));

vi.mock("@/server/services/billing/entitlements", async () => ({
  ...(await vi.importActual<typeof EntitlementsModule>("@/server/services/billing/entitlements")),
  getEntitlements: mocks.getEntitlements,
}));
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: mocks.upsertVapiAssistant,
  buyPhoneNumber: mocks.buyPhoneNumber,
  importPhoneNumber: mocks.importPhoneNumber,
  deleteVapiAssistant: mocks.deleteVapiAssistant,
}));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    voiceAssistant: {
      findFirstOrThrow: async () => mocks.assistant,
      update: mocks.tenantUpdate,
      findMany: mocks.tenantFindMany,
      count: async () => 1,
    },
  }),
  unscopedPrisma: {
    voiceAssistant: {
      findFirstOrThrow: async () => mocks.assistant,
      findFirst: async () => null,
      update: vi.fn(),
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        voiceAssistant: { findFirst: async () => null, update: mocks.txUpdate },
        $executeRaw: vi.fn(),
      }),
  },
}));
vi.mock("@/server/ai/tools", () => ({ TOOL_REGISTRY: [], zodToJsonSchema: vi.fn(() => ({})) }));
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: async () => null,
  buildBusinessDnaPromptBlock: vi.fn(() => null),
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/env", () => ({
  getVapiEnv: () => ({
    VAPI_API_KEY: "test",
    VAPI_WEBHOOK_SECRET: "a".repeat(32),
    VAPI_WEBHOOK_CREDENTIAL_ID: "cred_test",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

import {
  activateAssistant,
  attachPhoneNumber,
  deactivateAssistant,
  resyncActiveAssistants,
  upsertAssistant,
} from "@/server/services/voice";
import { EntitlementError } from "@/server/services/billing/entitlements";
import { voiceAccessFrom } from "@/server/services/voice-access";
import { NAV, visibleNavItems } from "@/components/layout/nav-items";
import { permissionsFor } from "@/server/auth/permissions";
import type { VoiceAssistantInput } from "@/lib/validators/voice";

const ctx = (orgId = "org-a"): TenantContext => ({
  userId: "user-1",
  email: "owner@example.com",
  orgId,
  role: "OWNER",
  locale: "en",
});
const input: VoiceAssistantInput = {
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
const twilio = {
  provider: "twilio",
  phoneNumber: "+358401234567",
  twilioAccountSid: "AC_test",
  twilioAuthToken: "test-token",
} as const;
const linked = {
  id: "assistant-1",
  organizationId: "org-a",
  name: "Front desk",
  language: "FI",
  voiceProvider: "azure",
  voiceId: null,
  firstMessage: "Hei!",
  systemPrompt: "You answer calls.",
  enabledTools: [],
  transferNumber: null,
  isActive: true,
  phoneNumber: null,
  vapiAssistantId: "vapi-1",
};
const providerCalls = () => [
  mocks.upsertVapiAssistant,
  mocks.buyPhoneNumber,
  mocks.importPhoneNumber,
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assistant = { ...linked };
  mocks.tenantUpdate.mockImplementation(async ({ data }: { data: object }) => ({
    ...linked,
    ...data,
  }));
  mocks.txUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...linked, ...data }));
  mocks.tenantFindMany.mockResolvedValue([{ id: "assistant-1" }]);
});

describe("an organization whose plan includes no voice (FREE, pilot)", () => {
  beforeEach(() => mocks.getEntitlements.mockResolvedValue({ voiceAssistants: 0 }));

  it("activateAssistant is refused before any sync or number purchase", async () => {
    await expect(activateAssistant(ctx(), "assistant-1")).rejects.toBeInstanceOf(EntitlementError);
    await expect(activateAssistant(ctx(), "assistant-1")).rejects.toMatchObject({
      code: "entitlement_exceeded",
      limit: "voiceAssistants",
    });
    for (const call of providerCalls()) expect(call).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it("attachPhoneNumber is refused before any number import", async () => {
    await expect(attachPhoneNumber(ctx(), "assistant-1", twilio)).rejects.toMatchObject({
      code: "entitlement_exceeded",
    });
    for (const call of providerCalls()) expect(call).not.toHaveBeenCalled();
    expect(mocks.txUpdate).not.toHaveBeenCalled();
  });

  it("an edit of a linked assistant is refused before the write and the re-sync", async () => {
    await expect(upsertAssistant(ctx(), input, "assistant-1")).rejects.toBeInstanceOf(
      EntitlementError,
    );
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
    expect(mocks.upsertVapiAssistant).not.toHaveBeenCalled();
  });

  it("the Business DNA re-sync makes no provider call and never throws", async () => {
    await expect(resyncActiveAssistants("org-a")).resolves.toBeUndefined();
    expect(mocks.tenantFindMany).not.toHaveBeenCalled();
    expect(mocks.upsertVapiAssistant).not.toHaveBeenCalled();
  });

  it("can still deactivate an existing assistant", async () => {
    const result = await deactivateAssistant(ctx(), "assistant-1");
    expect(result.isActive).toBe(false);
    expect(mocks.deleteVapiAssistant).toHaveBeenCalledWith("vapi-1");
  });
});

describe("an organization whose plan includes voice behaves as before", () => {
  beforeEach(() => mocks.getEntitlements.mockResolvedValue({ voiceAssistants: 1 }));

  it("activateAssistant syncs and provisions a number", async () => {
    const { assistant } = await activateAssistant(ctx(), "assistant-1");
    expect(mocks.upsertVapiAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.buyPhoneNumber).toHaveBeenCalledWith("vapi-1");
    expect(assistant.isActive).toBe(true);
  });

  it("attachPhoneNumber imports the number", async () => {
    await attachPhoneNumber(ctx(), "assistant-1", twilio);
    expect(mocks.importPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("an edit re-syncs a linked assistant, and the Business DNA re-sync runs", async () => {
    await upsertAssistant(ctx(), input, "assistant-1");
    expect(mocks.upsertVapiAssistant).toHaveBeenCalledTimes(1);
    await resyncActiveAssistants("org-a");
    expect(mocks.upsertVapiAssistant).toHaveBeenCalledTimes(2);
  });
});

describe("Voice visibility", () => {
  it("is shown when entitled, or read-only while an assistant exists", () => {
    expect(voiceAccessFrom({ voiceAssistants: 0 }, 0)).toEqual({
      entitled: false,
      hasAssistant: false,
      visible: false,
    });
    expect(voiceAccessFrom({ voiceAssistants: 0 }, 1)).toMatchObject({
      entitled: false,
      visible: true,
    });
    expect(voiceAccessFrom({ voiceAssistants: 1 }, 0)).toMatchObject({
      entitled: true,
      visible: true,
    });
  });

  it("the shared nav (desktop and mobile) drops only the Voice entry when hidden", () => {
    const owner = permissionsFor("OWNER");
    const shown = visibleNavItems(owner).map((i) => i.href);
    const hidden = visibleNavItems(owner, true).map((i) => i.href);
    expect(shown).toContain("/voice");
    expect(hidden).not.toContain("/voice");
    expect(hidden).toEqual(shown.filter((href) => href !== "/voice"));
    expect(NAV.some((i) => i.href === "/voice")).toBe(true);
  });
});
