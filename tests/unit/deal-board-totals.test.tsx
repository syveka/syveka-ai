// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * Board column headers must equal the sum of the column's cards: the Won
 * column shows its won value (it previously showed EUR 0 next to a visible
 * EUR 1,000 card) and open columns weight each card with its own override.
 *
 * Real: DealBoard, the shared forecast contract, EN messages. Mocked: routing
 * and server actions. Synthetic data only.
 */
vi.mock("@/i18n/routing", () => ({
  RTL_LOCALES: new Set(["ar"]),
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/actions/deals", () => ({ moveDealAction: vi.fn() }));

import { DealBoard, type BoardDeal, type BoardStage } from "@/components/crm/deal-board";

const MESSAGES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

afterEach(cleanup);

function card(
  id: string,
  valueCents: number,
  probabilityOverride: number | null,
  isClosed = false,
): BoardDeal {
  return {
    id,
    title: `Deal ${id}`,
    valueCents,
    currency: "EUR",
    probabilityOverride,
    expectedCloseAt: null,
    isClosed,
    contactName: null,
    companyName: null,
    ownerName: null,
  };
}

const STAGES: BoardStage[] = [
  {
    id: "contacted",
    name: "Contacted",
    probability: 25,
    isWon: false,
    isLost: false,
    deals: [card("pilot", 100_000, 50), card("plain", 40_000, null), card("zero", 30_000, 0)],
  },
  {
    id: "won",
    name: "Won",
    probability: 100,
    isWon: true,
    isLost: false,
    deals: [card("won", 100_000, 50, true)],
  },
  {
    id: "lost",
    name: "Lost",
    probability: 0,
    isWon: false,
    isLost: true,
    deals: [card("lost", 70_000, 10, true)],
  },
];

function header(stageName: string): string {
  const title = screen.getByText(stageName, { selector: "span" });
  return title.closest("div.border-b")!.textContent ?? "";
}

describe("DealBoard column header totals", () => {
  it("Won and Lost headers sum their closed cards and show no weighted value", () => {
    render(
      <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="Europe/Helsinki">
        <DealBoard stages={STAGES} canWrite={false} />
      </NextIntlClientProvider>,
    );

    expect(header("Won")).toContain("€1,000.00");
    expect(header("Won")).not.toContain("weighted");
    expect(header("Lost")).toContain("€700.00");
  });

  it("open header weights each card with its own override (50%, stage 25%, explicit 0%)", () => {
    render(
      <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="Europe/Helsinki">
        <DealBoard stages={STAGES} canWrite={false} />
      </NextIntlClientProvider>,
    );

    // total 1,700; weighted 500 + 100 + 0 = 600
    expect(header("Contacted")).toContain("€1,700.00");
    expect(header("Contacted")).toContain("weighted €600.00");
    expect(screen.getByText(/€1,000\.00 · 50%/)).toBeTruthy();
    expect(screen.getByText(/€400\.00 · 25%/)).toBeTruthy();
    expect(screen.getByText(/€300\.00 · 0%/)).toBeTruthy();
    // Won card shows 100% regardless of the stored override.
    expect(screen.getAllByText(/€1,000\.00 · 100%/)).toHaveLength(1);
  });
});
