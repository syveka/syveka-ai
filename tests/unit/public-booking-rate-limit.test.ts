import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Public booking writes (create, reschedule, cancel) fail closed when their
 * per-IP limit can't be verified: Upstash *allows* a request when Redis doesn't
 * answer in time, so a timeout used to book, email and schedule reminders
 * unchecked. Now a timeout or a Redis error is a 503 and nothing is written,
 * sent or scheduled. Over the limit is a 429 with Retry-After.
 *
 * Reads (slots, manage GET) keep their previous behaviour on a timeout: they
 * change nothing and the manage page is gated by its token.
 *
 * The real helpers (checkRateLimit → rateLimitRefusal) run against a fake
 * Upstash with each limiter's configured maximum, as in rate-limit-gaps.test.ts.
 */

const s = vi.hoisted(() => ({
  mode: "ok" as "ok" | "timeout" | "throw",
  counts: new Map<string, number>(),
}));

const fx = vi.hoisted(() => ({
  createPublicBooking: vi.fn(),
  rescheduleBookingViaToken: vi.fn(),
  cancelBookingViaToken: vi.fn(),
  getBookingByToken: vi.fn(),
  getPublicSlots: vi.fn(),
  notify: vi.fn(async () => ({ guestEmail: "sent" })),
  reminders: vi.fn(async () => undefined),
}));

vi.mock("@upstash/redis", () => ({ Redis: class Redis {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow(max: number) {
      return { max };
    }
    private readonly prefix: string;
    private readonly max: number;
    constructor(opts: { prefix?: string; limiter: { max: number } }) {
      this.prefix = opts.prefix ?? "";
      this.max = opts.limiter.max;
    }
    async limit(key: string) {
      if (s.mode === "throw") throw new Error("fetch failed");
      // Upstash allows a request when Redis doesn't answer in time.
      if (s.mode === "timeout") {
        return { success: true, reason: "timeout", limit: 0, remaining: 0, reset: 0 };
      }
      const id = `${this.prefix}|${key}`;
      const used = (s.counts.get(id) ?? 0) + 1;
      s.counts.set(id, used);
      return {
        success: used <= this.max,
        limit: this.max,
        remaining: Math.max(0, this.max - used),
        reset: Date.now() + 60_000,
      };
    }
  },
}));

const { BookingError } = vi.hoisted(() => ({
  BookingError: class BookingError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/services/booking", () => ({
  createPublicBooking: fx.createPublicBooking,
  rescheduleBookingViaToken: fx.rescheduleBookingViaToken,
  cancelBookingViaToken: fx.cancelBookingViaToken,
  getBookingByToken: fx.getBookingByToken,
  getPublicSlots: fx.getPublicSlots,
  BookingError,
}));
vi.mock("@/server/services/booking-tokens", () => ({
  BookingTokenError: class BookingTokenError extends Error {
    readonly code = "invalid_token";
  },
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: fx.notify,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: fx.reminders }));

const createRoute = await import("@/app/api/v1/booking/[org]/[slug]/route");
const manageRoute = await import("@/app/api/v1/booking/manage/[token]/route");
const slotsRoute = await import("@/app/api/v1/booking/[org]/[slug]/slots/route");

const IP = "203.0.113.7";
const headers = { "Content-Type": "application/json", "x-forwarded-for": IP };
const bookingParams = { params: Promise.resolve({ org: "acme", slug: "intro" }) };
const tokenParams = { params: Promise.resolve({ token: "tok" }) };

const create = () =>
  createRoute.POST(
    new Request("http://localhost/api/v1/booking/acme/intro", {
      method: "POST",
      headers,
      body: JSON.stringify({
        startsAt: "2026-10-07T06:00:00.000Z",
        timezone: "Europe/Helsinki",
        name: "Guest",
        email: "guest@example.com",
        consent: true,
        locale: "en",
      }),
    }),
    bookingParams,
  );
const reschedule = () =>
  manageRoute.POST(
    new Request("http://localhost/api/v1/booking/manage/tok", {
      method: "POST",
      headers,
      body: JSON.stringify({ startsAt: "2026-10-08T06:00:00.000Z" }),
    }),
    tokenParams,
  );
const cancel = () =>
  manageRoute.DELETE(
    new Request("http://localhost/api/v1/booking/manage/tok", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ reason: "Can't make it" }),
    }),
    tokenParams,
  );
const viewBooking = () =>
  manageRoute.GET(
    new Request("http://localhost/api/v1/booking/manage/tok", { headers }),
    tokenParams,
  );
const slots = () =>
  slotsRoute.GET(
    new Request(
      "http://localhost/api/v1/booking/acme/intro/slots?from=2026-10-07T00:00:00.000Z&to=2026-10-08T00:00:00.000Z",
      { headers },
    ),
    bookingParams,
  );

const result = {
  booking: {
    id: "b-1",
    organizationId: "org-a",
    startsAt: new Date("2026-10-07T06:00:00.000Z"),
    endsAt: new Date("2026-10-07T06:30:00.000Z"),
  },
  event: { id: "e-1" },
  manageToken: "tok-2",
  bookingType: { confirmationMessage: null },
};

const writes = [
  ["create", create, fx.createPublicBooking],
  ["reschedule", reschedule, fx.rescheduleBookingViaToken],
  ["cancel", cancel, fx.cancelBookingViaToken],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  s.mode = "ok";
  s.counts.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  fx.createPublicBooking.mockResolvedValue(result);
  fx.rescheduleBookingViaToken.mockResolvedValue(result);
  fx.cancelBookingViaToken.mockResolvedValue({ id: "b-1" });
  fx.getBookingByToken.mockResolvedValue({
    bookingType: { name: "Intro", location: null },
    status: "CONFIRMED",
    startsAt: result.booking.startsAt,
    endsAt: result.booking.endsAt,
    guestName: "Guest",
    guestTimezone: "Europe/Helsinki",
  });
  fx.getPublicSlots.mockResolvedValue({
    timezone: "Europe/Helsinki",
    durationMinutes: 30,
    slots: [],
  });
});

describe("public booking writes fail closed when the rate limit can't be verified", () => {
  for (const mode of ["timeout", "throw"] as const) {
    for (const [name, call, mutation] of writes) {
      it(`${name}: a Redis ${mode === "throw" ? "error" : "timeout"} is a 503; nothing is written, emailed or scheduled`, async () => {
        s.mode = mode;
        const res = await call();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: { code: "service_unavailable" } });
        expect(mutation).not.toHaveBeenCalled();
        expect(fx.notify).not.toHaveBeenCalled();
        expect(fx.reminders).not.toHaveBeenCalled();
      });
    }
  }

  for (const [name, call, mutation] of writes) {
    it(`${name}: over the limit is a 429 with Retry-After; nothing is written`, async () => {
      // The `auth` limiter allows 10 per minute per key.
      for (let i = 0; i < 10; i += 1) await call();
      mutation.mockClear();
      fx.notify.mockClear();
      fx.reminders.mockClear();
      const res = await call();
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
      expect(mutation).not.toHaveBeenCalled();
      expect(fx.notify).not.toHaveBeenCalled();
      expect(fx.reminders).not.toHaveBeenCalled();
    });
  }

  it("under the limit, each write runs as before", async () => {
    const created = await create();
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ bookingId: "b-1", manageToken: "tok-2" });
    expect(fx.createPublicBooking).toHaveBeenCalledTimes(1);
    expect(fx.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "confirmation" }));
    expect(fx.reminders).toHaveBeenCalledTimes(1);

    const moved = await reschedule();
    expect(moved.status).toBe(200);
    expect(fx.rescheduleBookingViaToken).toHaveBeenCalledWith("tok", "2026-10-08T06:00:00.000Z");

    const canceled = await cancel();
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ status: "canceled" });
    expect(fx.cancelBookingViaToken).toHaveBeenCalledWith("tok", "Can't make it");
  });

  it("keeps each write's limit key per IP (create separate from manage)", async () => {
    await create();
    await reschedule();
    await cancel();
    const countFor = (key: string) =>
      [...s.counts].filter(([id]) => id.endsWith(`|${key}`)).map(([, used]) => used);
    expect(countFor(`booking-create:${IP}`)).toEqual([1]);
    expect(countFor(`booking-manage:${IP}`)).toEqual([2]);
  });
});

describe("public booking reads stay available on a Redis timeout", () => {
  it("slots still load", async () => {
    s.mode = "timeout";
    const res = await slots();
    expect(res.status).toBe(200);
    expect(fx.getPublicSlots).toHaveBeenCalledTimes(1);
  });

  it("the manage page still shows the booking to its token holder", async () => {
    s.mode = "timeout";
    const res = await viewBooking();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "CONFIRMED", guestName: "Guest" });
  });
});
