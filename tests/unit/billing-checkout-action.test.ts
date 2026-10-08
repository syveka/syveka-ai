import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An organization that already has a live subscription changes plan in the Stripe billing
 * portal. A second checkout would create a second subscription: the org is billed twice, and
 * events for the older subscription overwrite the newer one's state.
 */
const m = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  organizationFindUniqueOrThrow: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  createCheckoutSession: vi.fn(async () => "https://checkout.example/session"),
  createPortalSession: vi.fn(async () => "https://portal.example/session"),
}));

vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    orgId: "org-a",
    userId: "user-1",
    email: "owner@example.com",
    locale: "en",
  })),
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: { findUniqueOrThrow: m.organizationFindUniqueOrThrow, update: vi.fn() },
    subscription: { findUnique: m.subscriptionFindUnique },
  },
}));
vi.mock("@/server/integrations/stripe", () => ({
  getOrCreateCustomer: vi.fn(async () => "cus_1"),
  createCheckoutSession: m.createCheckoutSession,
  createPortalSession: m.createPortalSession,
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));

import { startCheckoutAction } from "@/actions/billing";

beforeEach(() => {
  vi.clearAllMocks();
  m.organizationFindUniqueOrThrow.mockResolvedValue({
    id: "org-a",
    name: "Acme",
    stripeCustomerId: "cus_1",
    members: [{ userId: "user-1" }],
  });
});

describe("startCheckoutAction", () => {
  for (const status of ["ACTIVE", "TRIALING", "PAST_DUE"]) {
    it(`sends an org with a ${status} subscription to the billing portal, never a second checkout`, async () => {
      m.subscriptionFindUnique.mockResolvedValueOnce({ stripeSubscriptionId: "sub_1", status });

      await expect(startCheckoutAction("PRO", "monthly")).rejects.toThrow(
        "NEXT_REDIRECT:https://portal.example/session",
      );
      expect(m.createCheckoutSession).not.toHaveBeenCalled();
    });
  }

  it("opens checkout for an org without a live subscription", async () => {
    m.subscriptionFindUnique.mockResolvedValueOnce({
      stripeSubscriptionId: null,
      status: "CANCELED",
    });

    await expect(startCheckoutAction("PRO", "monthly")).rejects.toThrow(
      "NEXT_REDIRECT:https://checkout.example/session",
    );
    expect(m.createPortalSession).not.toHaveBeenCalled();
  });
});
