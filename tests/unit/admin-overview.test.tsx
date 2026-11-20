import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import AdminOverviewPage from "@/app/[locale]/(superadmin)/admin/page";

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  countOrganizations: vi.fn(),
  groupSubscriptions: vi.fn(),
  groupUsage: vi.fn(),
  aggregateUsage: vi.fn(),
}));

vi.mock("@/server/auth/superadmin", () => ({ requireSuperadmin: mocks.requireSuperadmin }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: { count: mocks.countOrganizations },
    subscription: { groupBy: mocks.groupSubscriptions },
    usageRecord: { groupBy: mocks.groupUsage, aggregate: mocks.aggregateUsage },
  },
}));
vi.mock("@/i18n/routing", () => ({ Link: "a" }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () =>
    createTranslator({ locale: "en", messages, namespace: "platformAdmin" }),
}));

describe("platform admin overview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-12T00:00:00Z"));
    mocks.requireSuperadmin.mockResolvedValue({ userId: "admin-1" });
    mocks.countOrganizations.mockResolvedValue(124);
    mocks.groupSubscriptions.mockResolvedValue([
      { plan: "FREE", _count: { _all: 6 } },
      { plan: "PRO", _count: { _all: 3 } },
    ]);
    mocks.groupUsage.mockResolvedValue([
      { periodStart: new Date("2025-12-01T00:00:00Z"), _sum: { quantity: 27 } },
      { periodStart: new Date("2026-01-01T00:00:00Z"), _sum: { quantity: 5 } },
      { periodStart: new Date("2026-01-11T00:00:00Z"), _sum: { quantity: 7 } },
    ]);
    mocks.aggregateUsage.mockResolvedValue({ _sum: { quantity: 19 } });
  });

  afterEach(() => vi.useRealTimers());

  it("rejects unauthorized requests before executing platform-wide queries", async () => {
    mocks.requireSuperadmin.mockRejectedValue(new Error("Superadmin required"));

    await expect(AdminOverviewPage()).rejects.toThrow("Superadmin required");
    expect(mocks.countOrganizations).not.toHaveBeenCalled();
    expect(mocks.groupSubscriptions).not.toHaveBeenCalled();
    expect(mocks.groupUsage).not.toHaveBeenCalled();
    expect(mocks.aggregateUsage).not.toHaveBeenCalled();
  });

  it("shows platform totals and calendar-month activity across the year boundary", async () => {
    const markup = renderToStaticMarkup(await AdminOverviewPage());
    const values = Array.from(markup.matchAll(/<dd[^>]*>(\d+)<\/dd>/g), (match) => match[1]);

    expect(values).toEqual(["124", "3", "12", "19"]);
    expect(markup).toContain("December 2025");
    expect(markup).toContain("Active subscriptions: 9");
    expect(mocks.countOrganizations).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(mocks.groupUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organization: { deletedAt: null },
          metric: "AI_MESSAGES",
          periodStart: {
            gte: new Date("2025-08-01T00:00:00Z"),
            lt: new Date("2026-02-01T00:00:00Z"),
          },
        },
      }),
    );
    expect(mocks.groupSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ACTIVE", organization: { deletedAt: null } } }),
    );
  });
});
