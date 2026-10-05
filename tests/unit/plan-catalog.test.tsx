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
  displayedMonthlyPriceEur,
  PLAN_LIMITS,
  PLAN_MONTHLY_PRICE_EUR,
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
    expect(displayedMonthlyPriceEur("STARTER", "annual")).toBe(24);
    expect(displayedMonthlyPriceEur("PRO", "annual")).toBe(66);
    expect(displayedMonthlyPriceEur("FREE", "annual")).toBe(0);
  });

  it("prices every self-serve plan above zero and lists it publicly", () => {
    for (const plan of SELF_SERVE_PLANS) {
      expect(PUBLIC_PLANS).toContain(plan);
      expect(PLAN_MONTHLY_PRICE_EUR[plan]).toBeGreaterThan(0);
    }
  });

  it("renders the public pricing page with the same numbers as before", async () => {
    const page = await PricingPage({ params: Promise.resolve({ locale: "en" }) });
    const { container } = render(page);
    const text = container.textContent ?? "";

    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("Starter")).toBeTruthy();
    expect(screen.getByText("Pro")).toBeTruthy();
    expect(text).toContain("€0");
    expect(text).toContain("€29");
    expect(text).toContain("€79");
    // Free: 2 seats, 50 pooled AI messages, no voice.
    expect(text).toContain("planSeats(2)");
    expect(text).toContain("planAiMessages(50)");
    expect(text).toContain("planVoiceNone");
    // Starter and Pro: per-user AI messages and voice minutes.
    expect(text).toContain("planSeats(10)");
    expect(text).toContain("planAiMessagesPerUser(1,000)");
    expect(text).toContain("planVoiceMinutes(100)");
    expect(text).toContain("planSeats(50)");
    expect(text).toContain("planAiMessagesPerUser(5,000)");
    expect(text).toContain("planVoiceMinutes(500)");
  });
});
