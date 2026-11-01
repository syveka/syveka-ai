import React from "react";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Analytics bar charts: the AI messages chart showed one wide blue block with
 * no visible date or value until tapped (the hover tooltip itself works), and
 * the call volume chart showed a bare "-" with no data. Now every chart has
 * visible dates/values (or first/last date for long series), a text summary
 * and a visually hidden table; empty series say what is missing.
 */
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "fi" | "ar",
  messagesByDay: [] as Array<{ date: string; count: number }>,
  callsByDay: [] as Array<{ date: string; count: number }>,
}));
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") };

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getLocale: vi.fn(async () => state.locale),
    getTranslations: vi.fn(async (namespace?: string) =>
      createTranslator({
        locale: state.locale,
        messages: MESSAGES[state.locale],
        namespace,
      } as never),
    ),
  };
});
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1", role: "OWNER" })),
}));
vi.mock("@/server/services/analytics", () => ({
  getSalesAnalytics: vi.fn(async () => ({ funnel: [], winRate: null })),
  getAiAnalytics: vi.fn(async () => ({
    tokensIn: 1200,
    tokensOut: 34,
    messagesByDay: state.messagesByDay,
    feedbackPositivePct: null,
  })),
  getVoiceAnalytics: vi.fn(async () => ({
    totalCalls: 0,
    totalMinutes: 0,
    callsByDay: state.callsByDay,
    sentiments: { positive: 0, neutral: 0, negative: 0 },
    transferred: 0,
  })),
}));

import AnalyticsPage from "@/app/[locale]/(app)/analytics/page";
import { BarChart } from "@/components/analytics/charts";

async function renderPage(locale: "en" | "fi" | "ar") {
  state.locale = locale;
  return renderToStaticMarkup(await AnalyticsPage());
}

beforeEach(() => {
  state.messagesByDay = [];
  state.callsByDay = [];
});

describe("Analytics charts", () => {
  it.each(["en", "fi", "ar"] as const)(
    "explains empty series instead of a bare dash (%s)",
    async (locale) => {
      const html = await renderPage(locale);
      expect(html).toContain(MESSAGES[locale].analytics.noAiMessages);
      expect(html).toContain(MESSAGES[locale].analytics.noCalls);
      expect(html).not.toMatch(/>\s*-\s*</);
    },
  );

  it("labels a single day of AI messages with its date and value, visibly and for screen readers", async () => {
    state.messagesByDay = [{ date: "2026-10-31", count: 12 }];
    const html = await renderPage("en");
    // Visible value and localized date (not "10-31").
    expect(html).toContain(">12</span>");
    expect(html).toContain("Oct 31");
    expect(html).not.toContain("10-31");
    expect(html).toContain("1 day with data, highest 12.");
    // Hidden table with the same data.
    expect(html).toContain('<table class="sr-only"><caption>AI messages (30 d)</caption>');
    expect(html).toContain('<th scope="row">Oct 31</th><td>12</td>');
  });

  it("localizes dates, numbers and the summary in Finnish and Arabic", async () => {
    state.messagesByDay = [
      { date: "2026-10-30", count: 1500 },
      { date: "2026-10-31", count: 3 },
    ];
    const fi = await renderPage("fi");
    expect(fi).toContain("31.10.");
    expect(fi).toMatch(/2 päivää, joilta on tietoja, suurin 1\s500\./);
    const ar = await renderPage("ar");
    expect(ar).toContain(MESSAGES.ar.analytics.chartDate);
    expect(ar).toContain("الأعلى");
  });
});

describe("BarChart", () => {
  const props = {
    title: "Calls",
    summary: "summary",
    emptyLabel: "No calls",
    dateHeader: "Date",
    valueHeader: "Count",
  };
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: `2026-10-${String(i + 1).padStart(2, "0")}`,
      label: `Oct ${i + 1}`,
      value: i,
      valueText: String(i),
    }));

  it("caps bar width so a single bar is not a full-width block", () => {
    const html = renderToStaticMarkup(<BarChart data={series(1)} {...props} />);
    expect(html).toContain("max-w-12");
  });

  it("shows first and last date for long series, and every value in the hidden table", () => {
    const html = renderToStaticMarkup(<BarChart data={series(20)} {...props} />);
    expect(html).toContain("<span>Oct 1</span><span>Oct 20</span>");
    expect(html.match(/<th scope="row">/g)).toHaveLength(20);
  });
});
