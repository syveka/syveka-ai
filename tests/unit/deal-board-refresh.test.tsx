// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * Staging, 2026-11-01: after "New deal" → Create, the deals page header showed
 * the new open pipeline (EUR 1,000 · forecast EUR 500) but the board still had
 * an empty Contacted column until a manual reload. DealBoard copied its
 * `stages` prop into state once, so the revalidated server data never reached
 * the board. It now adopts new server stages, while a re-render without new
 * server data keeps an optimistic move.
 *
 * Real: DealBoard and EN messages. Mocked: routing and the move action.
 */
const moves = vi.hoisted(() => ({
  moveDealAction: vi.fn(
    (..._a: unknown[]) =>
      new Promise<{ ok: boolean }>(() => {
        void _a; // never settles: the move stays pending (optimistic)
      }),
  ),
}));
vi.mock("@/i18n/routing", () => ({
  RTL_LOCALES: new Set(["ar"]),
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/actions/deals", () => moves);

import { DealBoard, type BoardDeal, type BoardStage } from "@/components/crm/deal-board";

const MESSAGES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

afterEach(cleanup);

const deal = (id: string, valueCents: number, probabilityOverride: number | null): BoardDeal => ({
  id,
  title: `Deal ${id}`,
  valueCents,
  currency: "EUR",
  probabilityOverride,
  expectedCloseAt: null,
  isClosed: false,
  contactName: null,
  companyName: null,
  ownerName: null,
});

const stages = (contacted: BoardDeal[], proposal: BoardDeal[] = []): BoardStage[] => [
  {
    id: "contacted",
    name: "Contacted",
    probability: 25,
    isWon: false,
    isLost: false,
    deals: contacted,
  },
  {
    id: "proposal",
    name: "Proposal",
    probability: 50,
    isWon: false,
    isLost: false,
    deals: proposal,
  },
];

const ui = (s: BoardStage[], canWrite = false) => (
  <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="Europe/Helsinki">
    <DealBoard stages={s} canWrite={canWrite} />
  </NextIntlClientProvider>
);

function header(stageName: string): string {
  const title = screen.getByText(stageName, { selector: "span" });
  return title.closest("div.border-b")!.textContent ?? "";
}

describe("DealBoard follows revalidated server data", () => {
  it("shows a newly created deal without a manual reload", () => {
    const view = render(ui(stages([])));
    expect(screen.queryByText("Deal acceptance")).toBeNull();
    expect(header("Contacted")).toContain("€0.00");

    // The create action revalidates /crm/deals: the page re-renders with new stages.
    view.rerender(ui(stages([deal("acceptance", 100_000, 50)])));

    expect(screen.getByText("Deal acceptance")).toBeTruthy();
    expect(header("Contacted")).toContain("€1,000.00");
    expect(header("Contacted")).toContain("weighted €500.00");
  });

  it("drops a deal the server no longer lists (deleted elsewhere)", () => {
    const view = render(ui(stages([deal("a", 10_000, null), deal("b", 20_000, null)])));
    view.rerender(ui(stages([deal("a", 10_000, null)])));
    expect(screen.getByText("Deal a")).toBeTruthy();
    expect(screen.queryByText("Deal b")).toBeNull();
  });

  it("a re-render without new server data keeps a pending optimistic move", () => {
    const initial = stages([deal("drag", 50_000, null)]);
    const view = render(ui(initial, true));
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(screen.getByText("Deal drag").closest("[draggable]")!, { dataTransfer });
    const proposalColumn = screen
      .getByText("Proposal", { selector: "span" })
      .closest("div.border-b")!.parentElement!;
    fireEvent.dragOver(proposalColumn, { dataTransfer });
    fireEvent.drop(proposalColumn, { dataTransfer });
    expect(moves.moveDealAction).toHaveBeenCalledTimes(1);
    expect(header("Proposal")).toContain("€500.00");

    // Same server data (no revalidation yet): the optimistic position stays.
    view.rerender(ui(initial, true));
    expect(header("Proposal")).toContain("€500.00");
    expect(header("Contacted")).toContain("€0.00");
  });
});
