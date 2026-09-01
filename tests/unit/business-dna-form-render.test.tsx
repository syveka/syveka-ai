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

/**
 * Regression coverage for the staging report: a brand-new organization
 * (created via onboarding, zero Business DNA data yet) landed on
 * /settings/business-dna and hit Next.js's generic "Application error: a
 * client-side exception has occurred" screen. No test in this suite ever
 * mounted a client component from this page -- every existing Business DNA
 * test (business-dna-rbac, organization-onboarding, tenant-db, etc.) is
 * server-side logic only, so a client-render-only defect on this exact
 * prop shape had no coverage at all. These props are the exact ones
 * page.tsx computes for a brand-new org (`record === null`).
 */
describe("BusinessDnaForm renders for a brand-new organization with zero Business DNA data", () => {
  it("mounts without throwing", () => {
    render(
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
  });
});
