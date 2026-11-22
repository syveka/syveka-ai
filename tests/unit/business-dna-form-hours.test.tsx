// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { BusinessDnaForm } from "../../src/app/[locale]/(app)/settings/business-dna/business-dna-form";
import { normalizeOpeningHours } from "../../src/lib/business-dna/opening-hours";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

/**
 * Untouched opening hours look exactly like a deliberately all-closed week,
 * so the form sends openingHours only after the user changed a day. An
 * untouched save then keeps whatever is stored.
 */
function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BusinessDnaForm
        readOnly={false}
        isNew={true}
        updatedAt={null}
        services={[]}
        canManageServices={false}
        initial={{
          displayName: "",
          industry: "",
          description: "",
          productsServices: "",
          supportedLocales: [],
          timezone: "",
          brandTone: "",
          communicationStyle: "",
          responseInstructions: "",
          openingHours: normalizeOpeningHours(null),
          cancellationPolicy: "",
          bookingPolicy: "",
          refundPolicy: "",
          paymentPolicy: "",
          otherPolicies: "",
          currency: "",
          quoteInstructions: "",
          pricingNotes: "",
          targetCustomer: "",
          keyFacts: [],
        }}
      />
    </NextIntlClientProvider>,
  );
}

const sentHours = (container: HTMLElement) =>
  new FormData(container.querySelector("form")!).get("openingHours");

describe("Business DNA form opening hours", () => {
  it("sends no opening hours while the user has not touched them", () => {
    const { container } = renderForm();
    expect(sentHours(container)).toBeNull();
  });

  it("sends the week once a day was changed, even if it ends up all closed", () => {
    const { container } = renderForm();
    const closed = container.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
    const monday = [...closed].find((box) => box.checked)!;
    fireEvent.click(monday);
    fireEvent.click(monday);
    expect(JSON.parse(String(sentHours(container)))).toEqual(normalizeOpeningHours(null));
  });
});
