// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import LocaleError from "../../src/app/[locale]/error";

function messagesFor(locale: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"),
  );
}

/**
 * Most routes (onboarding, auth, public booking, most app pages) had no
 * error.tsx, so an unexpected server error fell through to Next.js's bare,
 * untranslated "Application error" screen. [locale]/error.tsx is the
 * translated, recoverable fallback for all of them.
 */
describe("[locale] error boundary", () => {
  afterEach(cleanup);

  it.each([
    ["en", "Try again"],
    ["fi", "Yritä uudelleen"],
    ["ar", "حاول مرة أخرى"],
  ])("renders a translated, recoverable alert in %s and calls reset", (locale, retry) => {
    const reset = vi.fn();
    const messages = messagesFor(locale);

    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <LocaleError error={new Error("boom")} reset={reset} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(messages.common.error)).toBeTruthy();
    expect(screen.getByText(messages.common.errorDescription)).toBeTruthy();
    fireEvent.click(screen.getByText(retry));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("never renders the underlying error message or digest", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED internal-db-host:5432"), {
      digest: "9876543210",
    });

    render(
      <NextIntlClientProvider locale="en" messages={messagesFor("en")}>
        <LocaleError error={error} reset={vi.fn()} />
      </NextIntlClientProvider>,
    );

    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
    expect(screen.queryByText(/9876543210/)).toBeNull();
  });
});
