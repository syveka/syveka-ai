import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plan cards' server action: permission first, only self-serve plans and
 * intervals, then wherever startPlanChange says (Checkout or Billing Portal),
 * or back to the billing page with the refusal reason.
 */

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({
    orgId: "org-a",
    userId: "user-a",
    email: "a@a.test",
    locale: "en",
  })),
  startPlanChange: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/billing/plan-change", () => ({
  startPlanChange: mocks.startPlanChange,
}));

import { startCheckoutAction } from "@/actions/billing";

beforeEach(() => vi.clearAllMocks());

describe("startCheckoutAction", () => {
  it("requires billing:manage before anything else", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(startCheckoutAction("PRO", "monthly")).rejects.toThrow("Forbidden");
    expect(mocks.startPlanChange).not.toHaveBeenCalled();
  });

  it.each([
    ["checkout", "https://checkout.test/cs_1"],
    ["portal", "https://portal.test/cus_a"],
  ])("follows a %s result", async (kind, url) => {
    mocks.startPlanChange.mockResolvedValueOnce({ kind, url });
    await expect(startCheckoutAction("PRO", "annual")).rejects.toThrow(`NEXT_REDIRECT:${url}`);
  });

  it.each(["busy", "unavailable"])(
    "a %s refusal returns to the billing page saying so",
    async (reason) => {
      mocks.startPlanChange.mockResolvedValueOnce({ kind: "refused", reason });
      await expect(startCheckoutAction("STARTER", "monthly")).rejects.toThrow(
        `NEXT_REDIRECT:/settings/billing?status=${reason}`,
      );
    },
  );

  it.each([
    ["FREE", "monthly"],
    ["ENTERPRISE", "monthly"],
    ["PRO", "weekly"],
  ])(
    "refuses a non-self-serve choice (%s, %s) without starting anything",
    async (plan, interval) => {
      await expect(startCheckoutAction(plan as "PRO", interval as "monthly")).rejects.toThrow(
        "NEXT_REDIRECT:/settings/billing",
      );
      expect(mocks.startPlanChange).not.toHaveBeenCalled();
    },
  );
});
