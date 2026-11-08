/**
 * A fake of the public booking API (/api/v1/booking/...) for browser tests,
 * answering a Playwright page's requests in the test process. It is a fake of
 * the transport, not of the rules that matter here:
 *   - slots come from the real computeAvailableSlots (DST, notice, busy time),
 *   - request bodies are parsed with the real public booking schemas,
 *   - status codes and error codes follow the real route handlers
 *     (src/app/api/v1/booking/**): 409 slot_taken, 400 invalid_slot,
 *     400 too_late for a booking that already started, 404 for a bad token.
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
};

export const SALON = {
  orgSlug: "salon-aurora",
  typeSlug: "hiustenleikkaus",
  timezone: "Europe/Helsinki",
  durationMinutes: 60,
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
      const taken = busy().some(
        (b) => b.startsAt < new Date(startsAt.getTime() + 3_600_000) && b.endsAt > startsAt,
      );
      if (taken) return json(route, 409, { error: "slot_taken" });
      if (!offered(startsAt)) return json(route, 400, { error: "invalid_slot" });
      const token = `token-${api.bookings.length + 1}`;
      api.addBooking({
        token,
        startsAt,
        guestName: parsed.data.name,
        guestEmail: parsed.data.email,
        guestTimezone: parsed.data.timezone,
      });
      return json(route, 201, {
        bookingId: `bk-${api.bookings.length}`,
        startsAt: startsAt.toISOString(),
        manageToken: token,
        confirmationMessage: null,
        confirmationEmailSent: true,
      });
    }

    const manage = url.pathname.match(/^\/api\/v1\/booking\/manage\/([^/]+)$/);
    if (manage) {
      const booking = api.bookings.find((b) => b.token === manage[1]);
      if (!booking || booking.status !== "CONFIRMED") return json(route, 404, { error: "invalid" });
      if (request.method() === "DELETE") {
        if (booking.startsAt < now) return json(route, 400, { error: "too_late" });
        booking.status = "CANCELED";
        return json(route, 200, { ok: true });
      }
      if (request.method() === "POST") {
        const parsed = publicRescheduleSchema.safeParse(body);
        if (!parsed.success) return json(route, 400, { error: "invalid_input" });
        if (booking.startsAt < now) return json(route, 400, { error: "too_late" });
        const startsAt = new Date(parsed.data.startsAt);
        if (!offered(startsAt, booking)) return json(route, 409, { error: "slot_taken" });
        booking.status = "RESCHEDULED";
        const token = `token-${api.bookings.length + 1}`;
        api.addBooking({ ...booking, token, startsAt, status: "CONFIRMED" });
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
