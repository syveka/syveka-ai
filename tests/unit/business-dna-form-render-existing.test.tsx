// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { BusinessDnaForm } from "../../src/app/[locale]/(app)/settings/business-dna/business-dna-form";
import { normalizeOpeningHours } from "../../src/lib/business-dna/opening-hours";
import { formatDate } from "../../src/lib/utils";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);
const fiMessages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/fi.json"), "utf8"),
);

const EXISTING_INITIAL = {
  displayName: "Fruppi Toys",
  industry: "Toys",
  description: "Kids toys",
  productsServices: "Plush toys",
  supportedLocales: ["FI", "EN"],
  timezone: "Europe/Helsinki",
  brandTone: "Friendly",
  communicationStyle: "Warm",
  responseInstructions: "Be nice",
  openingHours: normalizeOpeningHours({
    monday: { closed: false, open: "09:00", close: "17:00" },
  }),
  cancellationPolicy: "",
  bookingPolicy: "",
  refundPolicy: "",
  paymentPolicy: "",
  otherPolicies: "",
  currency: "EUR",
  quoteInstructions: "",
  pricingNotes: "",
  targetCustomer: "",
  keyFacts: ["fact1", "fact2"],
};

/** Companion to business-dna-form-render.test.tsx: proves the fix didn't regress the already-populated case. */
describe("BusinessDnaForm renders for an organization with existing Business DNA + services", () => {
  it("mounts without throwing", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BusinessDnaForm
          readOnly={false}
          isNew={false}
          updatedAt={new Date().toISOString()}
          services={[
            {
              id: "svc-1",
              name: "Strawberry Toy",
              description: "A plush toy",
              priceCents: 2900,
              priceNote: null,
              durationMinutes: null,
              isActive: true,
            },
          ]}
          canManageServices={true}
          initial={{
            displayName: "Fruppi Toys",
            industry: "Toys",
            description: "Kids toys",
            productsServices: "Plush toys",
            supportedLocales: ["FI", "EN"],
            timezone: "Europe/Helsinki",
            brandTone: "Friendly",
            communicationStyle: "Warm",
            responseInstructions: "Be nice",
            openingHours: normalizeOpeningHours({
              monday: { closed: false, open: "09:00", close: "17:00" },
            }),
            cancellationPolicy: "",
            bookingPolicy: "",
            refundPolicy: "",
            paymentPolicy: "",
            otherPolicies: "",
            currency: "EUR",
            quoteInstructions: "",
            pricingNotes: "",
            targetCustomer: "",
            keyFacts: ["fact1", "fact2"],
          }}
        />
      </NextIntlClientProvider>,
    );
  });

  /**
   * Root cause, proven live (staging run 34699834837, 2026-09-12): the
   * "Updated {date}" line called the bare `new Date(updatedAt)
   * .toLocaleDateString()` (no explicit locale), which resolves to the
   * *runtime's own default locale* -- Node.js's server-side default
   * differs from a browser's, so SSR and client hydration produced
   * different text, throwing React error #418 ("Hydration failed because
   * the initial UI does not match what was rendered on the server").
   * This had been latent since the field was added; it only started
   * failing in this exact run because PR #140 was the first time
   * `updatedAt` was ever actually populated by a real save.
   *
   * This test proves the fix (formatDate(updatedAt, locale), matching
   * every other date display in the app) no longer depends on the
   * runtime's own implicit locale: it mocks Date.prototype
   * .toLocaleDateString() to return an obviously-wrong sentinel and
   * confirms the rendered text is unaffected by it.
   */
  it("formats the 'updated' date via the page's own locale, not the runtime's implicit default (regression: React error #418 hydration mismatch)", () => {
    const updatedAt = "2026-09-12T10:00:00.000Z";
    const toLocaleDateStringSpy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("RUNTIME_DEFAULT_LOCALE_LEAKED");

    try {
      render(
        <NextIntlClientProvider locale="fi" messages={fiMessages}>
          <BusinessDnaForm
            readOnly={false}
            isNew={false}
            updatedAt={updatedAt}
            services={[]}
            canManageServices={true}
            initial={EXISTING_INITIAL}
          />
        </NextIntlClientProvider>,
      );

      const expectedDate = formatDate(updatedAt, "fi");
      expect(screen.getByText(`Päivitetty ${expectedDate}`)).toBeTruthy();
      expect(screen.queryByText(/RUNTIME_DEFAULT_LOCALE_LEAKED/)).toBeNull();
    } finally {
      toLocaleDateStringSpy.mockRestore();
    }
  });
});
