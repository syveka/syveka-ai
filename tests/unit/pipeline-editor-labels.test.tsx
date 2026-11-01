// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * The stage editor shows untouched seeded default stages in the interface
 * language (it used to show the Finnish stored names in English and Arabic),
 * while saving without editing the name still submits the stored seeded name,
 * so the stage stays an untouched default for every language. A name the
 * user types is submitted exactly as typed; custom names are shown as stored.
 */
const writes = vi.hoisted(() => ({
  createStageAction: vi.fn(async () => ({})),
  updateStageAction: vi.fn(async () => ({})),
  deleteStageAction: vi.fn(async () => ({})),
}));
vi.mock("@/actions/deals", () => writes);

import { PipelineManager, type ManagedStage } from "@/components/crm/pipeline-manager";

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));

const stages = (displayNames: [string, string]): ManagedStage[] => [
  {
    id: "s0",
    name: "Uusi liidi",
    displayName: displayNames[0],
    probability: 10,
    isWon: false,
    isLost: false,
    dealCount: 0,
  },
  {
    id: "s6",
    name: "Demo booked",
    displayName: displayNames[1],
    probability: 60,
    isWon: false,
    isLost: false,
    dealCount: 0,
  },
];

function open(locale: "en" | "fi" | "ar", displayNames: [string, string]) {
  render(
    <NextIntlClientProvider locale={locale} messages={load(locale)} timeZone="Europe/Helsinki">
      <PipelineManager stages={stages(displayNames)} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: load(locale).crm.editStages }));
}

const visibleNames = () =>
  screen
    .getAllByRole("textbox", { name: /stage name|vaiheen nimi|اسم المرحلة/i })
    .map((el) => (el as HTMLInputElement).value);
const submittedNames = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="name"]')].map(
    (el) => el.value,
  );

afterEach(cleanup);

describe("pipeline stage editor labels", () => {
  it.each([
    ["en", "New lead"],
    ["ar", "عميل محتمل جديد"],
    ["fi", "Uusi liidi"],
  ] as const)("shows the default stage in %s and submits the stored name", (locale, label) => {
    open(locale, [label, "Demo booked"]);
    // The new-stage field is the third textbox; the two rows come first.
    expect(visibleNames().slice(0, 2)).toEqual([label, "Demo booked"]);
    expect(submittedNames()).toEqual(["Uusi liidi", "Demo booked"]);
  });

  it("submits exactly what the user typed once the name is edited", () => {
    open("en", ["New lead", "Demo booked"]);
    const [defaultRow] = screen.getAllByRole("textbox", { name: "Stage name" });
    fireEvent.change(defaultRow!, { target: { value: "Inbound lead" } });
    expect(submittedNames()).toEqual(["Inbound lead", "Demo booked"]);
    expect(writes.updateStageAction).not.toHaveBeenCalled();
  });
});
