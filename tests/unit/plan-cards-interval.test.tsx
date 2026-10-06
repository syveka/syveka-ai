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
    expect(text()).toMatch(/29\s€/);
    expect(text()).toMatch(/79\s€/);
    expect(bindCalls).toContainEqual(["PRO", "monthly"]);

    fireEvent.click(screen.getByRole("button", { name: m.interval.annual }));
    expect(
      screen.getByRole("button", { name: m.interval.annual }).getAttribute("aria-pressed"),
    ).toBe("true");
    // round(monthly * 10 / 12): 29 -> 24, 79 -> 66 (unchanged calculation).
    expect(text()).toMatch(/24\s€/);
    expect(text()).toMatch(/66\s€/);
    expect(bindCalls).toContainEqual(["PRO", "annual"]);
    expect(bindCalls).toContainEqual(["STARTER", "annual"]);
  });
});
