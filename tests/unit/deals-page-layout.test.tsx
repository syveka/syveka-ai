// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, createTranslator } from "next-intl";

/**
 * Deals page layout contract. On a 320 px phone the Finnish action labels
 * overflowed the header row and made the whole page scroll sideways (seen in
 * real Chromium: document 383 px wide at a 320 px viewport). jsdom has no
 * layout, so geometry is verified in a real browser; these tests pin the
 * structure that prevents the defect and the RTL text direction inside the
 * left-to-right board.
 *
 * Mocked: permission guard, deal/company services (data), server actions.
 * Real: page, DealBoard, PipelineManager, DealDialog, messages.
 */
const state = vi.hoisted(() => ({ locale: "fi" as "fi" | "en" | "ar" }));
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES: Record<string, Record<string, unknown>> = {
  fi: load("fi"),
  en: load("en"),
  ar: load("ar"),
};

vi.mock("next-intl/server", async () => {
  const { createTranslator: create } = await import("next-intl");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const msgs = (l: string) =>
    JSON.parse(
      nodeFs.readFileSync(nodePath.resolve(__dirname, `../../messages/${l}.json`), "utf8"),
    );
  return {
    getLocale: vi.fn(async () => state.locale),
    getTranslations: vi.fn(async (namespace?: string) =>
      create({ locale: state.locale, messages: msgs(state.locale), namespace } as never),
    ),
  };
});
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
  })),
}));
vi.mock("@/i18n/routing", () => ({
  RTL_LOCALES: new Set(["ar"]),
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
}));
vi.mock("@/actions/deals", () => ({
  moveDealAction: vi.fn(),
  createDealAction: vi.fn(),
  updateDealAction: vi.fn(),
  createStageAction: vi.fn(),
  updateStageAction: vi.fn(),
  deleteStageAction: vi.fn(),
}));
// Stored stage names are organization data (seeded in Finnish), rendered as-is.
const STAGES = ["Uusi liidi", "Yhteydenotto", "Tarjous", "Neuvottelu", "Voitettu", "Hävitty"];
vi.mock("@/server/services/deals", () => ({
  getBoard: vi.fn(async () => ({
    id: "p1",
    stages: STAGES.map((name, i) => ({
      id: `s${i}`,
      name,
      probability: [10, 25, 50, 75, 100, 0][i],
      isWon: i === 4,
      isLost: i === 5,
      deals:
        i === 0
          ? [
              {
                id: "d1",
                title: "CRM-käyttöönotto",
                valueCents: 480_000,
                currency: "EUR",
                probability: null,
                expectedCloseAt: new Date("2026-10-15T09:00:00Z"),
                closedAt: null,
                ownerId: null,
                contact: null,
                company: null,
              },
            ]
          : [],
    })),
  })),
  listContactOptions: vi.fn(async () => []),
  listOwnerOptions: vi.fn(async () => []),
  effectiveProbability: (d: { probability: number | null }, s: { probability: number }) =>
    d.probability ?? s.probability,
  expectedRevenueCents: (v: number, p: number) => Math.round((v * p) / 100),
}));
vi.mock("@/server/services/companies", () => ({ listCompanyOptions: vi.fn(async () => []) }));

import DealsPage from "@/app/[locale]/(app)/crm/deals/page";

afterEach(cleanup);

async function renderPage(locale: "fi" | "en" | "ar") {
  state.locale = locale;
  const el = await DealsPage();
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Helsinki">
      <div dir={locale === "ar" ? "rtl" : "ltr"}>{el}</div>
    </NextIntlClientProvider>,
  );
}

describe.each(["fi", "en", "ar"] as const)("Deals page layout (%s)", (locale) => {
  const t = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: "crm",
  } as never) as unknown as (k: string) => string;

  it("lets the title and the action buttons wrap instead of widening the page", async () => {
    await renderPage(locale);
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe(t("deals"));
    expect(title.className).toMatch(/\bbreak-words\b/);
    expect(title.parentElement!.className).toMatch(/\bmin-w-0\b/);

    const newDeal = screen.getByRole("button", { name: new RegExp(t("newDeal")) });
    const editStages = screen.getByRole("button", { name: new RegExp(t("editStages")) });
    const actions = newDeal.closest("div.flex-wrap")!;
    expect(actions).toBeTruthy();
    expect(actions.contains(editStages)).toBe(true);
    expect(actions.className).toMatch(/\bmin-w-0\b/);
  });

  it("keeps horizontal scrolling inside the board, in left-to-right stage order", async () => {
    const { container } = await renderPage(locale);
    const board = container.querySelector<HTMLElement>(".overflow-x-auto")!;
    expect(board.getAttribute("dir")).toBe("ltr");
    expect(board.className).toMatch(/\boverscroll-x-contain\b/);
    const columns = [...board.children] as HTMLElement[];
    expect(columns.map((c) => c.querySelector(".font-medium")!.textContent)).toEqual(STAGES);
    // Column text follows the page direction (Arabic dates/totals read correctly).
    for (const column of columns) {
      expect(column.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
    }
  });

  it("renders stored stage names unchanged (organization data, not UI strings)", async () => {
    const { container } = await renderPage(locale);
    const board = container.querySelector<HTMLElement>(".overflow-x-auto")!;
    for (const name of STAGES) expect(within(board).getByText(name)).toBeTruthy();
  });
});
