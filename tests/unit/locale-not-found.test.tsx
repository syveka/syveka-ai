// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import LocaleNotFound from "../../src/app/[locale]/not-found";

function messagesFor(locale: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"),
  );
}

/**
 * notFound() under [locale] (unknown records, invalid or inactive public
 * booking links) showed Next.js's bare, English-only 404. [locale]/not-found.tsx
 * is the translated replacement.
 */
describe("[locale] not-found page", () => {
  afterEach(cleanup);

  it.each(["en", "fi", "ar"])("renders a translated page with a way back in %s", (locale) => {
    const messages = messagesFor(locale);

    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <LocaleNotFound />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      messages.common.notFoundTitle,
    );
    expect(screen.getByText(messages.common.notFoundDescription)).toBeTruthy();
    const home = screen.getByRole("link", { name: messages.common.backToHome });
    expect(home.getAttribute("href")).toBe("/");
  });

  it("has distinct, non-empty translations in every locale", () => {
    const keys = ["notFoundTitle", "notFoundDescription", "backToHome"] as const;
    const [en, fi, ar] = ["en", "fi", "ar"].map((l) => messagesFor(l).common);
    for (const key of keys) {
      for (const common of [en, fi, ar]) expect(common[key]?.trim()).toBeTruthy();
      expect(fi[key]).not.toBe(en[key]);
      expect(ar[key]).not.toBe(en[key]);
    }
  });
});
