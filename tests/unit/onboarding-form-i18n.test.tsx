// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/actions/organization", () => ({ createOrganizationAction: vi.fn() }));

import { OnboardingForm } from "@/app/[locale]/(onboarding)/onboarding/onboarding-form";

function messagesFor(locale: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"),
  );
}

function renderIn(locale: string) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messagesFor(locale)}>
      <OnboardingForm />
    </NextIntlClientProvider>,
  );
}

/**
 * The onboarding form hardcoded English/Finnish via `locale === "fi" ? ... : ...`,
 * so Arabic users saw English on their first screen. It now reads the
 * `onboarding` catalog namespace.
 */
describe("OnboardingForm localization", () => {
  afterEach(cleanup);

  it.each([
    ["en", "Create your organization", "Company name"],
    ["fi", "Luo organisaatiosi", "Yrityksen nimi"],
    ["ar", "أنشئ مؤسستك", "اسم الشركة"],
  ])("renders the %s copy", (locale, title, companyName) => {
    renderIn(locale);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByLabelText(companyName)).toBeTruthy();
  });

  it("keeps the EN/FI titles the staging auth-journey E2E matches on", () => {
    // tests/e2e/auth-journeys.spec.ts: /Create your organization|Luo organisaatiosi/
    for (const locale of ["en", "fi"]) {
      expect(messagesFor(locale).onboarding.title).toMatch(
        /^(Create your organization|Luo organisaatiosi)$/,
      );
    }
  });

  it("submits the active locale as the organization's default locale", () => {
    const { container } = renderIn("ar");
    const hidden = container.querySelector('input[name="defaultLocale"]') as HTMLInputElement;
    expect(hidden.value).toBe("AR");
  });
});
