import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sendBookingLifecycleNotifications (src/server/services/booking-notifications.ts)
 * is the ONLY thing standing between a QStash/client retry and a customer
 * receiving two confirmation/cancellation/reschedule emails for the same
 * booking - its Redis idempotency gate is a high-risk invariant with no
 * prior dedicated coverage (booking-service.test.ts only ever mocks this
 * function as a black box, never exercises its own logic). These tests
 * close that gap without touching the function itself.
 */

const { unscopedPrismaMock, sendEmailMock, seenIdempotencyKeyMock } = vi.hoisted(() => ({
  unscopedPrismaMock: {
    booking: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    notification: { create: vi.fn(async () => ({})) },
  },
  sendEmailMock: vi.fn(async (_params: { to: string; subject: string; react: unknown }) => {
    void _params;
    return undefined;
  }),
  seenIdempotencyKeyMock: vi.fn(async (_key: string) => {
    void _key;
    return false;
  }),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedPrismaMock,
}));

vi.mock("@/server/integrations/resend", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/server/integrations/redis", () => ({
  seenIdempotencyKey: seenIdempotencyKeyMock,
}));

vi.mock("@/env", () => ({
  getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.com" }),
}));

vi.mock("../../emails/booking-email", () => ({
  // Returns the props it was called with (rather than rendering) so
  // assertions can inspect exactly what booking-notifications.ts passed in
  // (locale, manageUrl, ...) without needing real react-email rendering.
  BookingEmail: vi.fn((props: unknown) => props),
  bookingEmailSubject: vi.fn((kind: string) => `subject:${kind}`),
}));

import { sendBookingLifecycleNotifications } from "@/server/services/booking-notifications";

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    organizationId: "org-a",
    guestEmail: "guest@example.com",
    guestName: "Guest Name",
    guestLocale: "EN",
    guestTimezone: "Europe/Helsinki",
    startsAt: new Date("2026-06-01T09:00:00.000Z"),
    endsAt: new Date("2026-06-01T09:30:00.000Z"),
    bookingType: {
      name: "Consultation",
      location: null,
      confirmationMessage: null,
      ownerId: "owner-1",
    },
    organization: { id: "org-a", name: "Acme", slug: "acme" },
    ...overrides,
  };
}

function ownerRow(overrides: Record<string, unknown> = {}) {
  return { id: "owner-1", email: "owner@example.com", timezone: "Europe/Helsinki", ...overrides };
}

describe("sendBookingLifecycleNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seenIdempotencyKeyMock.mockResolvedValue(false);
    unscopedPrismaMock.booking.findUnique.mockResolvedValue(bookingRow());
    unscopedPrismaMock.user.findUnique.mockResolvedValue(ownerRow());
  });

  it("CRITICAL: a retried/redelivered call for the same booking+kind is a full no-op (idempotency gate)", async () => {
    seenIdempotencyKeyMock.mockResolvedValue(true);

    await sendBookingLifecycleNotifications({ kind: "confirmation", bookingId: "booking-1" });

    expect(seenIdempotencyKeyMock).toHaveBeenCalledWith("booking-notify:booking-1:confirmation");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(unscopedPrismaMock.notification.create).not.toHaveBeenCalled();
    // The idempotency key must never have been consulted before the booking
    // lookup - findUnique still runs (to resolve the key's own bookingId),
    // but no side effect follows it.
    expect(unscopedPrismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("the idempotency key is scoped to both bookingId AND kind - a different kind for the same booking is NOT suppressed", async () => {
    seenIdempotencyKeyMock.mockImplementation(
      async (key: string) => key === "booking-notify:booking-1:confirmation",
    );

    await sendBookingLifecycleNotifications({ kind: "cancellation", bookingId: "booking-1" });

    expect(sendEmailMock).toHaveBeenCalled();
  });

  it("sends both the guest email and the owner email, plus one in-app notification, on a fresh call", async () => {
    await sendBookingLifecycleNotifications({ kind: "confirmation", bookingId: "booking-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls[0]![0]).toMatchObject({ to: "guest@example.com" });
    expect(sendEmailMock.mock.calls[1]![0]).toMatchObject({ to: "owner@example.com" });
    expect(unscopedPrismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(unscopedPrismaMock.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          userId: "owner-1",
          type: "booking.confirmation",
        }),
      }),
    );
  });

  it("degrades gracefully when the booking no longer exists (deleted between enqueue and processing)", async () => {
    unscopedPrismaMock.booking.findUnique.mockResolvedValue(null);

    await expect(
      sendBookingLifecycleNotifications({ kind: "confirmation", bookingId: "gone" }),
    ).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("still sends the guest email when the owner user record is missing, but skips the owner email/notification", async () => {
    unscopedPrismaMock.user.findUnique.mockResolvedValue(null);

    await sendBookingLifecycleNotifications({ kind: "confirmation", bookingId: "booking-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0]).toMatchObject({ to: "guest@example.com" });
    expect(unscopedPrismaMock.notification.create).not.toHaveBeenCalled();
  });

  it("a guest email send failure never throws or blocks the owner email (failures are swallowed)", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("resend outage"));

    await expect(
      sendBookingLifecycleNotifications({ kind: "confirmation", bookingId: "booking-1" }),
    ).resolves.toBeUndefined();
    // Owner email (the second call) still attempted despite the first failing.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("includes a manage URL built from the token only when manageToken is provided", async () => {
    await sendBookingLifecycleNotifications({
      kind: "confirmation",
      bookingId: "booking-1",
      manageToken: "tok_abc123",
    });
    const guestCallProps = sendEmailMock.mock.calls[0]![0] as { react: unknown };
    expect(JSON.stringify(guestCallProps.react)).toContain(
      "https://app.example.com/booking/manage/tok_abc123",
    );
  });

  it("omits a manage URL entirely when no manageToken is provided", async () => {
    await sendBookingLifecycleNotifications({ kind: "reminder", bookingId: "booking-1" });
    const guestCallProps = sendEmailMock.mock.calls[0]![0] as { react: unknown };
    expect(JSON.stringify(guestCallProps.react)).not.toContain("/booking/manage/");
  });

  it("maps guestLocale FI/AR to the guest email locale, but the owner email always stays English regardless of guest locale", async () => {
    unscopedPrismaMock.booking.findUnique.mockResolvedValue(bookingRow({ guestLocale: "FI" }));

    await sendBookingLifecycleNotifications({ kind: "confirmation", bookingId: "booking-1" });

    const guestReact = sendEmailMock.mock.calls[0]![0] as { react: unknown };
    const ownerReact = sendEmailMock.mock.calls[1]![0] as { react: unknown };
    expect(JSON.stringify(guestReact.react)).toContain('"locale":"fi"');
    expect(JSON.stringify(ownerReact.react)).toContain('"locale":"en"');
  });
});
