/**
 * A fake of the public booking API (/api/v1/booking/...) for browser tests,
 * answering a Playwright page's requests in the test process. It is a fake of
 * the transport, not of the rules that matter here:
 *   - slots come from the real computeAvailableSlots (DST, notice, busy time),
 *   - request bodies are parsed with the real public booking schemas,
 *   - status codes, error codes and response fields follow the real route
 *     handlers and services (src/app/api/v1/booking/**, booking.ts): a time
 *     that is not offered, including one taken meanwhile, is 400
 *     invalid_slot (the service checks offered slots before its in-transaction
 *     re-check, whose 409 slot_taken only a true race reaches); 400
 *     consent_required; 400 too_late for a booking that already started;
 *     400 already_canceled; 404 for an unknown or used token.
 * Persistence, email and CRM writes are covered by the service tests.
 */
import type { Page, Route } from "@playwright/test";
import { computeAvailableSlots, type WeeklyRule } from "../../../src/server/calendar/slots";
import { publicBookingSchema, publicRescheduleSchema } from "../../../src/lib/validators/booking";

export type FakeBooking = {
  token: string;
  startsAt: Date;
  endsAt: Date;
  status: "CONFIRMED" | "CANCELED" | "RESCHEDULED";
  guestName: string;
  guestEmail: string;
  guestTimezone: string;
};

export type FakeBookingApi = {
  bookings: FakeBooking[];
  requests: Array<{ method: string; path: string; body: unknown }>;
  /** Mark a slot as taken by someone else (e.g. between load and submit). */
  takeSlot(startsAt: Date): void;
  addBooking(booking: Omit<FakeBooking, "endsAt" | "status"> & Partial<FakeBooking>): void;
  /** Whether a guest would be offered this start time now. */
  isOffered(startsAt: Date): boolean;
};

export const SALON = {
  orgSlug: "salon-aurora",
  typeSlug: "hiustenleikkaus",
  timezone: "Europe/Helsinki",
  durationMinutes: 60,
  requiresConsent: true,
  // Mon–Fri 09:00–17:00 local.
  rules: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
  })) satisfies WeeklyRule[],
};

export async function installFakeBookingApi(page: Page, now: Date): Promise<FakeBookingApi> {
  const api: FakeBookingApi = {
    bookings: [],
    requests: [],
    takeSlot(startsAt) {
      api.addBooking({
        token: `other-${startsAt.toISOString()}`,
        startsAt,
        guestName: "Someone else",
        guestEmail: "other@example.test",
        guestTimezone: SALON.timezone,
      });
    },
    isOffered(startsAt) {
      return offered(startsAt);
    },
    addBooking(booking) {
      api.bookings.push({
        status: "CONFIRMED",
        endsAt: new Date(booking.startsAt.getTime() + SALON.durationMinutes * 60_000),
        ...booking,
      });
    },
  };

  const busy = (except?: FakeBooking) =>
    api.bookings
      .filter((b) => b.status === "CONFIRMED" && b !== except)
      .map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt }));

  const slotsBetween = (from: Date, to: Date, except?: FakeBooking) =>
    computeAvailableSlots({
      timezone: SALON.timezone,
      rules: SALON.rules,
      overrides: [],
      busy: busy(except),
      from,
      to,
      now,
      durationMinutes: SALON.durationMinutes,
    });

  const offered = (startsAt: Date, except?: FakeBooking) =>
    slotsBetween(
      new Date(startsAt.getTime() - 86_400_000),
      new Date(startsAt.getTime() + 86_400_000),
      except,
    ).some((s) => s.getTime() === startsAt.getTime());

  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/v1/booking/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    api.requests.push({ method: request.method(), path: url.pathname, body });

    const base = `/api/v1/booking/${SALON.orgSlug}/${SALON.typeSlug}`;
    if (url.pathname === `${base}/slots` && request.method() === "GET") {
      const from = new Date(url.searchParams.get("from")!);
      const to = new Date(url.searchParams.get("to")!);
      return json(route, 200, {
        timezone: SALON.timezone,
        durationMinutes: SALON.durationMinutes,
        slots: slotsBetween(from, to).map((s) => s.toISOString()),
      });
    }

    if (url.pathname === base && request.method() === "POST") {
      const parsed = publicBookingSchema.safeParse(body);
      if (!parsed.success) return json(route, 400, { error: "invalid_input" });
      const startsAt = new Date(parsed.data.startsAt);
      if (!offered(startsAt)) return json(route, 400, { error: "invalid_slot" });
      if (SALON.requiresConsent && !parsed.data.consent) {
        return json(route, 400, { error: "consent_required" });
      }
      const token = `token-${api.bookings.length + 1}`;
      api.addBooking({
        token,
        startsAt,
        guestName: parsed.data.name,
        guestEmail: parsed.data.email,
        guestTimezone: parsed.data.timezone,
      });
      return json(route, 200, {
        bookingId: `bk-${api.bookings.length}`,
        manageToken: token,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + SALON.durationMinutes * 60_000).toISOString(),
        confirmationMessage: null,
        confirmationEmailSent: true,
      });
    }

    const manage = url.pathname.match(/^\/api\/v1\/booking\/manage\/([^/]+)$/);
    if (manage) {
      const booking = api.bookings.find((b) => b.token === manage[1]);
      // A moved booking's link was consumed by the move.
      if (!booking || booking.status === "RESCHEDULED") return json(route, 404, { error: "used" });
      if (booking.status === "CANCELED") return json(route, 400, { error: "already_canceled" });
      if (request.method() === "DELETE") {
        if (booking.startsAt < now) return json(route, 400, { error: "too_late" });
        booking.status = "CANCELED";
        return json(route, 200, { status: "canceled" });
      }
      if (request.method() === "POST") {
        const parsed = publicRescheduleSchema.safeParse(body);
        if (!parsed.success) return json(route, 400, { error: "invalid_input" });
        if (booking.startsAt < now) return json(route, 400, { error: "too_late" });
        const startsAt = new Date(parsed.data.startsAt);
        if (!offered(startsAt, booking)) return json(route, 400, { error: "invalid_slot" });
        booking.status = "RESCHEDULED";
        const token = `token-${api.bookings.length + 1}`;
        // A new booking at the new time (its own end, not the old one's).
        api.addBooking({
          token,
          startsAt,
          guestName: booking.guestName,
          guestEmail: booking.guestEmail,
          guestTimezone: booking.guestTimezone,
        });
        return json(route, 200, {
          bookingId: `bk-${api.bookings.length}`,
          manageToken: token,
          startsAt: startsAt.toISOString(),
          confirmationEmailSent: true,
        });
      }
    }

    return json(route, 404, { error: "not_found" });
  });

  return api;
}
