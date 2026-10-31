import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * saveBookingTypeAction: an unticked checkbox submits nothing, and the
 * schema's `default(true)` used to turn that into `true`, so a booking type
 * could never be deactivated (nor its consent requirement switched off).
 * The guard, the write limit and the booking service are mocked; the real
 * bookingTypeSchema runs.
 */

const fx = vi.hoisted(() => ({
  saveBookingType: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return { id: "bt-1" };
  }),
}));

vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1", role: "OWNER" })),
}));
// The write limit is covered by rate-limit-write-actions.test.ts; here it always allows.
vi.mock("@/server/security/rate-limit", () => ({ actionWriteLimitError: vi.fn(async () => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/services/booking", () => ({
  BookingError: class BookingError extends Error {},
  deleteBookingType: vi.fn(),
  saveBookingType: fx.saveBookingType,
}));

import { saveBookingTypeAction } from "@/actions/booking-types";

function form(checked: { isActive?: boolean; requiresConsent?: boolean }): FormData {
  const fd = new FormData();
  fd.set("slug", "intro-call");
  fd.set("name", "Intro call");
  // Mirrors booking-types-manager.tsx: a ticked box submits value="true".
  if (checked.isActive) fd.set("isActive", "true");
  if (checked.requiresConsent) fd.set("requiresConsent", "true");
  return fd;
}

function savedInput(): Record<string, unknown> {
  expect(fx.saveBookingType).toHaveBeenCalledTimes(1);
  return fx.saveBookingType.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => fx.saveBookingType.mockClear());

describe("saveBookingTypeAction checkboxes", () => {
  it("unticked isActive and requiresConsent are saved as false", async () => {
    expect(await saveBookingTypeAction("bt-1", {}, form({}))).toEqual({ message: "saved" });
    expect(savedInput()).toMatchObject({ isActive: false, requiresConsent: false });
  });

  it("each box is read on its own: only the unticked one becomes false", async () => {
    await saveBookingTypeAction("bt-1", {}, form({ isActive: false, requiresConsent: true }));
    expect(savedInput()).toMatchObject({ isActive: false, requiresConsent: true });
  });
});
