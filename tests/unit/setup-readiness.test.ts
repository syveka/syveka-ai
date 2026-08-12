import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const {
  tenantDbMock,
  getBusinessDnaContextMock,
  getEmailChannelAdapterMock,
  bookingTypeCountMock,
} = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  getBusinessDnaContextMock: vi.fn(),
  getEmailChannelAdapterMock: vi.fn(),
  bookingTypeCountMock: vi.fn(),
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

describe("getOrgSetupReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantDbMock.mockReturnValue({ bookingType: { count: bookingTypeCountMock } });
    bookingTypeCountMock.mockResolvedValue(0);
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

  it("marks the email channel ready when Resend is configured", async () => {
    getEmailChannelAdapterMock.mockReturnValue({ provider: "RESEND", isConfigured: () => true });
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "emailChannel")?.state).toBe("ready");
  });

  it("marks booking setup_required with zero active booking types", async () => {
    bookingTypeCountMock.mockResolvedValue(0);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "booking")?.state).toBe("setup_required");
  });

  it("marks booking ready once at least one active type exists, scoped to active+not-deleted", async () => {
    bookingTypeCountMock.mockResolvedValue(2);
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "booking")?.state).toBe("ready");
    expect(bookingTypeCountMock).toHaveBeenCalledWith({
      where: { isActive: true, deletedAt: null },
    });
  });

  it("always reports CRM as ready — no external configuration is required", async () => {
    const items = await getOrgSetupReadiness(ctx());
    expect(items.find((i) => i.key === "crm")).toEqual({ key: "crm", state: "ready" });
  });

  it("scopes every read to the caller's org (tenant isolation)", async () => {
    await getOrgSetupReadiness(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
    expect(getBusinessDnaContextMock).toHaveBeenCalledWith("org-b");
  });
});
