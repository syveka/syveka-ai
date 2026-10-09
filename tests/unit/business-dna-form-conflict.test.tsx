// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { normalizeOpeningHours } from "../../src/lib/business-dna/opening-hours";

/**
 * The Business DNA settings form sends the version it was loaded with, and
 * when the server refuses a save because the profile changed since (in chat
 * or another tab), it says so, keeps everything the user typed, and offers
 * to open or load the latest version. Mocked: the server action.
 */
const action = vi.hoisted(() => ({
  update: vi.fn(async (_prev: unknown, _form: FormData) => ({ error: "conflict" }) as object),
}));
vi.mock("@/actions/business-dna", () => ({ updateBusinessDnaAction: action.update }));

import { BusinessDnaForm } from "../../src/app/[locale]/(app)/settings/business-dna/business-dna-form";

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const en = load("en");

const LOADED = "2026-10-09T10:00:00.000Z";

const initial = {
  displayName: "Autokorjaamo Virtanen",
  industry: "Car repair",
  description: "",
  productsServices: "",
  supportedLocales: ["FI"],
  timezone: "Europe/Helsinki",
  brandTone: "",
  communicationStyle: "",
  responseInstructions: "",
  openingHours: normalizeOpeningHours({}),
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
};

function show(messages = en, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <BusinessDnaForm
        initial={initial}
        isNew={false}
        readOnly={false}
        updatedAt={LOADED}
        services={[]}
        canManageServices={false}
      />
    </NextIntlClientProvider>,
  );
}

async function typeAndSave() {
  fireEvent.change(screen.getByLabelText(en.businessDna.fields.industry), {
    target: { value: "Car and van repair" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.common.save }));
  });
}

beforeEach(() => action.update.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Business DNA form: a save conflicting with a newer change", () => {
  it("sends the version the form was loaded with", async () => {
    show();
    await typeAndSave();

    const form = action.update.mock.calls[0]![1];
    expect(form.get("expectedUpdatedAt")).toBe(LOADED);
    expect(form.get("industry")).toBe("Car and van repair");
  });

  it("says nothing was saved, keeps what the user typed, and offers the latest version", async () => {
    show();
    await typeAndSave();

    expect(screen.getByRole("alert").textContent).toContain(en.businessDna.conflict.message);
    expect((screen.getByLabelText(en.businessDna.fields.industry) as HTMLInputElement).value).toBe(
      "Car and van repair",
    );
    expect(screen.getByRole("button", { name: en.businessDna.conflict.review })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.businessDna.conflict.reload })).toBeTruthy();
    expect(screen.queryByText(en.businessDna.savedMessage)).toBeNull();
  });

  it("opens the latest version in a new tab without leaving the form", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    show();
    await typeAndSave();

    fireEvent.click(screen.getByRole("button", { name: en.businessDna.conflict.review }));

    expect(open).toHaveBeenCalledWith(window.location.href, "_blank", "noopener");
    expect((screen.getByLabelText(en.businessDna.fields.industry) as HTMLInputElement).value).toBe(
      "Car and van repair",
    );
  });

  it("uses the version returned by its own last save for the next save", async () => {
    action.update.mockResolvedValueOnce({
      message: "saved",
      updatedAt: "2026-10-09T10:05:00.000Z",
    });
    show();
    await typeAndSave();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.common.save }));
    });

    expect(action.update.mock.calls[1]![1].get("expectedUpdatedAt")).toBe(
      "2026-10-09T10:05:00.000Z",
    );
  });

  it.each(["fi", "ar"])("is localized (%s)", async (locale) => {
    const messages = load(locale);
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <BusinessDnaForm
          initial={initial}
          isNew={false}
          readOnly={false}
          updatedAt={LOADED}
          services={[]}
          canManageServices={false}
        />
      </NextIntlClientProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
    });

    expect(screen.getByRole("alert").textContent).toContain(messages.businessDna.conflict.message);
    expect(screen.getByRole("button", { name: messages.businessDna.conflict.reload })).toBeTruthy();
  });
});
