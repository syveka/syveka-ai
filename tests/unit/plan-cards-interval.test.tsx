// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * Billing interval control: an accessible toggle group whose choice still
 * drives the same prices and the same checkout arguments. Only the checkout
 * server action is mocked (to observe what it would be bound with).
 */
const bindCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/actions/billing", () => ({
  startCheckoutAction: {
    bind: (...args: unknown[]) => {
      bindCalls.push(args.slice(1));
      return async () => {};
    },
  },
}));

import { PlanCards } from "@/components/billing/plan-cards";

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));

function renderCards(locale: "en" | "fi" | "ar") {
  const messages = load(locale);
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <PlanCards currentPlan="STARTER" />
    </NextIntlClientProvider>,
  );
  return messages.billingPage;
}

afterEach(() => {
  cleanup();
  bindCalls.length = 0;
});

/** Prices as each locale writes them (Arabic: Latin digits after a right-to-left mark). */
const PRICES = {
  en: { monthly: ["€29", "€79"], annual: ["€290", "€790"], equivalent: ["€24.17", "€65.83"] },
  fi: {
    monthly: ["29\u00a0€", "79\u00a0€"],
    annual: ["290\u00a0€", "790\u00a0€"],
    equivalent: ["24,17\u00a0€", "65,83\u00a0€"],
  },
  ar: {
    monthly: ["\u200f29\u00a0€", "\u200f79\u00a0€"],
    annual: ["\u200f290\u00a0€", "\u200f790\u00a0€"],
    equivalent: ["\u200f24.17\u00a0€", "\u200f65.83\u00a0€"],
  },
};

describe.each(["en", "fi", "ar"] as const)("PlanCards interval toggle (%s)", (locale) => {
  it("is a labelled group of two non-submitting toggle buttons", () => {
    const m = renderCards(locale);
    const group = screen.getByRole("group", { name: m.intervalLabel });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([m.interval.monthly, m.interval.annual]);
    expect(buttons.map((b) => b.getAttribute("type"))).toEqual(["button", "button"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("switching to annual keeps the same price rule and checkout arguments", () => {
    const m = renderCards(locale);
    const text = () => document.body.textContent ?? "";
    for (const price of PRICES[locale].monthly) expect(text()).toContain(price);
    expect(text()).toContain(m.priceMonthlyUnit);
    expect(text()).not.toMatch(/€\s*\//); // no "€/user/mo" slash form
    expect(bindCalls).toContainEqual(["PRO", "monthly"]);

    fireEvent.click(screen.getByRole("button", { name: m.interval.annual }));
    expect(
      screen.getByRole("button", { name: m.interval.annual }).getAttribute("aria-pressed"),
    ).toBe("true");
    // The yearly charge (10 x monthly) and its exact monthly equivalent;
    // never a rounded figure (24, 66) whose 12 x differs from the charge.
    for (const price of [...PRICES[locale].annual, ...PRICES[locale].equivalent]) {
      expect(text()).toContain(price);
    }
    expect(text()).toContain(m.priceAnnualUnit);
    expect(text()).not.toMatch(/(^|[^\d.,])(24|66)(\u00a0€|$)/);
    expect(bindCalls).toContainEqual(["PRO", "annual"]);
    expect(bindCalls).toContainEqual(["STARTER", "annual"]);
  });

  it("the current plan stays marked but can switch its billing interval", () => {
    const m = renderCards(locale);
    const monthly = screen.getByRole("button", { name: m.useThisInterval });
    expect(monthly.hasAttribute("disabled")).toBe(false);
    expect(screen.getAllByText(m.current)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: m.interval.annual }));
    const annual = screen.getByRole("button", { name: m.useThisInterval });
    expect(annual.hasAttribute("disabled")).toBe(false);
    expect(bindCalls.at(-2)).toEqual(["STARTER", "annual"]);
    // The other plan keeps its normal choice button.
    expect(screen.getByRole("button", { name: m.choosePlan })).toBeTruthy();
  });
});
