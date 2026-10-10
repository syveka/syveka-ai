// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import en from "../../messages/en.json";
import fi from "../../messages/fi.json";
import ar from "../../messages/ar.json";
import { eventSchema } from "@/lib/validators/calendar";
import type { CalEvent } from "@/components/calendar/calendar-view";

/**
 * Staging QA, 2026-10-10: a weekly series ("QA Recurring Test", Mondays from
 * Oct 12, Europe/Helsinki) was opened at its Oct 19 occurrence, moved to
 * 14:00 and saved. Every other occurrence disappeared: the Repeat select was
 * disabled for occurrences, so the browser left it out of the form and the
 * save cleared the rule; the occurrence's own times also replaced the series
 * start. A series is one row, so editing an occurrence edits the series.
 */

vi.mock("@/actions/calendar", () => ({
  saveEventAction: vi.fn(async () => ({})),
  cancelEventAction: vi.fn(async () => ({})),
  deleteEventAction: vi.fn(async () => ({})),
  schedulingAssistantAction: vi.fn(async () => ({})),
  meetingSummaryAction: vi.fn(async () => ({})),
}));
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/calendar",
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const { EventDialog } = await import("@/components/calendar/event-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Series stored once: Mon 2026-10-12 10:00–11:00 Helsinki (07:00Z, EEST).
const SERIES_START = "2026-10-12T07:00:00.000Z";
const SERIES_END = "2026-10-12T08:00:00.000Z";

function oct19Occurrence(overrides: Partial<CalEvent> = {}): CalEvent {
  return {
    id: "series-1",
    title: "QA Recurring Test",
    startsAt: "2026-10-19T07:00:00.000Z",
    endsAt: "2026-10-19T08:00:00.000Z",
    allDay: false,
    source: "MANUAL",
    status: "SCHEDULED",
    timezone: "Europe/Helsinki",
    location: null,
    description: null,
    recurrenceRule: "FREQ=WEEKLY",
    isOccurrence: true,
    seriesStartsAt: SERIES_START,
    seriesEndsAt: SERIES_END,
    contactId: null,
    companyId: null,
    dealId: null,
    ownerId: null,
    attendees: [],
    ...overrides,
  };
}

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function openDialog(event: CalEvent): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Helsinki">
        <EventDialog
          event={event}
          prefill={null}
          options={{ owners: [], contacts: [], companies: [], deals: [] }}
          canWrite
          canDelete
          timeZone="Europe/Helsinki"
          onClose={() => undefined}
        />
      </NextIntlClientProvider>,
    );
  });
  return host;
}

function field<T extends HTMLElement>(host: HTMLElement, id: string): T {
  return host.querySelector(`#${id}`) as T;
}

/** Exactly what the browser would submit, parsed as saveEventAction does. */
function submitted(host: HTMLElement) {
  const formData = new FormData(host.querySelector("form")!);
  return { formData, parsed: eventSchema.parse(Object.fromEntries(formData)) };
}

describe("editing an occurrence edits the whole recurring series", () => {
  it("the Oct 19 staging case: moving the series to 14:00 keeps the weekly rule and the series' Oct 12 start", async () => {
    const host = await openDialog(oct19Occurrence());
    // The editor shows the series, not the clicked occurrence.
    expect(field<HTMLInputElement>(host, "startsAt").value).toBe("2026-10-12T10:00");
    expect(field<HTMLInputElement>(host, "endsAt").value).toBe("2026-10-12T11:00");

    field<HTMLInputElement>(host, "startsAt").value = "2026-10-12T14:00";
    field<HTMLInputElement>(host, "endsAt").value = "2026-10-12T15:00";
    const { formData, parsed } = submitted(host);

    expect(formData.get("recurrenceRule")).toBe("FREQ=WEEKLY");
    expect(parsed.recurrenceRule).toBe("FREQ=WEEKLY");
    expect(parsed.startsAt).toBe("2026-10-12T11:00:00.000Z");
    expect(parsed.endsAt).toBe("2026-10-12T12:00:00.000Z");
  });

  it("a title-only edit of an occurrence keeps the rule and the series' own times", async () => {
    const host = await openDialog(oct19Occurrence());
    field<HTMLInputElement>(host, "title").value = "QA Recurring Test (renamed)";
    const { parsed } = submitted(host);

    expect(parsed.title).toBe("QA Recurring Test (renamed)");
    expect(parsed.recurrenceRule).toBe("FREQ=WEEKLY");
    expect(parsed.startsAt).toBe(SERIES_START);
    expect(parsed.endsAt).toBe(SERIES_END);
  });

  it("choosing 'Does not repeat' on an occurrence submits an explicit empty rule", async () => {
    const host = await openDialog(oct19Occurrence());
    const repeat = field<HTMLSelectElement>(host, "recurrenceRule");
    expect(repeat.disabled).toBe(false);
    repeat.value = "";
    const { formData, parsed } = submitted(host);

    // Present-but-empty is the intentional "None" (the action clears the rule);
    // an absent field is what must never clear it.
    expect(formData.has("recurrenceRule")).toBe(true);
    expect(formData.get("recurrenceRule")).toBe("");
    expect(parsed.recurrenceRule).toBeUndefined();
  });

  it("says before Save that changes apply to the entire series, and labels Cancel/Delete for the series", async () => {
    const host = await openDialog(oct19Occurrence());
    expect(host.querySelector('[role="note"]')?.textContent).toBe(en.calendar.seriesNotice);
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Cancel entire series");
    expect(buttons).toContain("Delete entire series");
    expect(buttons).not.toContain(en.calendar.cancelEvent);
  });

  it("the series' first occurrence (stored row) gets the same notice and labels", async () => {
    const host = await openDialog(
      oct19Occurrence({
        startsAt: SERIES_START,
        endsAt: SERIES_END,
        isOccurrence: false,
        seriesStartsAt: null,
        seriesEndsAt: null,
      }),
    );
    expect(host.querySelector('[role="note"]')).not.toBeNull();
    expect(field<HTMLInputElement>(host, "startsAt").value).toBe("2026-10-12T10:00");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toContain(
      "Delete entire series",
    );
  });

  it("a one-off event is unchanged: no series notice, plain Cancel/Delete, its own times", async () => {
    const host = await openDialog(
      oct19Occurrence({ recurrenceRule: null, isOccurrence: false, seriesStartsAt: null }),
    );
    expect(host.querySelector('[role="note"]')).toBeNull();
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain(en.calendar.cancelEvent);
    expect(buttons).toContain(en.common.delete);
    expect(field<HTMLInputElement>(host, "startsAt").value).toBe("2026-10-19T10:00");
    expect(submitted(host).formData.get("recurrenceRule")).toBe("");
  });
});

describe("series wording exists in every locale", () => {
  const keys = ["seriesNotice", "cancelSeries", "deleteSeries"] as const;

  it.each([
    ["fi", fi],
    ["ar", ar],
  ])("%s has its own translation of each key", (_locale, messages) => {
    for (const key of keys) {
      expect(messages.calendar[key]).toBeTruthy();
      expect(messages.calendar[key]).not.toBe(en.calendar[key]);
    }
  });
});
