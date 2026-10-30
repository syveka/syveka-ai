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
  source: "MANUAL" | "GOOGLE" | "OUTLOOK";
};

const s = vi.hoisted(() => ({
  seq: 0,
  reminders: [] as ReminderRow[],
  events: [] as EventRow[],
  failReminderLookup: false,
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
  return Object.entries(where).every(([k, v]) =>
    v && typeof v === "object" && "in" in v ? (v.in as unknown[]).includes(row[k]) : row[k] === v,
  );
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
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (s.failReminderLookup) throw new Error("connection reset: reminders host db-1");
      return s.reminders.filter((r) => matches(r, where)).length;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = s.reminders.length;
      s.reminders = s.reminders.filter((r) => !matches(r, where));
      return { count: before - s.reminders.length };
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = s.reminders.find((r) => r.id === where.id);
      s.reminders = s.reminders.filter((r) => r.id !== where.id);
      return row;
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
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = s.reminders.find((r) => r.id === where.id)!;
        if (data.status) row.status = data.status as ReminderRow["status"];
        return { ...row };
      },
    ),
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

function addEvent(startsAt: Date, source: EventRow["source"] = "MANUAL"): void {
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
    source,
  });
}

async function createEventWithReminders(startsAt: Date): Promise<string[]> {
  addEvent(startsAt);
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
  s.failReminderLookup = false;
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

    expect(await (await deliver(newJobs[0]!)).json()).toEqual({ sent: 1, failed: 0 });
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
    expect(await (await deliver(dayBefore!)).json()).toEqual({ sent: 1, failed: 0 });

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
  it("moved into the past and back: reminders are scheduled again for the new time", async () => {
    await createEventWithReminders(tomorrowish);
    await updateEvent(ctx, EVENT, input(new Date(NOW.getTime() - 2 * HOUR)));
    await updateEvent(ctx, EVENT, input(nextWeek));
    expect(pending()).toEqual(["2026-03-09T09:00:00.000Z", "2026-03-10T08:00:00.000Z"]);
  });
});

describe("a reminder whose send failed is not sent for an event that has moved", () => {
  async function failFirstSend(): Promise<string> {
    const [dayBefore] = await createEventWithReminders(tomorrowish);
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.sendEmail.mockRejectedValueOnce(
      Object.assign(new Error("resend 503"), { name: "ResendError" }),
    );
    // Nobody reached: FAILED, and QStash will retry this message (500).
    expect((await deliver(dayBefore!)).status).toBe(500);
    log.mockRestore();
    expect(s.reminders.find((r) => r.id === dayBefore)!.status).toBe("FAILED");
    return dayBefore!;
  }

  it("moving the event cancels the failed reminder, so the pending retry sends nothing", async () => {
    const dayBefore = await failFirstSend();

    await updateEvent(ctx, EVENT, input(nextWeek));
    expect(s.reminders.find((r) => r.id === dayBefore)!.status).toBe("CANCELED");

    expect(await (await deliver(dayBefore)).json()).toEqual({ skipped: true });
    // Only the failed attempt reached the email provider.
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual(["2026-03-09T09:00:00.000Z", "2026-03-10T08:00:00.000Z"]);
  });

  it("a retry for a reminder timed from another start time is skipped even if nothing canceled it", async () => {
    const dayBefore = await failFirstSend();
    // Left uncanceled, e.g. by a concurrent move whose cancel ran first.
    s.events[0]!.startsAt = nextWeek;

    expect(await (await deliver(dayBefore)).json()).toEqual({ skipped: true });
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(s.reminders.find((r) => r.id === dayBefore)!.status).toBe("CANCELED");
  });

  it("a retry for an event that has not moved still sends, once", async () => {
    const dayBefore = await failFirstSend();
    expect(await (await deliver(dayBefore)).json()).toEqual({ sent: 1, failed: 0 });
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
    // A further delivery of the same message sends nothing.
    expect(await (await deliver(dayBefore)).json()).toEqual({ skipped: true });
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("a canceled event's failed reminder is not sent by its retry", async () => {
    const dayBefore = await failFirstSend();
    s.events[0]!.status = "CANCELED";
    expect(await (await deliver(dayBefore)).json()).toEqual({ skipped: true });
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("two concurrent moves of the same event", () => {
  it("only the reminders for the event's final time send; the other move's are canceled", async () => {
    await createEventWithReminders(tomorrowish);
    const later = new Date("2026-03-17T09:00:00Z");
    // Interleaved: move A (next week) and move B (later) both cancel the original reminders,
    // A's event write loses to B's, but A still schedules reminders for its own time.
    await updateEvent(ctx, EVENT, input(nextWeek));
    const moveA = fx.enqueue.mock.calls.map((c) => c[1].reminderId);
    fx.enqueue.mockClear();
    s.events[0]!.startsAt = later;
    await scheduleEventReminders({ orgId: ORG, eventId: EVENT, startsAt: later });
    const moveB = fx.enqueue.mock.calls.map((c) => c[1].reminderId);

    for (const id of moveA) {
      expect(await (await deliver(id)).json()).toEqual({ skipped: true });
      expect(s.reminders.find((r) => r.id === id)!.status).toBe("CANCELED");
    }
    expect(fx.sendEmail).not.toHaveBeenCalled();
    for (const id of moveB) {
      expect(await (await deliver(id)).json()).toEqual({ sent: 1, failed: 0 });
    }
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
  });
});

describe("events that never had reminders do not get them when moved", () => {
  it("an imported Google/Outlook event that is moved gets no reminders", async () => {
    addEvent(tomorrowish, "GOOGLE");
    await updateEvent(ctx, EVENT, input(nextWeek));
    expect(s.reminders).toEqual([]);
    expect(fx.enqueue).not.toHaveBeenCalled();
  });

  it("an assistant-booked event (created without reminders) that is moved gets none", async () => {
    addEvent(tomorrowish, "MANUAL");
    await updateEvent(ctx, EVENT, input(nextWeek));
    expect(s.reminders).toEqual([]);
    expect(fx.enqueue).not.toHaveBeenCalled();
  });
});

describe("a reminder failure does not fail an update that is already saved", () => {
  it("the move is saved and audited, and the failure is logged without its message", async () => {
    await createEventWithReminders(tomorrowish);
    s.failReminderLookup = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(updateEvent(ctx, EVENT, input(nextWeek))).resolves.toMatchObject({
      startsAt: nextWeek,
    });

    expect(fx.audit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: "calendar.update", resourceId: EVENT }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]![0]);
    expect(JSON.parse(logged)).toEqual({
      event: "calendar_reminder_reschedule_failed",
      orgId: ORG,
      eventId: EVENT,
      errorName: "Error",
    });
    expect(logged).not.toContain("db-1");
    log.mockRestore();
  });
});

describe("a reminder whose job could not be enqueued", () => {
  it("is not left SCHEDULED without a job: the row is removed, the failure logged, and the next schedule call can try again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const startsAt = new Date("2026-11-10T09:00:00Z");
    fx.enqueue.mockRejectedValueOnce(
      Object.assign(new Error("qstash: 503 https://qstash.upstash.io/v2/publish"), {
        name: "QstashError",
      }),
    );

    const scheduled = await scheduleEventReminders({ orgId: ORG, eventId: EVENT, startsAt });

    // Two offsets: the first enqueue failed and its row is gone; the second was scheduled.
    expect(scheduled).toBe(1);
    expect(s.reminders).toHaveLength(1);
    const logged = JSON.parse(String(log.mock.calls[0]![0]));
    expect(logged).toEqual({
      event: "reminder_enqueue_failed",
      orgId: ORG,
      eventId: EVENT,
      name: "QstashError",
    });
    expect(String(log.mock.calls[0]![0])).not.toContain("upstash.io");

    // A later call (the event re-saved) schedules the missing one.
    expect(await scheduleEventReminders({ orgId: ORG, eventId: EVENT, startsAt })).toBe(1);
    expect(s.reminders).toHaveLength(2);
    expect(fx.enqueue).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });
});
