import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staging QA, 2026-10-10: saving an occurrence of a weekly series cleared the
 * series' rule because the editor's Repeat field was absent from the form.
 * An absent field must keep the stored rule; an explicit "Does not repeat"
 * (an empty value) still clears it.
 */

const m = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({
    userId: "user-1",
    email: "a@test.fi",
    orgId: "org-a",
    role: "MEMBER",
    locale: "en",
  })),
  updateEvent: vi.fn(async () => ({ id: "series-1" })),
  findConflicts: vi.fn(async () => []),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: m.requirePermission }));
// In limit: the write limit itself is covered by rate-limit-write-actions.test.ts.
vi.mock("@/server/security/rate-limit", () => ({
  actionWriteLimitError: vi.fn(async () => null),
}));
vi.mock("@/server/services/calendar", () => ({
  CalendarError: class CalendarError extends Error {},
  cancelEvent: vi.fn(),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
  findConflicts: m.findConflicts,
  updateEvent: m.updateEvent,
}));
vi.mock("@/server/services/booking-assistant", () => ({
  assistScheduling: vi.fn(),
  generateMeetingSummary: vi.fn(),
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: vi.fn() }));
vi.mock("@/server/services/ai-spend", () => ({
  AiSpendError: class AiSpendError extends Error {},
  assertAiSpendAllowed: vi.fn(),
  recordAiSpend: vi.fn(),
}));

import { saveEventAction } from "@/actions/calendar";
import { busyIntervals } from "@/server/calendar/busy";

function seriesForm(fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  const all: Record<string, string> = {
    title: "QA Recurring Test",
    startsAt: "2026-10-12T14:00",
    endsAt: "2026-10-12T15:00",
    timezone: "Europe/Helsinki",
    attendees: "[]",
    allowConflict: "false",
    ...fields,
  };
  for (const [key, value] of Object.entries(all)) form.set(key, value);
  return form;
}

beforeEach(() => vi.clearAllMocks());

describe("saveEventAction never clears a series' rule by omission", () => {
  it("a form without the Repeat field keeps the stored rule", async () => {
    const result = await saveEventAction("series-1", {}, seriesForm());
    expect(result).toEqual({ message: "saved" });
    expect(m.updateEvent).toHaveBeenCalledWith(
      expect.anything(),
      "series-1",
      expect.objectContaining({ startsAt: "2026-10-12T11:00:00.000Z" }),
      { keepRecurrenceRule: true },
    );
  });

  it("an explicit 'Does not repeat' (empty value) clears it", async () => {
    await saveEventAction("series-1", {}, seriesForm({ recurrenceRule: "" }));
    const [, , input, options] = m.updateEvent.mock.calls[0] as unknown as [
      unknown,
      string,
      { recurrenceRule?: string },
      { keepRecurrenceRule: boolean },
    ];
    expect(options).toEqual({ keepRecurrenceRule: false });
    expect(input.recurrenceRule).toBeUndefined(); // updateEvent writes null
  });

  it("a submitted rule is saved as given", async () => {
    await saveEventAction("series-1", {}, seriesForm({ recurrenceRule: "FREQ=WEEKLY" }));
    expect(m.updateEvent).toHaveBeenCalledWith(
      expect.anything(),
      "series-1",
      expect.objectContaining({ recurrenceRule: "FREQ=WEEKLY" }),
      { keepRecurrenceRule: false },
    );
  });
});

describe("booking/busy time after a series edit still blocks every occurrence", () => {
  it("the edited weekly series is busy on each Monday at its new time", () => {
    // The series row as saved by the Oct 19 case after the fix: Oct 12, 14:00–15:00 Helsinki.
    const row = {
      startsAt: new Date("2026-10-12T11:00:00.000Z"),
      endsAt: new Date("2026-10-12T12:00:00.000Z"),
      recurrenceRule: "FREQ=WEEKLY",
    };
    const busy = busyIntervals(
      [row],
      new Date("2026-10-12T00:00:00.000Z"),
      new Date("2026-11-03T00:00:00.000Z"),
    );
    expect(busy.map((b) => b.startsAt.toISOString().slice(0, 10))).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
    expect(busy.every((b) => b.startsAt.getUTCDay() === 1)).toBe(true);
    expect(busy.every((b) => b.endsAt.getTime() - b.startsAt.getTime() === 3_600_000)).toBe(true);
  });
});
