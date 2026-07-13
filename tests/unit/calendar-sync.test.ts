import { beforeEach, describe, expect, it, vi } from "vitest";

const { unscopedMock, getFreshTokensMock } = vi.hoisted(() => ({
  unscopedMock: {
    externalCalendar: { findUnique: vi.fn() },
    calendarEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    eventAttendee: { createMany: vi.fn() },
    calendarSyncState: { upsert: vi.fn(), update: vi.fn() },
  },
  getFreshTokensMock: vi.fn(async () => ({
    accessToken: "mock-access-token",
    scopes: ["mock:calendar"],
  })),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: vi.fn(),
}));
vi.mock("@/server/services/calendar-connections", () => ({
  getFreshTokens: getFreshTokensMock,
  markConnectionStatus: vi.fn(async () => undefined),
}));

import { syncExternalCalendar } from "@/server/services/calendar-sync";
import { mockProviderTestApi } from "@/server/integrations/calendar/mock";
import type { ExternalEvent } from "@/server/integrations/calendar/types";

function externalCalendar(overrides: Record<string, unknown> = {}) {
  return {
    id: "extcal-1",
    connectionId: "conn-1",
    organizationId: "org-a",
    externalId: "mock-primary",
    name: "Mock Primary",
    syncEnabled: true,
    connection: { id: "conn-1", provider: "MOCK", userId: "owner-1" },
    syncState: null,
    ...overrides,
  };
}

function remoteEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    externalId: "remote-1",
    etag: "etag-v1",
    title: "External meeting",
    startsAt: new Date("2026-02-03T09:00:00Z"),
    endsAt: new Date("2026-02-03T10:00:00Z"),
    allDay: false,
    status: "confirmed",
    attendees: [{ email: "someone@example.com", name: "Someone" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderTestApi.reset();
  unscopedMock.externalCalendar.findUnique.mockResolvedValue(externalCalendar());
  unscopedMock.calendarEvent.findUnique.mockResolvedValue(null);
  unscopedMock.calendarEvent.create.mockResolvedValue({ id: "evt-imported" });
  unscopedMock.calendarSyncState.upsert.mockResolvedValue({});
  unscopedMock.calendarSyncState.update.mockResolvedValue({});
});

describe("idempotent import sync", () => {
  it("imports new remote events keyed by (externalCalendarId, externalId)", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    const result = await syncExternalCalendar("extcal-1");
    expect(result.imported).toBe(1);
    expect(unscopedMock.calendarEvent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          externalCalendarId_externalId: {
            externalCalendarId: "extcal-1",
            externalId: "remote-1",
          },
        },
      }),
    );
    expect(unscopedMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          ownerId: "owner-1",
          externalId: "remote-1",
        }),
      }),
    );
    expect(unscopedMock.eventAttendee.createMany).toHaveBeenCalled();
  });

  it("replaying the same page is a no-op (same etag → skipped)", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    unscopedMock.calendarEvent.findUnique.mockResolvedValue({
      id: "evt-existing",
      externalEtag: "etag-v1",
      updatedAt: new Date(),
      deletedAt: null,
    });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(0);
    expect(unscopedMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(unscopedMock.calendarEvent.update).not.toHaveBeenCalled();
  });

  it("applies remote updates when the etag changed", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent({ etag: "etag-v2" })]);
    unscopedMock.calendarEvent.findUnique.mockResolvedValue({
      id: "evt-existing",
      externalEtag: "etag-v1",
      updatedAt: new Date(),
      deletedAt: null,
    });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.updated).toBe(1);
    expect(unscopedMock.calendarEvent.update).toHaveBeenCalled();
  });

  it("conflict detection: locally deleted events keep their tombstone", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent({ etag: "etag-v3" })]);
    unscopedMock.calendarEvent.findUnique.mockResolvedValue({
      id: "evt-existing",
      externalEtag: "etag-v1",
      updatedAt: new Date(),
      deletedAt: new Date(), // user deleted it locally
    });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.skippedConflicts).toBe(1);
    expect(unscopedMock.calendarEvent.update).not.toHaveBeenCalled();
  });

  it("remote deletions cancel local copies", async () => {
    mockProviderTestApi.markDeleted("mock-primary", ["remote-gone"]);
    unscopedMock.calendarEvent.updateMany.mockResolvedValue({ count: 1 });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.deleted).toBe(1);
    expect(unscopedMock.calendarEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ externalId: { in: ["remote-gone"] } }),
      }),
    );
  });

  it("persists the cursor after each applied page", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    await syncExternalCalendar("extcal-1");
    expect(unscopedMock.calendarSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalCalendarId: "extcal-1" } }),
    );
  });

  it("expired cursors trigger a transparent full resync", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncState: { syncCursor: "mock-expired" } }),
    );
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    const result = await syncExternalCalendar("extcal-1");
    expect(result.cursorReset).toBe(true);
    expect(result.imported).toBe(1); // resynced from scratch
  });

  it("does nothing when sync is disabled", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncEnabled: false }),
    );
    const result = await syncExternalCalendar("extcal-1");
    expect(result.imported).toBe(0);
    expect(getFreshTokensMock).not.toHaveBeenCalled();
  });
});
