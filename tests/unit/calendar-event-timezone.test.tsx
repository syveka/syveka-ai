// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { eventSchema } from "@/lib/validators/calendar";

/**
 * Staging QA, 2026-10-07: a public booking for 09:00 Europe/Helsinki was
 * stored as 06:00Z (correct), but the calendar editor showed "06:00" beside
 * "Europe/Helsinki" -- the UTC digits printed as Helsinki wall time. The save
 * path had the mirror defect: a typed 09:00 was read in the server's zone
 * (UTC on Vercel), ignoring the event's timezone field.
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
const { CalendarView } = await import("@/components/calendar/calendar-view");

const options = { owners: [], contacts: [], companies: [], deals: [] };

/** The staging booking: 09:00 Helsinki on 2026-10-07 is 06:00Z (EEST). */
function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    title: "Intro call — Guest",
    startsAt: "2026-10-07T06:00:00.000Z",
    endsAt: "2026-10-07T06:30:00.000Z",
    allDay: false,
    source: "BOOKING",
    status: "SCHEDULED",
    timezone: "Europe/Helsinki",
    location: null,
    description: null,
    recurrenceRule: null,
    isOccurrence: false,
    contactId: null,
    companyId: null,
    dealId: null,
    ownerId: null,
    attendees: [],
    ...overrides,
  };
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

function inputValue(html: string, id: string): string | undefined {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.getElementById(id) as HTMLInputElement | null)?.getAttribute("value") ?? undefined;
}

describe("eventSchema: the editor's wall times are read in the event's own zone", () => {
  const base = { title: "Meeting" };

  it.each([
    ["Europe/Helsinki", "2026-10-07T09:00", "2026-10-07T06:00:00.000Z"], // DST
    ["Europe/Helsinki", "2026-12-07T09:00", "2026-12-07T07:00:00.000Z"], // standard time
    ["UTC", "2026-10-07T09:00", "2026-10-07T09:00:00.000Z"],
    ["America/New_York", "2026-10-07T09:00", "2026-10-07T13:00:00.000Z"],
  ])("%s %s is stored as %s", (timezone, startsAt, expected) => {
    const parsed = eventSchema.parse({ ...base, timezone, startsAt, endsAt: "2026-12-31T23:00" });
    expect(parsed.startsAt).toBe(expected);
  });

  it("instants that already carry Z or an offset pass through unchanged", () => {
    const parsed = eventSchema.parse({
      ...base,
      timezone: "Europe/Helsinki",
      startsAt: "2026-10-07T06:00:00.000Z",
      endsAt: "2026-10-07T09:30:00+03:00",
    });
    expect(parsed.startsAt).toBe("2026-10-07T06:00:00.000Z");
    expect(parsed.endsAt).toBe("2026-10-07T09:30:00+03:00");
  });

  it("rejects an unknown or fixed-offset timezone instead of guessing", () => {
    for (const timezone of ["Mars/Olympus", "+03:00"]) {
      const result = eventSchema.safeParse({
        ...base,
        timezone,
        startsAt: "2026-10-07T09:00",
        endsAt: "2026-10-07T10:00",
      });
      expect(result.success).toBe(false);
    }
  });

  it("end-before-start is checked on the converted instants", () => {
    const result = eventSchema.safeParse({
      ...base,
      timezone: "Europe/Helsinki",
      startsAt: "2026-10-07T10:00",
      endsAt: "2026-10-07T09:00",
    });
    expect(result.success).toBe(false);
  });
});

describe("event editor shows wall times in the event's zone", () => {
  it("the staging booking reopens as 09:00-09:30 Europe/Helsinki, not 06:00", () => {
    const html = renderToStaticMarkup(
      withIntl(
        <EventDialog
          event={booking()}
          timeZone="Europe/Helsinki"
          canWrite
          canDelete={false}
          options={options}
          onClose={() => {}}
        />,
      ),
    );
    expect(inputValue(html, "startsAt")).toBe("2026-10-07T09:00");
    expect(inputValue(html, "endsAt")).toBe("2026-10-07T09:30");
  });

  it("uses the event's own zone even when the viewer is elsewhere", () => {
    const html = renderToStaticMarkup(
      withIntl(
        <EventDialog
          event={booking()}
          timeZone="America/New_York"
          canWrite
          canDelete={false}
          options={options}
          onClose={() => {}}
        />,
      ),
    );
    expect(inputValue(html, "startsAt")).toBe("2026-10-07T09:00");
  });

  it("round trip: what the editor shows, saved with its zone, is the same instant", () => {
    for (const startsAt of ["2026-10-07T06:00:00.000Z", "2026-12-07T07:00:00.000Z"]) {
      const html = renderToStaticMarkup(
        withIntl(
          <EventDialog
            event={booking({ startsAt, endsAt: startsAt, source: "MANUAL" })}
            timeZone="Europe/Helsinki"
            canWrite
            canDelete={false}
            options={options}
            onClose={() => {}}
          />,
        ),
      );
      const wall = inputValue(html, "startsAt")!;
      const saved = eventSchema.parse({
        title: "x",
        timezone: "Europe/Helsinki",
        startsAt: wall,
        endsAt: "2026-12-31T23:00",
      });
      expect(saved.startsAt).toBe(startsAt);
    }
  });

  it("an assistant-suggested slot (an instant) prefills in the dialog's zone", () => {
    const html = renderToStaticMarkup(
      withIntl(
        <EventDialog
          date="2026-10-07"
          prefill={{ startsAt: "2026-10-07T06:00:00.000Z", endsAt: "2026-10-07T06:30:00.000Z" }}
          timeZone="Europe/Helsinki"
          canWrite
          canDelete={false}
          options={options}
          onClose={() => {}}
        />,
      ),
    );
    expect(inputValue(html, "startsAt")).toBe("2026-10-07T09:00");
  });
});

describe("public booking → internal calendar", () => {
  function agenda(timeZone: string, events = [booking()]) {
    return renderToStaticMarkup(
      withIntl(
        <CalendarView
          view="agenda"
          anchor="2026-10-06"
          q=""
          events={events}
          canWrite
          canDelete={false}
          options={options}
          timeZone={timeZone}
        />,
      ),
    );
  }

  it("a Helsinki viewer sees the booking at 09:00", () => {
    expect(agenda("Europe/Helsinki")).toContain("09:00");
    expect(agenda("Europe/Helsinki")).not.toContain("06:00");
  });

  it("a UTC viewer sees the same instant as 06:00", () => {
    expect(agenda("UTC")).toContain("06:00");
  });

  it("an event early in the local day is listed on its local day, not the UTC date", () => {
    // 00:30 Helsinki on 2026-10-08 is 21:30Z on 2026-10-07.
    const html = agenda("Europe/Helsinki", [
      booking({ startsAt: "2026-10-07T21:30:00.000Z", endsAt: "2026-10-07T22:00:00.000Z" }),
    ]);
    expect(html).toContain("Thursday, October 8, 2026");
    expect(html).not.toContain("Wednesday, October 7, 2026");
  });
});
