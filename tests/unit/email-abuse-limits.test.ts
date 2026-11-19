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
  reschedule: vi.fn(),
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
    publicBookingOrgDay: actual.PUBLIC_BOOKING_ATTEMPTS_PER_ORG_PER_DAY,
    publicBookingRecipientDay: actual.PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_ANY_ORG_PER_DAY,
    publicBookingIpOrgDay: actual.PUBLIC_BOOKING_ATTEMPTS_PER_IP_PER_ORG_PER_DAY,
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

vi.mock("@/server/services/booking-tokens", () => ({
  BookingTokenError: class BookingTokenError extends Error {},
}));
vi.mock("@/server/services/booking", () => ({
  createPublicBooking: f.createPublicBooking,
  rescheduleBookingViaToken: f.reschedule,
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
  reminderRecipientsToCharge: vi.fn(async () => s.addedEmails),
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
import { POST as rescheduleViaLink } from "@/app/api/v1/booking/manage/[token]/route";
import { saveEventAction } from "@/actions/calendar";
import {
  checkRateLimit,
  EVENT_REMINDER_RECIPIENTS_PER_DAY,
  EVENT_REMINDER_RECIPIENTS_PER_HOUR,
  PUBLIC_BOOKING_ATTEMPTS_PER_IP_PER_ORG_PER_DAY,
  PUBLIC_BOOKING_ATTEMPTS_PER_ORG_PER_DAY,
  PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_ANY_ORG_PER_DAY,
  PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY,
  PUBLIC_BOOKING_ATTEMPTS_PER_TYPE_PER_HOUR,
} from "@/server/integrations/redis";
import { emailKey } from "@/server/security/rate-limit";
import { BookingError } from "@/server/services/booking";

const BOOKING_LIMITERS = [
  "publicBookingRecipient",
  "publicBookingRecipientDay",
  "publicBookingIpOrgDay",
  "publicBookingType",
  "publicBookingOrgDay",
] as const;
/** The booking limiter calls made, in order, as `name|key`. */
const bookingCalls = () =>
  vi
    .mocked(checkRateLimit)
    .mock.calls.filter(([name]) => (BOOKING_LIMITERS as readonly string[]).includes(name))
    .map(([name, key]) => `${name}|${key}`);

const PAGE = { org: "acme", slug: "intro" };
const OTHER_PAGE = { org: "other", slug: "intro" };
const THIRD_PAGE = { org: "third", slug: "intro" };
/** Booking pages by their exact slugs, as getPublicBookingType finds them. */
const PAGES: Record<string, { id: string; organizationId: string }> = {
  "acme/intro": { id: "type-acme-intro", organizationId: "org-acme" },
  "other/intro": { id: "type-other-intro", organizationId: "org-other" },
  "third/intro": { id: "type-third-intro", organizationId: "org-third" },
};
const OFFERED_SLOT = "2026-11-20T08:00:00.000Z";
const UNOFFERED_SLOT = "2026-11-20T03:00:00.000Z";
/** The guest addresses of bookings the fake service wrote. */
const booked: string[] = [];

function booking(email: string, ip: string, page = PAGE, startsAt = OFFERED_SLOT) {
  return createBooking(
    new Request(`http://localhost/api/v1/booking/${page.org}/${page.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({
        startsAt,
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
  booked.length = 0;
  // Like the real service: the page is found by its exact slugs, an offered
  // slot is checked, then admit runs, then the booking is written.
  f.createPublicBooking.mockImplementation(
    async (call: {
      orgSlug: string;
      typeSlug: string;
      input: { startsAt: string; email: string };
      admit?: (t: { id: string; organizationId: string }) => Promise<void>;
    }) => {
      const page = PAGES[`${call.orgSlug}/${call.typeSlug}`];
      if (!page) throw new BookingError("Booking page not found", "not_found");
      if (call.input.startsAt === UNOFFERED_SLOT) {
        throw new BookingError("Requested time is not available", "invalid_slot");
      }
      await call.admit?.(page);
      booked.push(call.input.email);
      return {
        booking: {
          id: `b-${booked.length}`,
          organizationId: page.organizationId,
          startsAt: new Date(OFFERED_SLOT),
          endsAt: new Date("2026-11-20T08:30:00Z"),
        },
        event: { id: "e-1" },
        bookingType: { confirmationMessage: null },
        manageToken: "token",
      };
    },
  );
});

describe("public booking: per recipient and per page", () => {
  it("one address is refused after its daily allowance with one business, from any IP, with nothing booked or sent", async () => {
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY; i++) {
      expect((await booking("victim@example.test", freshIp())).status).toBe(200);
    }
    booked.length = 0;
    f.notify.mockClear();
    f.reminders.mockClear();

    // The same address in other letter case is the same recipient.
    const refused = await booking("VICTIM@Example.test", freshIp());

    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ error: { code: "rate_limited" } });
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.reminders).not.toHaveBeenCalled();
    // Another address, and the same address with another business, are unaffected.
    expect((await booking("someone-else@example.test", freshIp())).status).toBe(200);
    expect((await booking("victim@example.test", freshIp(), OTHER_PAGE)).status).toBe(200);
  });

  it("the address is never a limiter key: only its hash is", async () => {
    await booking("guest@example.test", freshIp());
    const keys = [...s.counts.keys()];
    expect(keys.some((k) => k.startsWith("publicBookingRecipient|org-acme:"))).toBe(true);
    expect(keys.join("\n")).not.toContain("guest@example.test");
  });

  it("one booking page is refused after its hourly allowance, across addresses and IPs", async () => {
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_TYPE_PER_HOUR; i++) {
      expect((await booking(`g${i}@example.test`, freshIp())).status).toBe(200);
    }
    booked.length = 0;
    f.notify.mockClear();

    const refused = await booking("new@example.test", freshIp());
    expect(refused.status).toBe(429);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();

    // Another organization's page has its own allowance.
    expect((await booking("new@example.test", freshIp(), OTHER_PAGE)).status).toBe(200);
    // The page is keyed by its booking type, not by the URL's spelling.
    expect([...s.counts.keys()]).toContain("publicBookingType|type-acme-intro");
  });

  it("junk attempts don't use up a page or a guest: only bookable attempts count", async () => {
    // Far more requests for a slot that isn't offered than either allowance.
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_TYPE_PER_HOUR + 10; i++) {
      const res = await booking("victim@example.test", freshIp(), PAGE, UNOFFERED_SLOT);
      expect(res.status).toBe(400);
    }
    expect([...s.counts.keys()].filter((k) => !k.startsWith("auth|"))).toEqual([]);
    // The real guest still books, and so does anyone else.
    expect((await booking("victim@example.test", freshIp())).status).toBe(200);
    expect((await booking("other@example.test", freshIp())).status).toBe(200);
  });

  it("an unavailable limiter refuses with the existing 503 and books nothing", async () => {
    s.unavailable = true;
    const res = await booking("guest@example.test", freshIp());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: { code: "service_unavailable" } });
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("the admission limiters alone being unavailable also refuse with 503 and book nothing", async () => {
    const counter = vi.mocked(checkRateLimit).getMockImplementation()!;
    vi.mocked(checkRateLimit).mockImplementation(async (name, key, cost) =>
      name.startsWith("publicBooking")
        ? { ok: false, reason: "unavailable" }
        : counter(name, key, cost),
    );
    try {
      const res = await booking("guest@example.test", freshIp());
      expect(res.status).toBe(503);
      expect(booked).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
    } finally {
      vi.mocked(checkRateLimit).mockImplementation(counter);
    }
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

describe("rescheduling from the email link", () => {
  function reschedule(startsAt = OFFERED_SLOT) {
    return rescheduleViaLink(
      new Request("http://localhost/api/v1/booking/manage/x", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ startsAt }),
      }),
      { params: Promise.resolve({ token: "manage-token" }) },
    );
  }

  beforeEach(() => {
    // Like the real service: the new time must be offered, then admit runs,
    // then the booking is moved (and a new link issued).
    f.reschedule.mockImplementation(
      async (
        _token: string,
        startsAt: string,
        admit?: (b: {
          bookingTypeId: string;
          organizationId: string;
          guestEmail: string;
        }) => Promise<void>,
      ) => {
        if (startsAt === UNOFFERED_SLOT) {
          throw new BookingError("Requested time is not available", "invalid_slot");
        }
        await admit?.({
          bookingTypeId: "type-acme-intro",
          organizationId: "org-acme",
          guestEmail: "victim@example.test",
        });
        booked.push("victim@example.test");
        return {
          booking: {
            id: `b-${booked.length}`,
            organizationId: "org-acme",
            startsAt: new Date(startsAt),
          },
          event: { id: "e-1" },
          manageToken: "next-token",
        };
      },
    );
  });

  it("each reschedule spends the guest's allowance, so a link can't mail the guest without limit", async () => {
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY; i++) {
      expect((await reschedule()).status).toBe(200);
    }
    booked.length = 0;
    f.notify.mockClear();

    const refused = await reschedule();
    expect(refused.status).toBe(429);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("a new booking and its reschedules share the guest's allowance with that business", async () => {
    expect((await booking("victim@example.test", freshIp())).status).toBe(200);
    for (let i = 1; i < PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY; i++) {
      expect((await reschedule()).status).toBe(200);
    }
    expect((await reschedule()).status).toBe(429);
  });

  it("a reschedule to a time that isn't offered spends nothing", async () => {
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY + 3; i++) {
      expect((await reschedule(UNOFFERED_SLOT)).status).toBe(400);
    }
    expect([...s.counts.keys()].filter((k) => !k.startsWith("auth|"))).toEqual([]);
    expect((await reschedule()).status).toBe(200);
  });
});

describe("daily caps per organization and per recipient mailbox", () => {
  function moveBooking(email = "victim@example.test", ip = freshIp()) {
    f.reschedule.mockImplementation(
      async (
        _token: string,
        startsAt: string,
        admit?: (b: {
          bookingTypeId: string;
          organizationId: string;
          guestEmail: string;
        }) => Promise<void>,
      ) => {
        await admit?.({
          bookingTypeId: "type-acme-intro",
          organizationId: "org-acme",
          guestEmail: email,
        });
        booked.push(email);
        return {
          booking: { id: "b-1", organizationId: "org-acme", startsAt: new Date(startsAt) },
          event: { id: "e-1" },
          manageToken: "next-token",
        };
      },
    );
    return rescheduleViaLink(
      new Request("http://localhost/api/v1/booking/manage/x", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ startsAt: OFFERED_SLOT }),
      }),
      { params: Promise.resolve({ token: "manage-token" }) },
    );
  }

  it("create checks exactly these limiters and keys, narrowest first", async () => {
    expect((await booking("Guest@Example.test", "203.0.113.7")).status).toBe(200);
    expect(bookingCalls()).toEqual([
      `publicBookingRecipient|org-acme:${emailKey("guest@example.test")}`,
      `publicBookingRecipientDay|${emailKey("guest@example.test")}`,
      "publicBookingIpOrgDay|203.0.113.7:org-acme",
      "publicBookingType|type-acme-intro",
      "publicBookingOrgDay|org-acme",
    ]);
  });

  it("reschedule checks the same limiters and keys", async () => {
    expect((await moveBooking("victim@example.test", "203.0.113.7")).status).toBe(200);
    expect(bookingCalls()).toEqual([
      `publicBookingRecipient|org-acme:${emailKey("victim@example.test")}`,
      `publicBookingRecipientDay|${emailKey("victim@example.test")}`,
      "publicBookingIpOrgDay|203.0.113.7:org-acme",
      "publicBookingType|type-acme-intro",
      "publicBookingOrgDay|org-acme",
    ]);
  });

  it("the per-recipient daily key is the mailbox alone, folding aliases and case", async () => {
    await booking("first.last@gmail.com", freshIp());
    await booking("FirstLast+promo@googlemail.com", freshIp());
    const dayKeys = [...s.counts.keys()].filter((k) => k.startsWith("publicBookingRecipientDay|"));
    expect(dayKeys).toEqual([`publicBookingRecipientDay|${emailKey("firstlast@gmail.com")}`]);
    expect(s.counts.get(dayKeys[0]!)).toBe(2);
    expect(dayKeys[0]).not.toContain("org-");
    expect(dayKeys[0]).not.toContain("gmail");
  });

  it("one mailbox is capped across organizations, though each organization allows more", async () => {
    // Three organizations, so no per-organization count reaches its cap (5):
    // only the cross-organization recipient cap can refuse the last request.
    const pages = [PAGE, OTHER_PAGE, THIRD_PAGE];
    for (let i = 0; i < PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_ANY_ORG_PER_DAY; i++) {
      expect((await booking("victim@example.test", freshIp(), pages[i % 3])).status).toBe(200);
    }
    for (const org of ["org-acme", "org-other", "org-third"]) {
      expect(
        s.counts.get(`publicBookingRecipient|${org}:${emailKey("victim@example.test")}`),
      ).toBeLessThan(PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY);
    }
    booked.length = 0;
    f.notify.mockClear();
    vi.mocked(checkRateLimit).mockClear();

    const refused = await booking("Victim+x@example.test", freshIp(), OTHER_PAGE);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ error: { code: "rate_limited" } });
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Refused by the cross-organization cap, the last limiter that ran.
    expect(bookingCalls().at(-1)).toBe(
      `publicBookingRecipientDay|${emailKey("victim@example.test")}`,
    );
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
    expect((await booking("someone-else@example.test", freshIp())).status).toBe(200);
  });

  it("a reschedule is refused by the cross-organization recipient cap too", async () => {
    s.counts.set(
      `publicBookingRecipientDay|${emailKey("victim@example.test")}`,
      PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_ANY_ORG_PER_DAY,
    );
    const refused = await moveBooking();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("one organization is refused after its daily cap, whatever the page, guest or IP", async () => {
    s.counts.set("publicBookingOrgDay|org-acme", PUBLIC_BOOKING_ATTEMPTS_PER_ORG_PER_DAY);

    const refused = await booking("new@example.test", freshIp());
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ error: { code: "rate_limited" } });
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();

    expect((await moveBooking("fresh@example.test")).status).toBe(429);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
    // Another organization has its own cap.
    expect((await booking("new@example.test", freshIp(), OTHER_PAGE)).status).toBe(200);
  });

  it("one IP is refused after its daily allowance in one organization, with fresh guests, before the shared budgets", async () => {
    const ip = "203.0.113.9";
    // (The route's own per-IP "auth" limiter is a separate, earlier check.)
    s.counts.set(
      `publicBookingIpOrgDay|${ip}:org-acme`,
      PUBLIC_BOOKING_ATTEMPTS_PER_IP_PER_ORG_PER_DAY,
    );
    booked.length = 0;
    f.notify.mockClear();
    vi.mocked(checkRateLimit).mockClear();

    const refused = await booking("fresh@example.test", ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(bookingCalls().at(-1)).toBe(`publicBookingIpOrgDay|${ip}:org-acme`);
    expect(s.counts.has("publicBookingType|type-acme-intro")).toBe(false);
    expect(s.counts.has("publicBookingOrgDay|org-acme")).toBe(false);
    expect(booked).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();

    expect((await moveBooking("fresh2@example.test", ip)).status).toBe(429);
    expect(booked).toEqual([]);
    // Another organization, and another IP, are unaffected.
    expect((await booking("fresh@example.test", ip, OTHER_PAGE)).status).toBe(200);
    expect((await booking("fresh3@example.test", freshIp())).status).toBe(200);
  });

  it.each(["publicBookingRecipientDay", "publicBookingIpOrgDay", "publicBookingOrgDay"] as const)(
    "%s unavailable refuses create and reschedule with 503 and writes nothing",
    async (unavailableName) => {
      const counter = vi.mocked(checkRateLimit).getMockImplementation()!;
      vi.mocked(checkRateLimit).mockImplementation(async (name, key, cost) =>
        name === unavailableName ? { ok: false, reason: "unavailable" } : counter(name, key, cost),
      );
      try {
        const created = await booking("guest@example.test", freshIp());
        expect(created.status).toBe(503);
        await expect(created.json()).resolves.toEqual({ error: { code: "service_unavailable" } });
        expect((await moveBooking()).status).toBe(503);
        expect(booked).toEqual([]);
        expect(f.notify).not.toHaveBeenCalled();
        expect(f.reminders).not.toHaveBeenCalled();
      } finally {
        vi.mocked(checkRateLimit).mockImplementation(counter);
      }
    },
  );

  it("a request refused by a narrow limiter spends none of the broader budgets", async () => {
    s.counts.set(
      `publicBookingRecipient|org-acme:${emailKey("victim@example.test")}`,
      PUBLIC_BOOKING_ATTEMPTS_PER_RECIPIENT_PER_DAY,
    );
    expect((await booking("victim@example.test", freshIp())).status).toBe(429);
    expect(bookingCalls()).toEqual([
      `publicBookingRecipient|org-acme:${emailKey("victim@example.test")}`,
    ]);
    expect(s.counts.has("publicBookingOrgDay|org-acme")).toBe(false);
    expect(s.counts.has("publicBookingType|type-acme-intro")).toBe(false);
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
