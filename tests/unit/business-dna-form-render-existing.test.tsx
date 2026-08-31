// @vitest-environment jsdom
import React from "react";
import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { BusinessDnaForm } from "../../src/app/[locale]/(app)/settings/business-dna/business-dna-form";
import { normalizeOpeningHours } from "../../src/lib/business-dna/opening-hours";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

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
});
