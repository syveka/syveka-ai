import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Staging QA (2026-10-07): a public booking's contact showed the booking in
 * its Timeline but "No meetings" in Meetings. Public bookings link the guest's
 * contact only through an EventAttendee row, while getEntityEvents matched
 * CalendarEvent.contactId alone. The contact filter now matches either link;
 * company/deal filters and the upcoming/past/canceled rules are unchanged.
 * (Real-Postgres proof: entity-events-contact-attendees.postgres.test.ts.)
 */

const { findMany, tenantDbMock } = vi.hoisted(() => {
  const findMany = vi.fn(async () => []);
  return { findMany, tenantDbMock: vi.fn(() => ({ calendarEvent: { findMany } })) };
});

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock, unscopedPrisma: {} }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));

const { getEntityEvents } = await import("@/server/services/calendar");

const ctx = { orgId: "org-a", userId: "user-1", role: "OWNER" } as TenantContext;

beforeEach(() => vi.clearAllMocks());

type Where = Record<string, unknown>;
const calls = () => findMany.mock.calls.map((c) => (c as unknown as [{ where: Where }])[0]);

describe("getEntityEvents", () => {
  it("a contact's meetings match a direct link OR an attendee link, in the caller's org", async () => {
    await getEntityEvents(ctx, { contactId: "contact-1" });

    expect(tenantDbMock).toHaveBeenCalledWith("org-a");
    const [upcoming, past] = calls();
    for (const q of [upcoming!, past!]) {
      expect(q.where).toMatchObject({
        deletedAt: null,
        OR: [{ contactId: "contact-1" }, { attendeeRecords: { some: { contactId: "contact-1" } } }],
      });
      expect(q.where).not.toHaveProperty("contactId");
    }
    // Upcoming excludes canceled meetings; past keeps them (unchanged).
    expect(upcoming!.where).toMatchObject({ status: { not: "CANCELED" } });
    expect(upcoming!.where.startsAt).toHaveProperty("gte");
    expect(past!.where).not.toHaveProperty("status");
    expect(past!.where.startsAt).toHaveProperty("lt");
  });

  it.each([
    [{ companyId: "company-1" }, { companyId: "company-1" }],
    [{ dealId: "deal-1" }, { dealId: "deal-1" }],
  ])("company/deal filters are unchanged: %o", async (entity, expected) => {
    await getEntityEvents(ctx, entity);
    for (const q of calls()) {
      expect(q.where).toMatchObject({ deletedAt: null, ...expected });
      expect(q.where).not.toHaveProperty("OR");
    }
  });
});
