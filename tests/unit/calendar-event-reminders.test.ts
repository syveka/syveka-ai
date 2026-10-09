import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { EventInput } from "@/lib/validators/calendar";

/**
 * Reminders follow a moved calendar event. They are created when the event is
 * created and timed from its start; moving the event must move them, and a job
 * already enqueued for the old time must send nothing.
 *
 * Synthetic data and a stateful in-memory fake: the calendar service, the
 * reminder scheduler and the send-reminder job run for real against it, with
 * the queue and email provider mocked (no external calls).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const EVENT = "evt-1";
const NOW = new Date("2026-03-01T09:00:00Z");
const HOUR = 3_600_000;

type ReminderRow = {
  id: string;
  organizationId: string;
  eventId: string;
  sendAt: Date;
  dedupeKey: string;
  status: "SCHEDULED" | "SENT" | "CANCELED" | "FAILED";
  sentAt: Date | null;
};
type EventRow = {
  id: string;
  organizationId: string;
  title: string;
  status: "CONFIRMED" | "CANCELED";
  deletedAt: Date | null;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
};

const s = vi.hoisted(() => ({
  seq: 0,
  reminders: [] as ReminderRow[],
  events: [] as EventRow[],
}));
const fx = vi.hoisted(() => ({
  enqueue: vi.fn(async (_job: string, _payload: { reminderId: string }, _opts: unknown) => ({
    messageId: "m",
  })),
  sendEmail: vi.fn(async (_args: { to: string; react: unknown }) => ({})),
  bookingEmail: vi.fn((props: { whenText: string }) => props),
  audit: vi.fn(async () => undefined),
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

vi.mock("@/server/db/tenant", () => {
  const reminder = {
    create: vi.fn(async ({ data }: { data: Omit<ReminderRow, "id" | "status" | "sentAt"> }) => {
      if (s.reminders.some((r) => r.dedupeKey === data.dedupeKey)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const id = `00000000-0000-4000-8000-${String(++s.seq).padStart(12, "0")}`;
      const row: ReminderRow = { ...data, id, status: "SCHEDULED", sentAt: null };
      s.reminders.push(row);
      return row;
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = s.reminders.filter((r) => matches(r, where));
        for (const r of rows) {
          if (data.status) r.status = data.status as ReminderRow["status"];
          if (data.sentAt) r.sentAt = data.sentAt as Date;
        }
        return { count: rows.length };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = s.reminders.length;
      s.reminders = s.reminders.filter((r) => !matches(r, where));
      return { count: before - s.reminders.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = s.reminders.find((x) => x.id === where.id);
      if (!r) return null;
      const e = s.events.find((x) => x.id === r.eventId);
      return {
        ...r,
        event: e
          ? {
              ...e,
              attendeeRecords: [{ email: "guest@example.test", name: "Guest" }],
              booking: null,
              organization: { name: "Org", deletedAt: null },
            }
          : null,
      };
    }),
    update: vi.fn(),
  };
  const tenant = {
    calendarEvent: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const e = s.events.find((x) => x.id === where.id && !x.deletedAt);
        return e ? { ...e, booking: null } : null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const e = s.events.find((x) => x.id === where.id)!;
          Object.assign(e, {
            title: data.title,
            startsAt: data.startsAt,
            endsAt: data.endsAt,
            timezone: data.timezone,
          });
          return { ...e };
        },
      ),
    },
  };
  return {
    unscopedPrisma: {
      reminder,
      eventAttendee: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
    },
    tenantDb: () => tenant,
  };
});
vi.mock("@/server/jobs/queue", () => ({ enqueue: fx.enqueue }));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (r: Request) => r.text() }));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: async () => true,
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: fx.sendEmail }));
vi.mock("../../emails/booking-email", () => ({
  bookingEmailSubject: () => "Reminder",
  BookingEmail: fx.bookingEmail,
}));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/server/services/booking", () => ({
  cancelBookingAsOwner: vi.fn(),
  BookingError: class extends Error {},
}));

// Loaded up front so the job route's dynamic imports resolve the mocks.
import "@/server/jobs/organization-guard";
import "@/server/db/tenant";
import { updateEvent } from "@/server/services/calendar";
import { scheduleEventReminders } from "@/server/services/reminders";
import { POST as sendReminder } from "@/app/api/v1/jobs/send-reminder/route";

const ctx: TenantContext = {
  userId: "user-1",
  email: "a@example.test",
  orgId: ORG,
  role: "MEMBER",
  locale: "en",
};

function input(startsAt: Date, overrides: Partial<EventInput> = {}): EventInput {
  return {
    title: "Planning",
    timezone: "UTC",
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + HOUR).toISOString(),
    allDay: false,
    attendees: [],
    ...overrides,
  } as EventInput;
}

async function createEventWithReminders(startsAt: Date): Promise<string[]> {
  s.events.push({
    id: EVENT,
    organizationId: ORG,
    title: "Planning",
    status: "CONFIRMED",
    deletedAt: null,
    timezone: "UTC",
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    location: null,
  });
  await scheduleEventReminders({ orgId: ORG, eventId: EVENT, startsAt });
  const ids = fx.enqueue.mock.calls.map((c) => c[1].reminderId);
  fx.enqueue.mockClear();
  return ids;
}

function deliver(reminderId: string) {
  return sendReminder(
    new Request("https://jobs.test/api/v1/jobs/send-reminder", {
      method: "POST",
      body: JSON.stringify({ reminderId }),
    }),
  );
}

const pending = () =>
  s.reminders
    .filter((r) => r.status === "SCHEDULED")
    .map((r) => r.sendAt.toISOString())
    .sort();

const tomorrowish = new Date("2026-03-03T09:00:00Z");
const nextWeek = new Date("2026-03-10T09:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  s.seq = 0;
  s.reminders = [];
  s.events = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("moving a calendar event moves its reminders", () => {
  it("reschedules pending reminders to the new start time", async () => {
    await createEventWithReminders(tomorrowish);
    expect(pending()).toEqual(["2026-03-02T09:00:00.000Z", "2026-03-03T08:00:00.000Z"]);

    await updateEvent(ctx, EVENT, input(nextWeek));

    expect(pending()).toEqual(["2026-03-09T09:00:00.000Z", "2026-03-10T08:00:00.000Z"]);
    // New jobs are enqueued for the new send times.
    const delays = fx.enqueue.mock.calls
      .map((c) => (c[2] as { delaySeconds: number }).delaySeconds)
      .sort((a, b) => a - b);
    expect(delays).toEqual([
      (nextWeek.getTime() - 24 * HOUR - NOW.getTime()) / 1000,
      (nextWeek.getTime() - HOUR - NOW.getTime()) / 1000,
    ]);
  });

  it("a job already enqueued for the old time sends nothing; the new one sends the new time", async () => {
    const oldJobs = await createEventWithReminders(tomorrowish);
    await updateEvent(ctx, EVENT, input(nextWeek));
    const newJobs = fx.enqueue.mock.calls.map((c) => c[1].reminderId);

    for (const id of oldJobs) {
      expect(await (await deliver(id)).json()).toEqual({ skipped: true });
    }
    expect(fx.sendEmail).not.toHaveBeenCalled();

    expect(await (await deliver(newJobs[0]!)).json()).toEqual({ sent: 1 });
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(fx.bookingEmail.mock.calls[0]![0].whenText).toContain("March 10, 2026");
  });

  it("moved earlier: only reminders still in the future are scheduled", async () => {
    await createEventWithReminders(tomorrowish);
    // 6 hours from now: the 24h point has passed, the 1h point has not.
    await updateEvent(ctx, EVENT, input(new Date(NOW.getTime() + 6 * HOUR)));
    expect(pending()).toEqual(["2026-03-01T14:00:00.000Z"]);
  });

  it("moved into the past: no reminders remain or are scheduled", async () => {
    await createEventWithReminders(tomorrowish);
    await updateEvent(ctx, EVENT, input(new Date(NOW.getTime() - 2 * HOUR)));
    expect(pending()).toEqual([]);
    expect(fx.enqueue).not.toHaveBeenCalled();
  });

  it("a reminder already sent for the old time does not block one for the new time", async () => {
    const [dayBefore] = await createEventWithReminders(tomorrowish);
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    expect(await (await deliver(dayBefore!)).json()).toEqual({ sent: 1 });

    await updateEvent(ctx, EVENT, input(nextWeek));

    expect(pending()).toEqual(["2026-03-09T09:00:00.000Z", "2026-03-10T08:00:00.000Z"]);
    expect(s.reminders.filter((r) => r.status === "SENT")).toHaveLength(1);
  });

  it("moved away and back: reminders for the original time are scheduled again", async () => {
    await createEventWithReminders(tomorrowish);
    await updateEvent(ctx, EVENT, input(nextWeek));
    await updateEvent(ctx, EVENT, input(tomorrowish));
    expect(pending()).toEqual(["2026-03-02T09:00:00.000Z", "2026-03-03T08:00:00.000Z"]);
  });

  it("unchanged start time leaves existing reminders and jobs untouched", async () => {
    await createEventWithReminders(tomorrowish);
    const before = s.reminders.map((r) => ({ ...r }));

    await updateEvent(ctx, EVENT, input(tomorrowish, { title: "Planning (agenda added)" }));

    expect(s.reminders).toEqual(before);
    expect(fx.enqueue).not.toHaveBeenCalled();
  });

  it("a canceled event that is moved gets no new reminders", async () => {
    await createEventWithReminders(tomorrowish);
    s.events[0]!.status = "CANCELED";
    s.reminders.forEach((r) => (r.status = "CANCELED"));

    await updateEvent(ctx, EVENT, input(nextWeek));

    expect(pending()).toEqual([]);
    expect(fx.enqueue).not.toHaveBeenCalled();
  });
});
