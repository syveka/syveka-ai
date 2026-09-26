import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, getBusinessDnaContextMock, getEmailChannelAdapterMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  getBusinessDnaContextMock: vi.fn(),
  getEmailChannelAdapterMock: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
}));
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: getBusinessDnaContextMock,
}));
vi.mock("@/server/channels/email", () => ({
  getEmailChannelAdapter: getEmailChannelAdapterMock,
  isInboundEmailConfigured: () =>
    Boolean(process.env.INBOX_EMAIL_DOMAIN && process.env.RESEND_INBOUND_WEBHOOK_SECRET),
}));

import { getOrgSetupReadiness } from "@/server/services/setup-readiness";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function emptyDna() {
  return {
    displayName: null,
    industry: null,
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

function baseDb() {
  return {
    bookingType: { count: vi.fn(async () => 0) },
    inboxMailbox: { findFirst: vi.fn(async () => ({ id: "mailbox-1" }) as { id: string } | null) },
    inboxThread: { findFirst: vi.fn(async (_args?: unknown) => null as { id: string } | null) },
    voiceAssistant: {
      findMany: vi.fn(
        async () => [] as Array<{ isActive: boolean; vapiAssistantId: string | null }>,
      ),
    },
    voiceCall: { findFirst: vi.fn(async () => null as { id: string } | null) },
  };
}

describe("getOrgSetupReadiness", () => {
  let db: ReturnType<typeof baseDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = baseDb();
    tenantDbMock.mockReturnValue(db);
    getBusinessDnaContextMock.mockResolvedValue(null);
    getEmailChannelAdapterMock.mockReturnValue({ provider: "MOCK", isConfigured: () => true });
    vi.stubEnv("INBOX_EMAIL_DOMAIN", "inbox.example.test");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("VAPI_API_KEY", "vapi-test-key");
    vi.stubEnv("VAPI_WEBHOOK_SECRET", "vapi-webhook-secret-0123456789");
    vi.stubEnv("VAPI_WEBHOOK_CREDENTIAL_ID", "cred-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks Business DNA setup_required when no profile exists", async () => {
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "businessDna")).toEqual({
      key: "businessDna",
      state: "setup_required",
    });
  });

  it("marks Business DNA setup_required when the profile has every field empty", async () => {
    getBusinessDnaContextMock.mockResolvedValue(emptyDna());
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "businessDna")?.state).toBe("setup_required");
  });

  it("marks Business DNA ready once at least one fact is present", async () => {
    getBusinessDnaContextMock.mockResolvedValue({ ...emptyDna(), displayName: "Acme" });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "businessDna")?.state).toBe("ready");
  });

  it("marks the email channel not_configured while on the mock provider", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "MOCK", isConfigured: () => true });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")).toEqual({
      key: "emailChannel",
      state: "not_configured",
      hint: "email_outbound_not_configured",
    });
  });

  it("marks the email channel not_configured when Resend is selected but unconfigured", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => false });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")?.state).toBe("not_configured");
  });

  it("marks the email channel verification_required when Resend is configured but no real inbound email has been received", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    db.inboxThread.findFirst.mockResolvedValue(null);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")).toEqual({
      key: "emailChannel",
      state: "verification_required",
      hint: "email_awaiting_first_inbound",
    });
  });

  it.each([["INBOX_EMAIL_DOMAIN"], ["RESEND_INBOUND_WEBHOOK_SECRET"]])(
    "marks the email channel setup_required (not verification_required) when %s is missing — inbound mail cannot arrive",
    async (missing) => {
      getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
      vi.stubEnv(missing, "");
      const items = await getOrgSetupReadiness(ctx());
      expect(items.find((i) => i.key === "emailChannel")).toEqual({
        key: "emailChannel",
        state: "setup_required",
        hint: "email_inbound_not_configured",
      });
    },
  );

  it("marks the email channel setup_required when the org has no inbound mailbox provisioned", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    db.inboxMailbox.findFirst.mockResolvedValue(null);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")).toEqual({
      key: "emailChannel",
      state: "setup_required",
      hint: "email_mailbox_not_provisioned",
    });
    expect(db.inboxMailbox.findFirst).toHaveBeenCalledWith({
      where: { channel: "EMAIL" },
      select: { id: true },
    });
  });

  function mockEmailEvidence(evidence: { inbound: boolean; outbound: boolean }) {
    db.inboxThread.findFirst.mockImplementation(async (args: unknown) => {
      const direction = (args as { where: { messages: { some: { direction: string } } } }).where
        .messages.some.direction;
      const present = direction === "INBOUND" ? evidence.inbound : evidence.outbound;
      return present ? { id: `thread-${direction}` } : null;
    });
  }

  it("keeps the email channel at verification_required after a real inbound email until a real reply is sent", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    mockEmailEvidence({ inbound: true, outbound: false });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")).toEqual({
      key: "emailChannel",
      state: "verification_required",
      hint: "email_awaiting_first_reply",
    });
  });

  it("never counts an outbound send without an inbound email as ready", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    mockEmailEvidence({ inbound: false, outbound: true });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")?.hint).toBe("email_awaiting_first_inbound");
  });

  it("marks the email channel ready only with real inbound AND real (non-mock) outbound evidence", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    mockEmailEvidence({ inbound: true, outbound: true });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")).toEqual({
      key: "emailChannel",
      state: "ready",
    });
    expect(db.inboxThread.findFirst).toHaveBeenCalledWith({
      where: {
        channel: "EMAIL",
        deletedAt: null,
        messages: { some: { direction: "INBOUND", externalId: { not: null } } },
      },
      select: { id: true },
    });
    expect(db.inboxThread.findFirst).toHaveBeenCalledWith({
      where: {
        channel: "EMAIL",
        deletedAt: null,
        messages: {
          some: {
            direction: "OUTBOUND",
            status: "SENT",
            AND: [
              { externalId: { not: null } },
              { NOT: { externalId: { startsWith: "mock-email-" } } },
            ],
          },
        },
      },
      select: { id: true },
    });
  });

  it("never reports Email or Voice ready from configuration alone", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    db.voiceAssistant.findMany.mockResolvedValue([{ isActive: true, vapiAssistantId: "v-1" }]);
    mockEmailEvidence({ inbound: false, outbound: false });
    db.voiceCall.findFirst.mockResolvedValue(null);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")?.state).not.toBe("ready");
    expect(items.find((i) => i.key === "voice")?.state).not.toBe("ready");
  });

  it("marks booking setup_required with zero active booking types", async () => {
    db.bookingType.count.mockResolvedValue(0);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "booking")?.state).toBe("setup_required");
  });

  it("marks booking ready once at least one active type exists, scoped to active+not-deleted", async () => {
    db.bookingType.count.mockResolvedValue(2);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "booking")?.state).toBe("ready");
    expect(db.bookingType.count).toHaveBeenCalledWith({
      where: { isActive: true, deletedAt: null },
    });
  });

  it("always reports CRM as ready — no external configuration is required", async () => {
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "crm")).toEqual({ key: "crm", state: "ready" });
  });

  it("marks voice not_configured when the Vapi integration's config is missing", async () => {
    vi.stubEnv("VAPI_WEBHOOK_CREDENTIAL_ID", "");
    db.voiceAssistant.findMany.mockResolvedValue([{ isActive: true, vapiAssistantId: "v-1" }]);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")).toEqual({
      key: "voice",
      state: "not_configured",
      hint: "voice_provider_not_configured",
    });
  });

  it("marks voice setup_required with a create hint when the org has no voice assistant", async () => {
    db.voiceAssistant.findMany.mockResolvedValue([]);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")).toEqual({
      key: "voice",
      state: "setup_required",
      hint: "voice_no_assistant",
    });
  });

  it("marks voice setup_required with a sync hint when no assistant is linked to Vapi", async () => {
    db.voiceAssistant.findMany.mockResolvedValue([{ isActive: false, vapiAssistantId: null }]);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")).toEqual({
      key: "voice",
      state: "setup_required",
      hint: "voice_assistant_not_synced",
    });
  });

  it("marks voice setup_required with a phone-number hint when synced but never activated", async () => {
    db.voiceAssistant.findMany.mockResolvedValue([{ isActive: false, vapiAssistantId: "v-1" }]);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")).toEqual({
      key: "voice",
      state: "setup_required",
      hint: "voice_phone_number_missing",
    });
  });

  it("does not count an isActive flag on an unsynced assistant as call-ready", async () => {
    db.voiceAssistant.findMany.mockResolvedValue([
      { isActive: true, vapiAssistantId: null },
      { isActive: false, vapiAssistantId: "v-2" },
    ]);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")?.hint).toBe("voice_phone_number_missing");
  });

  it("marks voice verification_required once active but with no completed call yet", async () => {
    db.voiceAssistant.findMany.mockResolvedValue([{ isActive: true, vapiAssistantId: "v-1" }]);
    db.voiceCall.findFirst.mockResolvedValue(null);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")).toEqual({
      key: "voice",
      state: "verification_required",
      hint: "voice_awaiting_first_call",
    });
  });

  it("marks voice ready once active and at least one call has completed", async () => {
    db.voiceAssistant.findMany.mockResolvedValue([{ isActive: true, vapiAssistantId: "v-1" }]);
    db.voiceCall.findFirst.mockResolvedValue({ id: "call-1" });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")).toEqual({ key: "voice", state: "ready" });
    expect(db.voiceCall.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "COMPLETED",
          assistant: { isActive: true, vapiAssistantId: { not: null } },
        },
      }),
    );
  });

  it("scopes every read to the caller's org (tenant isolation)", async () => {
    await getOrgSetupReadiness(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
    expect(getBusinessDnaContextMock).toHaveBeenCalledWith("org-b");
  });
});
