import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RedisModule from "@/server/integrations/redis";

/**
 * Outgoing email from the platform's domain can't be pointed at strangers in
 * bulk. Public bookings email the address the guest typed, so one address and
 * one booking page are capped whatever the IP. Calendar-event reminders email
 * every attendee address, so the addresses a save adds spend a per-organization
 * hourly and daily budget.
 *
 * Real: the booking route, saveEventAction, the shared rate-limit helpers and
 * the limiter sizes. Faked: checkRateLimit, as an in-memory counter with the
 * installed @upstash/ratelimit sliding-window rule (refused once the window is
 * full; a request costing more than what is left is refused and still
 * counted), and the services behind the route and the action.
 */

const s = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  unavailable: false,
  limits: {} as Record<string, number>,
  addedEmails: [] as string[],
  /** The tenant the event action runs as. */
  orgId: "org-a",
}));

const f = vi.hoisted(() => ({
  createPublicBooking: vi.fn(),
  notify: vi.fn(async () => ({ guestEmail: "sent" })),
  reminders: vi.fn(async () => undefined),
  createEvent: vi.fn(async () => ({ id: "event-1", startsAt: new Date("2026-11-20T10:00:00Z") })),
  updateEvent: vi.fn(async () => ({ id: "event-1" })),
}));

vi.mock("@/server/integrations/redis", async (importActual) => {
  const actual = await importActual<typeof RedisModule>();
  s.limits = {
    auth: 10,
    publicBookingRecipient: actual.PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY,
    publicBookingType: actual.PUBLIC_BOOKING_ATTEMPTS_PER_TYPE_PER_HOUR,
    eventReminderRecipientsHour: actual.EVENT_REMINDER_RECIPIENTS_PER_HOUR,
    eventReminderRecipientsDay: actual.EVENT_REMINDER_RECIPIENTS_PER_DAY,
    api: 100,
  };
  return {
    ...actual,
    checkRateLimit: vi.fn(async (name: string, key: string, cost = 1) => {
      if (s.unavailable) return { ok: false, reason: "unavailable" };
      const id = `${name}|${key}`;
      const used = s.counts.get(id) ?? 0;
      const limit = s.limits[name] ?? 1_000_000;
      if (used >= limit)
        return { ok: false, reason: "limited", reset: Date.now() + 60_000, limit, remaining: 0 };
      s.counts.set(id, used + cost);
      if (used + cost > limit) {
        return { ok: false, reason: "limited", reset: Date.now() + 60_000, limit, remaining: 0 };
      }
      return { ok: true };
    }),
  };
});

vi.mock("@/server/services/booking", () => ({
  createPublicBooking: f.createPublicBooking,
  BookingError: class BookingError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: f.notify,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: f.reminders }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    userId: "user-1",
    email: "owner@acme.test",
    orgId: s.orgId,
    role: "MEMBER",
    locale: "en",
  })),
}));
vi.mock("@/server/services/calendar", () => ({
  addedAttendeeEmails: vi.fn(async () => s.addedEmails),
  CalendarError: class CalendarError extends Error {},
  cancelEvent: vi.fn(),
  createEvent: f.createEvent,
  deleteEvent: vi.fn(),
  findConflicts: vi.fn(async () => []),
  updateEvent: f.updateEvent,
}));
vi.mock("@/server/services/booking-assistant", () => ({
  assistScheduling: vi.fn(),
  generateMeetingSummary: vi.fn(),
}));
vi.mock("@/server/services/ai-spend", () => ({
  AiSpendError: class AiSpendError extends Error {},
  assertAiSpendAllowed: vi.fn(),
  recordAiSpend: vi.fn(),
}));

import { POST as createBooking } from "@/app/api/v1/booking/[org]/[slug]/route";
import { saveEventAction } from "@/actions/calendar";
import {
  checkRateLimit,
  EVENT_REMINDER_RECIPIENTS_PER_DAY,
  EVENT_REMINDER_RECIPIENTS_PER_HOUR,
  PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY,
  PUBLIC_BOOKING_ATTEMPTS_PER_TYPE_PER_HOUR,
} from "@/server/integrations/redis";

function booking(email: string, ip: string, page = { org: "acme", slug: "intro" }) {
  return createBooking(
    new Request(`http://localhost/api/v1/booking/${page.org}/${page.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({
        startsAt: "2026-11-20T08:00:00.000Z",
        timezone: "Europe/Helsinki",
        name: "Guest",
        email,
        consent: true,
        locale: "en",
      }),
    }),
    { params: Promise.resolve(page) },
  );
}

let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter % 250}`;

function eventForm(): FormData {
  const form = new FormData();
  const fields: Record<string, string> = {
    title: "Planning",
    startsAt: "2026-11-20T12:00",
    endsAt: "2026-11-20T13:00",
    timezone: "Europe/Helsinki",
    attendees: "[]",
    allowConflict: "true",
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}
const addresses = (n: number, domain = "outside.test") =>
  Array.from({ length: n }, (_, i) => `person${i}@${domain}`);

beforeEach(() => {
  vi.clearAllMocks();
  s.counts.clear();
  s.unavailable = false;
  s.addedEmails = [];
  s.orgId = "org-a";
  f.createPublicBooking.mockResolvedValue({
    booking: {
      id: "b-1",
      organizationId: "org-a",
      startsAt: new Date("2026-11-20T08:00:00Z"),
      endsAt: new Date("2026-11-20T08:30:00Z"),
    },
    event: { id: "e-1" },
    bookingType: { confirmationMessage: null },
    manageToken: "token",
  });
});

describe("public booking: per recipient and per page", () => {
  it("one address is refused after its daily allowance, from any IP, with nothing booked or sent", async () => {
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY; i++) {
      expect((await booking("victim@example.test", freshIp())).status).toBe(200);
    }
    f.createPublicBooking.mockClear();
    f.notify.mockClear();
    f.reminders.mockClear();

    // The same address in other letter case is the same recipient.
    const refused = await booking("VICTIM@Example.test", freshIp());

    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ error: { code: "rate_limited" } });
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(f.createPublicBooking).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.reminders).not.toHaveBeenCalled();
    // Another address is unaffected.
    expect((await booking("someone-else@example.test", freshIp())).status).toBe(200);
  });

  it("the address is never a limiter key: only its hash is", async () => {
    await booking("guest@example.test", freshIp());
    const keys = [...s.counts.keys()];
    expect(keys.some((k) => k.startsWith("publicBookingRecipient|"))).toBe(true);
    expect(keys.join("\n")).not.toContain("guest@example.test");
  });

  it("one booking page is refused after its hourly allowance, across addresses and IPs", async () => {
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_TYPE_PER_HOUR; i++) {
      expect((await booking(`g${i}@example.test`, freshIp())).status).toBe(200);
    }
    f.createPublicBooking.mockClear();
    f.notify.mockClear();

    const refused = await booking("new@example.test", freshIp());
    expect(refused.status).toBe(429);
    expect(f.createPublicBooking).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();

    // Another organization's page has its own allowance; letter case doesn't make a new page.
    expect(
      (await booking("new@example.test", freshIp(), { org: "other", slug: "intro" })).status,
    ).toBe(200);
    expect(
      (await booking("x@example.test", freshIp(), { org: "ACME", slug: "Intro" })).status,
    ).toBe(429);
  });

  it("an unavailable limiter refuses with the existing 503 and books nothing", async () => {
    s.unavailable = true;
    const res = await booking("guest@example.test", freshIp());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: { code: "service_unavailable" } });
    expect(f.createPublicBooking).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("an invalid request spends no recipient or page allowance", async () => {
    const res = await createBooking(
      new Request("http://localhost/api/v1/booking/acme/intro", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ email: "guest@example.test" }),
      }),
      { params: Promise.resolve({ org: "acme", slug: "intro" }) },
    );
    expect(res.status).toBe(400);
    expect([...s.counts.keys()].filter((k) => !k.startsWith("auth|"))).toEqual([]);
  });
});

describe("calendar events: reminder recipients per organization", () => {
  it("a save within the budget is saved, spending one unit per added address", async () => {
    s.addedEmails = addresses(3);
    const state = await saveEventAction(undefined, {}, eventForm());
    expect(state.error).toBeUndefined();
    expect(f.createEvent).toHaveBeenCalledTimes(1);
    expect(s.counts.get("eventReminderRecipientsHour|org-a")).toBe(3);
    expect(s.counts.get("eventReminderRecipientsDay|org-a")).toBe(3);
  });

  it("a save adding no address spends nothing", async () => {
    s.addedEmails = [];
    await saveEventAction("event-1", {}, eventForm());
    expect(f.updateEvent).toHaveBeenCalledTimes(1);
    expect([...s.counts.keys()].filter((k) => k.startsWith("eventReminder"))).toEqual([]);
  });

  it("past the hourly budget the save is refused before anything is stored", async () => {
    s.addedEmails = addresses(50);
    expect((await saveEventAction(undefined, {}, eventForm())).error).toBeUndefined();
    s.addedEmails = addresses(EVENT_REMINDER_RECIPIENTS_PER_HOUR - 50, "second.test");
    expect((await saveEventAction(undefined, {}, eventForm())).error).toBeUndefined();
    f.createEvent.mockClear();
    f.reminders.mockClear();

    s.addedEmails = addresses(1, "third.test");
    const state = await saveEventAction(undefined, {}, eventForm());

    expect(state).toEqual({ error: "rate_limited" });
    expect(f.createEvent).not.toHaveBeenCalled();
    expect(f.reminders).not.toHaveBeenCalled();
  });

  it("the daily budget holds even when the hourly one has room", async () => {
    s.counts.set("eventReminderRecipientsDay|org-a", EVENT_REMINDER_RECIPIENTS_PER_DAY);
    s.addedEmails = addresses(1);
    const state = await saveEventAction(undefined, {}, eventForm());
    expect(state).toEqual({ error: "rate_limited" });
    expect(f.createEvent).not.toHaveBeenCalled();
  });

  it("an edit is refused too, so attendees can't be added to an existing event past the budget", async () => {
    s.counts.set("eventReminderRecipientsHour|org-a", EVENT_REMINDER_RECIPIENTS_PER_HOUR);
    s.addedEmails = addresses(2);
    const state = await saveEventAction("event-1", {}, eventForm());
    expect(state).toEqual({ error: "rate_limited" });
    expect(f.updateEvent).not.toHaveBeenCalled();
  });

  it("each organization has its own budget", async () => {
    s.counts.set("eventReminderRecipientsHour|org-a", EVENT_REMINDER_RECIPIENTS_PER_HOUR);
    s.orgId = "org-b";
    s.addedEmails = addresses(5);
    const state = await saveEventAction(undefined, {}, eventForm());
    expect(state.error).toBeUndefined();
    expect(s.counts.get("eventReminderRecipientsHour|org-b")).toBe(5);
  });

  it("an unavailable limiter refuses the save (fail closed)", async () => {
    s.addedEmails = addresses(1);
    // The shared write limiter runs first; make only the reminder budget unavailable.
    const counter = vi.mocked(checkRateLimit).getMockImplementation()!;
    vi.mocked(checkRateLimit).mockImplementation(async (name, key, cost) =>
      name.startsWith("eventReminder")
        ? { ok: false, reason: "unavailable" }
        : counter(name, key, cost),
    );
    try {
      const state = await saveEventAction(undefined, {}, eventForm());
      expect(state).toEqual({ error: "service_unavailable" });
      expect(f.createEvent).not.toHaveBeenCalled();
    } finally {
      vi.mocked(checkRateLimit).mockImplementation(counter);
    }
  });
});
