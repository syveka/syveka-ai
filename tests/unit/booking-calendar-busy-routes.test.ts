import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A guest's booking or reschedule that timed out waiting for the calendar lock
 * is told to retry (503 with Retry-After), and any other failure stays what it was.
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reschedule: vi.fn(),
}));

vi.mock("@/server/security/rate-limit", () => ({
  rateLimitRefusal: vi.fn(async () => null),
  emailKey: vi.fn((email: string) => `hash:${email}`),
}));
vi.mock("@/server/services/booking", () => ({
  createPublicBooking: mocks.create,
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
  sendBookingLifecycleNotifications: vi.fn(),
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: vi.fn() }));

const { BookingError } = await import("@/server/services/booking");
const { POST: create } = await import("@/app/api/v1/booking/[org]/[slug]/route");
const { POST: reschedule } = await import("@/app/api/v1/booking/manage/[token]/route");

const post = (path: string, body: object) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });

const callCreate = () =>
  create(
    post("/api/v1/booking/acme/intro", {
      startsAt: "2026-10-07T06:00:00.000Z",
      timezone: "Europe/Helsinki",
      name: "Guest",
      email: "guest@example.com",
      consent: true,
    }),
    { params: Promise.resolve({ org: "acme", slug: "intro" }) },
  );

const callReschedule = () =>
  reschedule(post("/api/v1/booking/manage/tok", { startsAt: "2026-11-03T09:00:00.000Z" }), {
    params: Promise.resolve({ token: "tok" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ["guest booking", mocks.create, callCreate],
  ["guest reschedule", mocks.reschedule, callReschedule],
])("%s when the calendar stays locked", (_name, service, call) => {
  it("answers 503 with Retry-After and a stable code", async () => {
    service.mockRejectedValue(new BookingError("busy", "calendar_busy"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({ error: "calendar_busy" });
  });

  it("a slot taken meanwhile is still a 409", async () => {
    service.mockRejectedValue(new BookingError("taken", "slot_taken"));
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("an unexpected failure stays a generic 500 with no detail", async () => {
    service.mockRejectedValue(new Error("connection string with a secret"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed" });
  });
});
