// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Role } from "@/generated/prisma/client/client";
import { can } from "@/server/auth/permissions";
import { normalizeOpeningHours } from "../../src/lib/business-dna/opening-hours";

/**
 * A role without business-dna:write (Member, Viewer) sees the Business DNA
 * settings read-only: no field can be edited, and no control that saves,
 * regenerates or changes services is rendered. The props are derived from the
 * role exactly as settings/business-dna/page.tsx does. The server enforces the
 * same rule on its own (business-dna-rbac.test.ts, ai-business-dna-tool.test.ts);
 * this covers what the page offers. Mocked: the server actions (never called).
 */
const actions = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  service: vi.fn(async () => ({})),
}));
vi.mock("@/actions/business-dna", () => ({ updateBusinessDnaAction: actions.update }));
vi.mock("@/actions/business-dna-services", () => ({
  createBusinessDnaServiceAction: actions.service,
  updateBusinessDnaServiceAction: actions.service,
  deactivateBusinessDnaServiceAction: actions.service,
  reactivateBusinessDnaServiceAction: actions.service,
}));

import { BusinessDnaForm } from "../../src/app/[locale]/(app)/settings/business-dna/business-dna-form";

const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));

const initial = {
  displayName: "Autokorjaamo Virtanen",
  industry: "Car repair",
  description: "Car repair in Helsinki.",
  productsServices: "Servicing, tyres",
  supportedLocales: ["FI", "EN"],
  timezone: "Europe/Helsinki",
  brandTone: "Friendly",
  communicationStyle: "Warm",
  responseInstructions: "Be brief",
  openingHours: normalizeOpeningHours({
    monday: { closed: false, open: "08:00", close: "17:00" },
  }),
  cancellationPolicy: "24 h notice",
  bookingPolicy: "",
  refundPolicy: "",
  paymentPolicy: "",
  otherPolicies: "",
  currency: "EUR",
  quoteInstructions: "",
  pricingNotes: "",
  targetCustomer: "",
  keyFacts: ["Since 1998"],
};

const services = [
  {
    id: "svc-1",
    name: "Oil change",
    description: null,
    priceCents: 8900,
    priceNote: null,
    durationMinutes: 60,
    isActive: true,
  },
  {
    id: "svc-2",
    name: "Tyre change",
    description: null,
    priceCents: null,
    priceNote: null,
    durationMinutes: null,
    isActive: false,
  },
];

/** The form as settings/business-dna/page.tsx renders it for this role and an existing profile. */
function showAs(role: Role) {
  const canWrite = can(role, "business-dna:write");
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BusinessDnaForm
        initial={initial}
        readOnly={!canWrite}
        isNew={false}
        updatedAt="2026-10-09T10:00:00.000Z"
        services={services}
        canManageServices={canWrite}
      />
    </NextIntlClientProvider>,
  );
}

/** Every control a user could type into or toggle (hidden inputs aren't user-editable). */
const editableControls = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
    ),
  );

afterEach(cleanup);

describe("Business DNA settings for a role that can't change it", () => {
  it.each<Role>(["MEMBER", "VIEWER"])(
    "%s: every field is disabled, and no save, regenerate or service control is offered",
    (role) => {
      const { container } = showAs(role);

      // The saved values are shown...
      expect(screen.getByDisplayValue("Autokorjaamo Virtanen")).toBeTruthy();
      expect(screen.getByText("Oil change")).toBeTruthy();

      // ...but no field can be edited.
      const controls = editableControls(container);
      expect(controls.length).toBeGreaterThan(20);
      for (const control of controls) {
        expect(control.matches(":disabled"), `${control.outerHTML.slice(0, 80)}`).toBe(true);
      }

      // No button at all: no Save, no "regenerate from website", no service
      // add/edit/deactivate/reactivate.
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(container.querySelector('[type="submit"]')).toBeNull();
      expect(container.querySelector("#regenerate-url")).toBeNull();
      for (const label of [
        en.common.save,
        en.businessDna.services.add,
        en.businessDna.services.edit,
        en.businessDna.services.deactivate,
        en.businessDna.services.reactivate,
      ]) {
        expect(screen.queryByText(label)).toBeNull();
      }
      expect(actions.update).not.toHaveBeenCalled();
      expect(actions.service).not.toHaveBeenCalled();
    },
  );

  // Control: the same checks would fail for a role that may change it, so
  // the assertions above can't pass vacuously.
  it("MANAGER: the fields are editable and the save and service controls are there", () => {
    const { container } = showAs("MANAGER");

    expect(editableControls(container).some((c) => !c.matches(":disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: en.common.save })).toBeTruthy();
    expect(container.querySelector("#regenerate-url")).not.toBeNull();
    expect(screen.getByRole("button", { name: en.businessDna.services.add })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: en.businessDna.services.edit })).toHaveLength(2);
  });
});
