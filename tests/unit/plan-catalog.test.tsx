// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next-intl/server", () => ({
  setRequestLocale: vi.fn(),
  getTranslations: vi.fn(async () => {
    const t = (key: string, values?: Record<string, string>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key;
    return t;
  }),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  annualMonthlyEquivalentEur,
  annualPriceEur,
  PLAN_LIMITS,
  PLAN_MONTHLY_PRICE_EUR,
  PRICING_PAGE_PLANS,
  PUBLIC_PLANS,
  SELF_SERVE_PLANS,
} from "@/lib/billing/plan-catalog";
import { PLAN_LIMITS as SERVER_PLAN_LIMITS } from "@/server/services/billing/plans";
import PricingPage from "../../src/app/[locale]/(marketing)/pricing/page";

/**
 * The pricing page, the in-app plan cards and entitlements used to hold
 * three copies of the plan numbers. They now read one catalog; these tests
 * pin today's displayed values so the refactor changed nothing visible.
 */
describe("plan catalog", () => {
  afterEach(cleanup);

  it("is the same object entitlements enforce", () => {
    expect(SERVER_PLAN_LIMITS).toBe(PLAN_LIMITS);
  });

  it("keeps today's displayed prices, monthly and annual (2 months free)", () => {
    expect(PLAN_MONTHLY_PRICE_EUR).toEqual({ FREE: 0, STARTER: 29, PRO: 79 });
    // Annual is charged once a year: 10 months of the monthly price.
    expect(annualPriceEur("STARTER")).toBe(290);
    expect(annualPriceEur("PRO")).toBe(790);
    expect(annualPriceEur("FREE")).toBe(0);
    // The monthly equivalent is unrounded, so 12 x it is the annual charge.
    expect(annualMonthlyEquivalentEur("STARTER") * 12).toBeCloseTo(290, 10);
    expect(annualMonthlyEquivalentEur("PRO").toFixed(2)).toBe("65.83");
  });

  it("prices every self-serve plan above zero and gives it a list price", () => {
    for (const plan of SELF_SERVE_PLANS) {
      expect(PUBLIC_PLANS).toContain(plan);
      expect(PLAN_MONTHLY_PRICE_EUR[plan]).toBeGreaterThan(0);
    }
  });

  it("shows only the free plan on the public pricing page during the pilot", async () => {
    expect(PRICING_PAGE_PLANS).toEqual(["FREE"]);

    const page = await PricingPage({ params: Promise.resolve({ locale: "en" }) });
    const { container } = render(page);
    const text = container.textContent ?? "";

    // Free: 2 seats, 50 pooled AI messages, from the catalog.
    expect(screen.getByText("Free")).toBeTruthy();
    expect(text).toContain("€0");
    expect(text).toContain("planSeats(2)");
    expect(text).toContain("planAiMessages(50)");
    // No paid plan, paid price or voice allowance may be promised
    // (docs/free-pilot-launch-runbook.md §15).
    expect(screen.queryByText("Starter")).toBeNull();
    expect(screen.queryByText("Pro")).toBeNull();
    expect(text).not.toContain("€29");
    expect(text).not.toContain("€79");
    expect(text).not.toMatch(/voice/i);
  });
});
