import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/booking/manage/[token] (reschedule). As on the booking route
 * (public-booking-route.test.ts), the reschedule must succeed when the email
 * fails, but the response now tells the guest whether the new confirmation
 * email actually left.
 */

const mocks = vi.hoisted(() => ({
  reschedule: vi.fn(),
  notify: vi.fn(),
  reminders: vi.fn(async () => undefined),
}));

// Rate limiting is covered by rate-limit-direct-sites-fail-closed.test.ts; here it always allows.
vi.mock("@/server/security/rate-limit", () => ({ rateLimitRefusal: vi.fn(async () => null) }));
vi.mock("@/server/services/booking", () => ({
  rescheduleBookingViaToken: mocks.reschedule,
  BookingError: class BookingError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/services/booking-tokens", () => ({
  BookingTokenError: class BookingTokenError extends Error {},
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: mocks.notify,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: mocks.reminders }));

const { POST } = await import("@/app/api/v1/booking/manage/[token]/route");

function request() {
  return new Request("http://localhost/api/v1/booking/manage/tok-old", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ startsAt: "2026-11-03T09:00:00.000Z" }),
  });
}

const params = { params: Promise.resolve({ token: "tok-old" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reschedule.mockResolvedValue({
    booking: {
      id: "b-1",
      organizationId: "org-a",
      startsAt: new Date("2026-11-03T09:00:00.000Z"),
    },
    event: { id: "e-1" },
    manageToken: "tok-new",
  });
});

describe("booking reschedule: confirmation email outcome", () => {
  it("reports the email as sent when the provider accepted it", async () => {
    mocks.notify.mockResolvedValue({ guestEmail: "sent" });
    const res = await POST(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bookingId: "b-1",
      manageToken: "tok-new",
      confirmationEmailSent: true,
    });
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reschedule", bookingId: "b-1", manageToken: "tok-new" }),
    );
  });

  it("a failed email never fails the reschedule, and is reported as not sent", async () => {
    mocks.notify.mockResolvedValue({ guestEmail: "failed" });
    const res = await POST(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookingId: "b-1", confirmationEmailSent: false });
  });

  it("an unexpected notification error is also reported as not sent", async () => {
    mocks.notify.mockRejectedValue(new Error("redis down"));
    const res = await POST(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ confirmationEmailSent: false });
  });

  it("an email already claimed (sent or in flight) is not reported as a failure", async () => {
    mocks.notify.mockResolvedValue({ guestEmail: "skipped" });
    const res = await POST(request(), params);
    expect(await res.json()).toMatchObject({ confirmationEmailSent: true });
  });
});
