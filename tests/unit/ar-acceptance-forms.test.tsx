// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * Android Arabic acceptance: weekday names follow the interface language, the
 * task form labels its due date and says it is optional, and the deal and
 * contact selects stack on phones so a long selected name gets the full width.
 */
vi.mock("@/actions/availability", () => ({
  saveScheduleAction: vi.fn(async () => ({})),
  deleteScheduleAction: vi.fn(async () => ({})),
}));
vi.mock("@/actions/deals", () => ({
  addDealTaskAction: vi.fn(async () => ({})),
  toggleDealTaskAction: vi.fn(async () => ({})),
}));

import { AvailabilityEditor } from "@/components/calendar/availability-editor";
import { DealTasks } from "@/components/crm/deal-tasks";

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") };

function renderIn(locale: "en" | "fi" | "ar", node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Helsinki">
      <div dir={locale === "ar" ? "rtl" : "ltr"}>{node}</div>
    </NextIntlClientProvider>,
  );
}

const schedule = {
  id: "sch-1",
  name: "Office hours",
  timezone: "Europe/Helsinki",
  isDefault: true,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
  overrides: [],
};

afterEach(cleanup);

describe("availability weekdays", () => {
  it.each([
    ["ar", ["الاثنين", "الأحد"]],
    ["fi", ["maanantai", "sunnuntai"]],
    ["en", ["Monday", "Sunday"]],
  ] as const)("names the days in the interface language (%s), Monday first", (locale, days) => {
    renderIn(locale, <AvailabilityEditor schedules={[schedule]} />);
    const text = document.body.textContent ?? "";
    for (const day of days) expect(text).toContain(day);
    expect(text.indexOf(days[0])).toBeLessThan(text.indexOf(days[1]));
    if (locale !== "en") expect(text).not.toContain("Monday");
  });
});

describe("deal task form", () => {
  it.each(["en", "fi", "ar"] as const)(
    "labels the task and its optional due date visibly (%s)",
    (locale) => {
      renderIn(locale, <DealTasks dealId="d1" tasks={[]} canWrite timeZone="Europe/Helsinki" />);
      const crm = MESSAGES[locale].crm;
      const title = screen.getByLabelText(crm.taskTitleLabel) as HTMLInputElement;
      expect(title.name).toBe("title");
      expect(title.placeholder).toBe(crm.taskPlaceholder);
      const due = screen.getByLabelText(crm.taskDueLabel) as HTMLInputElement;
      expect(due.type).toBe("datetime-local");
      expect(due.required).toBe(false);
      expect(screen.getByText(crm.taskDueLabel).tagName).toBe("LABEL");
    },
  );
});
