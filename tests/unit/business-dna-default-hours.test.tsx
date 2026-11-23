// @vitest-environment jsdom
import React, { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

/**
 * An organization with no saved opening hours sees the booking system's own
 * default week (Mon-Fri 09:00-17:00, weekend closed, DEFAULT_WEEKLY_RULES)
 * in the Business DNA form. That is display only: the form still sends no
 * openingHours until the user changes a day, so an unrelated save keeps the
 * hours unset (see business-dna-form-hours and business-dna-hours-unset).
 */
const mocks = vi.hoisted(() => ({
  record: null as Record<string, unknown> | null,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: async () => ({ orgId: "org-1", userId: "user-1", role: "OWNER" }),
}));
vi.mock("@/server/auth/permissions", () => ({ can: () => true }));
vi.mock("@/server/services/business-dna", () => ({
  getBusinessDNA: async () => mocks.record,
}));
vi.mock("@/server/services/business-dna-services", () => ({
  listBusinessDnaServices: async () => [],
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
// The extraction panel calls a route; here it hands the form a result directly.
const extraction = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));
vi.mock("../../src/app/[locale]/(app)/settings/business-dna/regenerate-from-website", () => ({
  RegenerateFromWebsite: ({
    onExtracted,
  }: {
    onExtracted: (data: unknown, sourceUrl: string) => void;
  }) => (
    <button type="button" onClick={() => onExtracted(extraction.data, "https://example.test")}>
      apply-extraction
    </button>
  ),
}));

import BusinessDnaSettingsPage from "../../src/app/[locale]/(app)/settings/business-dna/page";
import {
  BusinessDnaForm,
  type BusinessDnaInitial,
} from "../../src/app/[locale]/(app)/settings/business-dna/business-dna-form";
import { normalizeOpeningHours, type WeekHours } from "../../src/lib/business-dna/opening-hours";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

const open = { closed: false, open: "09:00", close: "17:00" };
const closed = { closed: true, open: "09:00", close: "17:00" };
const BOOKING_DEFAULT_WEEK: WeekHours = {
  monday: open,
  tuesday: open,
  wednesday: open,
  thursday: open,
  friday: open,
  saturday: closed,
  sunday: closed,
};

function savedRecord(openingHours: unknown) {
  return {
    displayName: "Acme",
    industry: null,
    description: null,
    productsServices: null,
    supportedLocales: [],
    timezone: null,
    brandTone: null,
    communicationStyle: null,
    responseInstructions: null,
    openingHours,
    cancellationPolicy: null,
    bookingPolicy: null,
    refundPolicy: null,
    paymentPolicy: null,
    otherPolicies: null,
    currency: null,
    quoteInstructions: null,
    pricingNotes: null,
    targetCustomer: null,
    keyFacts: [],
    updatedAt: new Date("2026-11-20T10:00:00Z"),
  };
}

/** The `initial` the settings page hands the form, found in its element tree. */
async function pageInitial(): Promise<BusinessDnaInitial> {
  const tree = (await BusinessDnaSettingsPage()) as ReactElement;
  const find = (node: unknown): ReactElement | null => {
    if (!node || typeof node !== "object") return null;
    const element = node as ReactElement<{ children?: unknown }>;
    if (element.type === BusinessDnaForm) return element;
    const children = element.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const form = find(tree) as ReactElement<{ initial: BusinessDnaInitial }> | null;
  if (!form) throw new Error("the page renders no BusinessDnaForm");
  return form.props.initial;
}

function renderForm(initial: BusinessDnaInitial) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BusinessDnaForm
        readOnly={false}
        isNew={false}
        updatedAt="2026-11-20T10:00:00.000Z"
        services={[]}
        canManageServices={false}
        initial={initial}
      />
    </NextIntlClientProvider>,
  );
}

const sentHours = (container: HTMLElement) =>
  new FormData(container.querySelector("form")!).get("openingHours");

const closedBoxes = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')].slice(-7);

beforeEach(() => {
  mocks.record = null;
  extraction.data = null;
});

afterEach(() => {
  cleanup();
});

describe("Business DNA default opening hours", () => {
  it.each([
    ["no Business DNA yet", () => null],
    ["saved Business DNA with null hours", () => savedRecord(null)],
    ["saved Business DNA with non-object hours", () => savedRecord("not hours")],
  ])("%s shows Mon-Fri 09:00-17:00 and a closed weekend", async (_label, record) => {
    mocks.record = record();

    const initial = await pageInitial();

    expect(initial.openingHours).toEqual(BOOKING_DEFAULT_WEEK);
    const { container } = renderForm(initial);
    expect(closedBoxes(container).map((box) => box.checked)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    const times = [...container.querySelectorAll<HTMLInputElement>('input[type="time"]')];
    expect(times.map((input) => input.value)).toEqual(Array(5).fill(["09:00", "17:00"]).flat());
  });

  it("an unrelated save without touching the hours sends no opening hours", async () => {
    mocks.record = savedRecord(null);
    const { container } = renderForm(await pageInitial());

    fireEvent.change(container.querySelector<HTMLInputElement>('input[name="displayName"]')!, {
      target: { value: "Acme Oy" },
    });

    expect(sentHours(container)).toBeNull();
  });

  it("changing one day sends the complete displayed week", async () => {
    mocks.record = savedRecord(null);
    const { container, getByLabelText } = renderForm(await pageInitial());

    // On a week with Wednesday closed this input does not exist at all.
    fireEvent.change(getByLabelText("Wednesday closing time"), { target: { value: "16:00" } });

    expect(JSON.parse(String(sentHours(container)))).toEqual({
      ...BOOKING_DEFAULT_WEEK,
      wednesday: { closed: false, open: "09:00", close: "16:00" },
    });
  });

  it("an explicitly saved all-closed week still shows all closed", async () => {
    const allClosed = Object.fromEntries(
      Object.keys(BOOKING_DEFAULT_WEEK).map((day) => [day, { closed: true }]),
    );
    mocks.record = savedRecord(allClosed);

    const initial = await pageInitial();

    expect(initial.openingHours).toEqual(normalizeOpeningHours(allClosed));
    expect(Object.values(initial.openingHours).every((day) => day.closed)).toBe(true);
    const { container } = renderForm(initial);
    expect(closedBoxes(container).every((box) => box.checked)).toBe(true);
    expect(sentHours(container)).toBeNull();
  });

  it("explicitly saved hours, even a partial week, display exactly as before", async () => {
    const partial = { monday: { closed: false, open: "08:00", close: "16:00" } };
    mocks.record = savedRecord(partial);

    const initial = await pageInitial();

    // A missing day in a saved week stays closed, as normalizeOpeningHours has it.
    expect(initial.openingHours).toEqual(normalizeOpeningHours(partial));
    expect(initial.openingHours.tuesday.closed).toBe(true);
  });

  it("website extraction with hours still marks the hours as changed", async () => {
    mocks.record = savedRecord(null);
    extraction.data = {
      openingHours: { monday: { closed: false, open: "10:00", close: "18:00" } },
    };
    const { container, getByText } = renderForm(await pageInitial());
    expect(sentHours(container)).toBeNull();

    fireEvent.click(getByText("apply-extraction"));

    const sent = JSON.parse(String(sentHours(container))) as WeekHours;
    expect(sent.monday).toEqual({ closed: false, open: "10:00", close: "18:00" });
  });
});
