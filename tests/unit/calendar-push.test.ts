import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * pushBookingEventToGoogle / cancelBookingEventOnGoogle (P2: unified booking
 * lifecycle - outbound Google Calendar push). Covers the contract that
 * matters most for this feature: FAILED vs AMBIGUOUS classification, no
 * auto-retry, idempotent re-invocation, and graceful no-op when there is no
 * connected Google calendar.
 */

const { unscopedMock, getFreshTokensMock, adapterMock } = vi.hoisted(() => ({
  unscopedMock: {
    calendarEvent: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    calendarConnection: { findFirst: vi.fn() },
    externalCalendar: { findFirst: vi.fn(), findUnique: vi.fn() },
  },
  getFreshTokensMock: vi.fn(async () => ({
    accessToken: "mock-access-token",
    scopes: ["mock:calendar"],
  })),
  adapterMock: {
    createEvent: vi.fn(),
    cancelEvent: vi.fn(),
  },
}));

vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: unscopedMock, tenantDb: vi.fn() }));
vi.mock("@/server/services/calendar-connections", () => ({
  getFreshTokens: getFreshTokensMock,
  markConnectionStatus: vi.fn(async () => undefined),
}));
vi.mock("@/server/integrations/calendar", () => ({
  getProviderAdapter: vi.fn(() => adapterMock),
}));

import {
  pushBookingEventToGoogle,
  cancelBookingEventOnGoogle,
} from "@/server/services/calendar-sync";
import { ProviderError } from "@/server/integrations/calendar/types";

function calendarEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    organizationId: "org-a",
    title: "Haircut",
    description: null,
    location: null,
    startsAt: new Date("2026-08-17T10:00:00Z"),
    endsAt: new Date("2026-08-17T10:30:00Z"),
    timezone: "Europe/Helsinki",
    googleSyncStatus: "NOT_APPLICABLE",
    deletedAt: null,
    externalCalendarId: null,
    externalId: null,
    ownerId: null,
    createdById: "owner-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unscopedMock.calendarConnection.findFirst.mockResolvedValue({ id: "conn-1" });
  unscopedMock.externalCalendar.findFirst.mockResolvedValue({
    id: "extcal-1",
    externalId: "google-primary",
  });
  getFreshTokensMock.mockResolvedValue({ accessToken: "token", scopes: [] });
  // The atomic-claim guard (D2/D3 hardening): succeeds by default so
  // existing scenarios reach adapter.createEvent/cancelEvent unchanged;
  // individual tests override this to (count: 0) to prove the claim-loses
  // path never calls the adapter a second time.
  unscopedMock.calendarEvent.updateMany.mockResolvedValue({ count: 1 });
});

describe("pushBookingEventToGoogle", () => {
  it("is a no-op ('not_applicable') for an event that doesn't exist or belongs to another org", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(null);
    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });
    expect(outcome).toBe("not_applicable");
    expect(unscopedMock.calendarEvent.update).not.toHaveBeenCalled();
  });

  it("is idempotent: an already-SYNCED event is never re-pushed", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(
      calendarEvent({ googleSyncStatus: "SYNCED" }),
    );
    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });
    expect(outcome).toBe("synced");
    expect(adapterMock.createEvent).not.toHaveBeenCalled();
  });

  it("skips gracefully ('not_applicable') when the owner has no connected Google calendar - never fails the booking", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    unscopedMock.calendarConnection.findFirst.mockResolvedValue(null);
    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });
    expect(outcome).toBe("not_applicable");
    expect(adapterMock.createEvent).not.toHaveBeenCalled();
    expect(unscopedMock.calendarEvent.update).not.toHaveBeenCalled();
  });

  it("skips gracefully when the connection exists but has no primary calendar", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    unscopedMock.externalCalendar.findFirst.mockResolvedValue(null);
    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });
    expect(outcome).toBe("not_applicable");
  });

  it("on success: marks SYNCED and stores externalCalendarId/externalId - the SAME columns the inbound sync's upsert key uses, so a later import matches and updates instead of duplicating", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    adapterMock.createEvent.mockResolvedValue({ externalId: "google-evt-1", etag: "etag-1" });

    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });

    expect(outcome).toBe("synced");
    expect(adapterMock.createEvent).toHaveBeenCalledWith(
      expect.anything(),
      "google-primary",
      expect.objectContaining({ title: "Haircut", timezone: "Europe/Helsinki" }),
    );
    expect(unscopedMock.calendarEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: {
        externalCalendarId: "extcal-1",
        externalId: "google-evt-1",
        externalEtag: "etag-1",
        googleSyncStatus: "SYNCED",
        googleSyncError: null,
      },
    });
  });

  it("classifies a definitive Google error response as FAILED, not AMBIGUOUS - no ambiguity about whether an event was created", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    adapterMock.createEvent.mockRejectedValue(
      new ProviderError("Google API 500", "remote_error", true),
    );

    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });

    expect(outcome).toBe("failed");
    expect(unscopedMock.calendarEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { googleSyncStatus: "FAILED", googleSyncError: "Google API 500" },
    });
  });

  it("classifies a network-level failure (no response received) as AMBIGUOUS, never FAILED", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    adapterMock.createEvent.mockRejectedValue(new TypeError("fetch failed"));

    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });

    expect(outcome).toBe("ambiguous");
    expect(unscopedMock.calendarEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { googleSyncStatus: "AMBIGUOUS", googleSyncError: "fetch failed" },
    });
  });

  it("never throws on failure - the booking itself must never fail because Google push failed", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    adapterMock.createEvent.mockRejectedValue(new Error("anything"));
    await expect(
      pushBookingEventToGoogle({ orgId: "org-a", ownerId: "owner-1", eventId: "evt-1" }),
    ).resolves.toBeDefined();
  });

  it("a credentials failure (no request ever sent to Google) is classified FAILED, not AMBIGUOUS", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    getFreshTokensMock.mockRejectedValue(new Error("No refresh token"));

    const outcome = await pushBookingEventToGoogle({
      orgId: "org-a",
      ownerId: "owner-1",
      eventId: "evt-1",
    });

    expect(outcome).toBe("failed");
    expect(adapterMock.createEvent).not.toHaveBeenCalled();
  });

  describe("PENDING state transition (P2 Fix 2: crash-window observability)", () => {
    it("claims PENDING via the atomic guarded UPDATE BEFORE calling Google - proves ordering, not just that it happened", async () => {
      unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
      const callOrder: string[] = [];
      unscopedMock.calendarEvent.updateMany.mockImplementationOnce(async () => {
        callOrder.push("claim-pending");
        return { count: 1 };
      });
      adapterMock.createEvent.mockImplementationOnce(async () => {
        callOrder.push("call-google");
        return { externalId: "google-evt-1", etag: "etag-1" };
      });

      await pushBookingEventToGoogle({ orgId: "org-a", ownerId: "owner-1", eventId: "evt-1" });

      expect(callOrder).toEqual(["claim-pending", "call-google"]);
      expect(unscopedMock.calendarEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt-1", googleSyncStatus: { notIn: ["PENDING", "SYNCED"] } },
        data: { googleSyncStatus: "PENDING", googleSyncError: null },
      });
    });

    it("D3: when the atomic claim loses (count 0), never calls Google a second time", async () => {
      unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
      unscopedMock.calendarEvent.updateMany.mockResolvedValue({ count: 0 });
      // Simulates the row already having transitioned to PENDING by a
      // concurrent winner, discovered by the post-claim-loss re-read.
      unscopedMock.calendarEvent.findUnique.mockResolvedValueOnce(calendarEvent());
      unscopedMock.calendarEvent.findUnique.mockResolvedValueOnce({
        googleSyncStatus: "PENDING",
      });

      const outcome = await pushBookingEventToGoogle({
        orgId: "org-a",
        ownerId: "owner-1",
        eventId: "evt-1",
      });

      expect(adapterMock.createEvent).not.toHaveBeenCalled();
      expect(outcome).toBe("ambiguous");
    });

    it("D3: when the atomic claim loses because the row is already SYNCED, reports synced without calling Google", async () => {
      unscopedMock.calendarEvent.findUnique.mockResolvedValueOnce(calendarEvent());
      unscopedMock.calendarEvent.updateMany.mockResolvedValue({ count: 0 });
      unscopedMock.calendarEvent.findUnique.mockResolvedValueOnce({ googleSyncStatus: "SYNCED" });

      const outcome = await pushBookingEventToGoogle({
        orgId: "org-a",
        ownerId: "owner-1",
        eventId: "evt-1",
      });

      expect(adapterMock.createEvent).not.toHaveBeenCalled();
      expect(outcome).toBe("synced");
    });
  });
});

describe("cancelBookingEventOnGoogle", () => {
  it("is a no-op when the event was never pushed to Google (no externalId)", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(calendarEvent());
    const outcome = await cancelBookingEventOnGoogle({ eventId: "evt-1" });
    expect(outcome).toBe("not_applicable");
    expect(adapterMock.cancelEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when the last push didn't succeed (status FAILED/AMBIGUOUS) - nothing to cancel on Google", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(
      calendarEvent({
        googleSyncStatus: "AMBIGUOUS",
        externalCalendarId: "extcal-1",
        externalId: "google-evt-1",
      }),
    );
    const outcome = await cancelBookingEventOnGoogle({ eventId: "evt-1" });
    expect(outcome).toBe("not_applicable");
    expect(adapterMock.cancelEvent).not.toHaveBeenCalled();
  });

  it("push-cancels a SYNCED event and resets its sync status", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(
      calendarEvent({
        googleSyncStatus: "SYNCED",
        externalCalendarId: "extcal-1",
        externalId: "google-evt-1",
      }),
    );
    unscopedMock.externalCalendar.findUnique.mockResolvedValue({
      externalId: "google-primary",
      connectionId: "conn-1",
      connection: { userId: "owner-1" },
    });
    adapterMock.cancelEvent.mockResolvedValue(undefined);

    const outcome = await cancelBookingEventOnGoogle({ eventId: "evt-1" });

    expect(outcome).toBe("synced");
    expect(adapterMock.cancelEvent).toHaveBeenCalledWith(
      expect.anything(),
      "google-primary",
      "google-evt-1",
    );
    expect(unscopedMock.calendarEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { googleSyncStatus: "NOT_APPLICABLE", googleSyncError: null },
    });
  });

  it("classifies an ambiguous cancel failure as AMBIGUOUS and never throws (same no-auto-retry contract as create)", async () => {
    unscopedMock.calendarEvent.findUnique.mockResolvedValue(
      calendarEvent({
        googleSyncStatus: "SYNCED",
        externalCalendarId: "extcal-1",
        externalId: "google-evt-1",
      }),
    );
    unscopedMock.externalCalendar.findUnique.mockResolvedValue({
      externalId: "google-primary",
      connectionId: "conn-1",
      connection: { userId: "owner-1" },
    });
    adapterMock.cancelEvent.mockRejectedValue(new TypeError("fetch failed"));

    const outcome = await cancelBookingEventOnGoogle({ eventId: "evt-1" });
    expect(outcome).toBe("ambiguous");
  });

  describe("PENDING state transition (P2 Fix 2/D3)", () => {
    function syncedRow() {
      return calendarEvent({
        googleSyncStatus: "SYNCED",
        externalCalendarId: "extcal-1",
        externalId: "google-evt-1",
      });
    }

    beforeEach(() => {
      unscopedMock.externalCalendar.findUnique.mockResolvedValue({
        externalId: "google-primary",
        connectionId: "conn-1",
        connection: { userId: "owner-1" },
      });
    });

    it("claims PENDING (SYNCED -> PENDING) via the atomic guarded UPDATE BEFORE calling Google", async () => {
      unscopedMock.calendarEvent.findUnique.mockResolvedValue(syncedRow());
      const callOrder: string[] = [];
      unscopedMock.calendarEvent.updateMany.mockImplementationOnce(async () => {
        callOrder.push("claim-pending");
        return { count: 1 };
      });
      adapterMock.cancelEvent.mockImplementationOnce(async () => {
        callOrder.push("call-google");
      });

      await cancelBookingEventOnGoogle({ eventId: "evt-1" });

      expect(callOrder).toEqual(["claim-pending", "call-google"]);
      expect(unscopedMock.calendarEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt-1", googleSyncStatus: "SYNCED" },
        data: { googleSyncStatus: "PENDING", googleSyncError: null },
      });
    });

    it("D3: when the atomic claim loses (a concurrent cancel already claimed it), never calls Google a second time", async () => {
      unscopedMock.calendarEvent.findUnique.mockResolvedValue(syncedRow());
      unscopedMock.calendarEvent.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await cancelBookingEventOnGoogle({ eventId: "evt-1" });

      expect(adapterMock.cancelEvent).not.toHaveBeenCalled();
      expect(outcome).toBe("not_applicable");
    });
  });
});
