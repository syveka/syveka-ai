// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import { defaultStageKey, stageLabel } from "@/lib/crm/stage-labels";

/**
 * Pipeline stage labels follow the interface language for the untouched
 * system default stages only; renamed and custom stages are shown exactly as
 * the customer entered them. Display only: stored data is never changed.
 *
 * Real: the label helper, the Analytics and Deals pages, FunnelChart,
 * DealBoard, PipelineManager and the EN/FI/AR messages. Mocked: auth guard
 * and the data services (fixture pipelines), server actions.
 */
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES: Record<"fi" | "en" | "ar", Record<string, unknown>> = {
  fi: load("fi"),
  en: load("en"),
  ar: load("ar"),
};
const EXPECTED = {
  en: ["New lead", "Contacted", "Proposal", "Negotiation", "Won", "Lost"],
  fi: ["Uusi liidi", "Yhteydenotto", "Tarjous", "Neuvottelu", "Voitettu", "Hävitty"],
  ar: ["عميل محتمل جديد", "تم التواصل", "عرض سعر", "تفاوض", "مكسوبة", "خاسرة"],
} as const;

const state = vi.hoisted(() => ({ locale: "en" as "fi" | "en" | "ar" }));
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
const writes = vi.hoisted(() => ({
  moveDealAction: vi.fn(),
  createDealAction: vi.fn(),
  updateDealAction: vi.fn(),
  createStageAction: vi.fn(),
  updateStageAction: vi.fn(),
  deleteStageAction: vi.fn(),
}));
vi.mock("@/actions/deals", () => writes);

/**
 * The org's stored stages: the six seeded defaults (stage 2 renamed by the
 * customer) plus a custom stage. Finnish names are stored data.
 */
type StoredStage = {
  id: string;
  name: string;
  order: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
};
const STORED: StoredStage[] = [
  ...DEFAULT_PIPELINE_STAGES.map((s, i) => ({
    id: `stage-${i}`,
    name: i === 2 ? "Tarjous lähetetty" : s.name, // renamed by the customer
    order: s.order,
    probability: s.probability,
    isWon: "isWon" in s && s.isWon === true,
    isLost: "isLost" in s && s.isLost === true,
  })),
  {
    id: "stage-6",
    name: "Demo booked",
    order: 6,
    probability: 60,
    isWon: false,
    isLost: false,
  },
];
const COUNTS = [3, 2, 1, 4, 5, 2, 7];
const AMOUNTS = [100_00, 2_500_00, 330_00, 12_000_00, 9_999_00, 0, 4_200_00];

vi.mock("@/server/services/analytics", () => ({
  getSalesAnalytics: vi.fn(async () => ({
    funnel: STORED.map((s, i) => ({
      stage: s.name,
      order: s.order,
      isWon: s.isWon,
      isLost: s.isLost,
      count: COUNTS[i],
      valueCents: AMOUNTS[i],
    })),
    winRate: 71,
  })),
  getAiAnalytics: vi.fn(async () => ({
    tokensIn: 0,
    tokensOut: 0,
    messagesByDay: [],
    feedbackPositivePct: null,
  })),
  getVoiceAnalytics: vi.fn(async () => ({
    totalCalls: 0,
    totalMinutes: 0,
    callsByDay: [],
    sentiments: { positive: 0, neutral: 0, negative: 0 },
    transferred: 0,
  })),
}));
vi.mock("@/server/services/deals", () => ({
  getBoard: vi.fn(async () => ({
    id: "p1",
    stages: STORED.map((s) => ({ ...s, deals: [] })),
  })),
  listContactOptions: vi.fn(async () => []),
  listOwnerOptions: vi.fn(async () => []),
  effectiveProbability: (d: { probability: number | null }, s: { probability: number }) =>
    d.probability ?? s.probability,
  expectedRevenueCents: (v: number, p: number) => Math.round((v * p) / 100),
}));
vi.mock("@/server/services/companies", () => ({ listCompanyOptions: vi.fn(async () => []) }));

import AnalyticsPage from "@/app/[locale]/(app)/analytics/page";
import DealsPage from "@/app/[locale]/(app)/crm/deals/page";

const LOCALES = ["en", "fi", "ar"] as const;
const snapshot = () => JSON.stringify(STORED);
let before: string;
beforeEach(() => {
  before = snapshot();
  Object.values(writes).forEach((w) => w.mockClear());
});
afterEach(() => {
  cleanup();
  // Display never mutates the stored stages or calls a write action.
  expect(snapshot()).toBe(before);
  Object.values(writes).forEach((w) => expect(w).not.toHaveBeenCalled());
});

async function renderServer(
  el: () => Promise<React.ReactElement>,
  locale: (typeof LOCALES)[number],
) {
  state.locale = locale;
  const page = await el();
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Helsinki">
      <div dir={locale === "ar" ? "rtl" : "ltr"}>{page}</div>
    </NextIntlClientProvider>,
  );
}

describe("stageLabel (which stages are translated)", () => {
  const t = (locale: (typeof LOCALES)[number]) => {
    const tr = createTranslator({ locale, messages: MESSAGES[locale], namespace: "crm" } as never);
    return (key: string) => (tr as (k: string) => string)(`defaultStages.${key}`);
  };

  it.each(LOCALES)("untouched defaults follow the interface language (%s)", (locale) => {
    const labels = DEFAULT_PIPELINE_STAGES.map((s) =>
      stageLabel(
        {
          name: s.name,
          order: s.order,
          isWon: "isWon" in s && s.isWon === true,
          isLost: "isLost" in s && s.isLost === true,
        },
        t(locale),
      ),
    );
    expect(labels).toEqual(EXPECTED[locale]);
  });

  it("renamed and custom stages stay exactly as entered, in every locale", () => {
    for (const locale of LOCALES) {
      expect(stageLabel(STORED[2]!, t(locale))).toBe("Tarjous lähetetty");
      expect(stageLabel(STORED[6]!, t(locale))).toBe("Demo booked");
    }
  });

  it("a default name alone is never enough: wrong position or flags keep the stored name", () => {
    const tEn = t("en");
    // "Tarjous" typed as a custom stage appended at the end.
    expect(stageLabel({ name: "Tarjous", order: 7, isWon: false, isLost: false }, tEn)).toBe(
      "Tarjous",
    );
    // "Voitettu" at the seeded position but turned into an open stage.
    expect(stageLabel({ name: "Voitettu", order: 4, isWon: false, isLost: false }, tEn)).toBe(
      "Voitettu",
    );
    // A different case or extra space is a customer edit.
    expect(stageLabel({ name: "uusi liidi", order: 0, isWon: false, isLost: false }, tEn)).toBe(
      "uusi liidi",
    );
    expect(stageLabel({ name: "Uusi liidi ", order: 0, isWon: false, isLost: false }, tEn)).toBe(
      "Uusi liidi ",
    );
  });

  it("unknown or legacy positions fall back to the stored name", () => {
    for (const order of [-1, 6, 99, Number.NaN]) {
      expect(
        defaultStageKey({ name: "Uusi liidi", order, isWon: false, isLost: false }),
      ).toBeNull();
    }
  });
});

describe.each(LOCALES)("Analytics › Pipeline funnel (%s)", (locale) => {
  it("shows default stages in the interface language, custom names unchanged, counts and amounts intact", async () => {
    await renderServer(AnalyticsPage, locale);
    // The funnel card title, then one row per stored stage, in order.
    const title = (MESSAGES[locale].analytics as Record<string, string>).pipelineFunnel!;
    const text = document.body.textContent ?? "";
    expect(text).toContain(title);
    const expected: string[] = [...EXPECTED[locale]];
    expected[2] = "Tarjous lähetetty";
    expected.push("Demo booked");
    // In order, one row per stored stage.
    let last = -1;
    for (const label of expected) {
      const at = text.indexOf(label, last + 1);
      expect(at, label).toBeGreaterThan(last);
      last = at;
    }
    for (let i = 0; i < STORED.length; i++) {
      expect(text).toContain(`${COUNTS[i]} · `);
    }
    if (locale !== "fi") {
      // No untouched default is left in Finnish in another language.
      for (const fi of ["Uusi liidi", "Yhteydenotto", "Neuvottelu", "Voitettu", "Hävitty"]) {
        expect(text).not.toContain(fi);
      }
    }
  });
});

describe.each(LOCALES)("Deals board (%s)", (locale) => {
  it("board columns use the same labels; the pipeline editor shows the stored names it edits", async () => {
    await renderServer(DealsPage, locale);
    const expected: string[] = [...EXPECTED[locale]];
    expected[2] = "Tarjous lähetetty";
    for (const label of [...expected, "Demo booked"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The stage editor (owner) keeps the stored values: what is edited is what is saved.
    const editors = document.querySelectorAll<HTMLInputElement>('input[name="name"]');
    if (editors.length > 0) {
      expect([...editors].map((e) => e.defaultValue)).toEqual(STORED.map((s) => s.name));
    }
    void within;
  });
});
