import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/booking/[org]/[slug]. Staging QA (2026-10-07): the page said a
 * confirmation email was "on its way" while none arrived. The booking must
 * still succeed when the email fails, but the response now tells the guest
 * whether the confirmation email actually left.
 */

const mocks = vi.hoisted(() => ({
  limit: vi.fn(async () => ({ success: true })),
  createPublicBooking: vi.fn(),
  notify: vi.fn(),
  reminders: vi.fn(async () => undefined),
}));

vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { auth: { limit: mocks.limit } },
}));
vi.mock("@/server/services/booking", () => ({
  createPublicBooking: mocks.createPublicBooking,
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
  sendBookingLifecycleNotifications: mocks.notify,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: mocks.reminders }));

const { POST } = await import("@/app/api/v1/booking/[org]/[slug]/route");

function request() {
  return new Request("http://localhost/api/v1/booking/acme/intro", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({
      startsAt: "2026-10-07T06:00:00.000Z",
      timezone: "Europe/Helsinki",
      name: "Guest",
      email: "guest@example.com",
      consent: true,
      locale: "en",
    }),
  });
}

const params = { params: Promise.resolve({ org: "acme", slug: "intro" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createPublicBooking.mockResolvedValue({
    booking: {
      id: "b-1",
      organizationId: "org-a",
      startsAt: new Date("2026-10-07T06:00:00.000Z"),
      endsAt: new Date("2026-10-07T06:30:00.000Z"),
    },
    event: { id: "e-1" },
    manageToken: "tok",
    bookingType: { confirmationMessage: null },
  });
});

describe("public booking: confirmation email outcome", () => {
  it("reports the email as sent when the provider accepted it", async () => {
    mocks.notify.mockResolvedValue({ guestEmail: "sent" });
    const res = await POST(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookingId: "b-1", confirmationEmailSent: true });
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirmation", bookingId: "b-1", manageToken: "tok" }),
    );
  });

  it("a failed email never fails the booking, and is reported as not sent", async () => {
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

  it("the booking is created exactly once per request", async () => {
    mocks.notify.mockResolvedValue({ guestEmail: "sent" });
    await POST(request(), params);
    expect(mocks.createPublicBooking).toHaveBeenCalledTimes(1);
  });
});
