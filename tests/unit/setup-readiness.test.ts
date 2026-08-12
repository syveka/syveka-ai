import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

import { getOrgSetupReadiness } from "@/server/services/setup-readiness";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function emptyDna() {
  return {
    displayName: null,
    industry: null,
    productsServices: null,
    supportedLocales: [],
    brandTone: null,
    communicationStyle: null,
    openingHours: null,
    policies: null,
    pricingNotes: null,
    targetCustomer: null,
    keyFacts: [],
  };
}

function baseDb() {
  return {
    bookingType: { count: vi.fn(async () => 0) },
    inboxThread: { findFirst: vi.fn(async () => null as { id: string } | null) },
    voiceAssistant: { findFirst: vi.fn(async () => null as { id: string } | null) },
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
    expect(items.find((i) => i.key === "emailChannel")?.state).toBe("verification_required");
  });

  it("marks the email channel ready when Resend is configured and a real inbound email has been received", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    db.inboxThread.findFirst.mockResolvedValue({ id: "thread-1" });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")?.state).toBe("ready");
    expect(db.inboxThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channel: "EMAIL",
          messages: { some: { direction: "INBOUND", externalId: { not: null } } },
        }),
      }),
    );
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

  it("marks voice setup_required when the org has no active voice assistant", async () => {
    db.voiceAssistant.findFirst.mockResolvedValue(null);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")?.state).toBe("setup_required");
  });

  it("marks voice verification_required once active but with no completed call yet", async () => {
    db.voiceAssistant.findFirst.mockResolvedValue({ id: "assistant-1" });
    db.voiceCall.findFirst.mockResolvedValue(null);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")?.state).toBe("verification_required");
  });

  it("marks voice ready once active and at least one call has completed", async () => {
    db.voiceAssistant.findFirst.mockResolvedValue({ id: "assistant-1" });
    db.voiceCall.findFirst.mockResolvedValue({ id: "call-1" });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "voice")?.state).toBe("ready");
    expect(db.voiceCall.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "COMPLETED" } }),
    );
  });

  it("scopes every read to the caller's org (tenant isolation)", async () => {
    await getOrgSetupReadiness(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
    expect(getBusinessDnaContextMock).toHaveBeenCalledWith("org-b");
  });
});
