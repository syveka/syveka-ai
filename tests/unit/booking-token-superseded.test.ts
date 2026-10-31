import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Manage links that must not change anything: unknown, expired, already used,
 * and superseded (the booking was already moved, or the link is a sibling of
 * the one that moved it). Runs the real booking.ts and booking-tokens.ts
 * against a stateful in-memory Prisma fake that records every write.
 *
 * The fake's $transaction rolls back like a real one: a callback that throws
 * restores the rows it changed, and its writes move from `committed` to
 * `rolledBack`. "No mutation" therefore means nothing committed, and for the
 * token-level failures, no transaction at all.
 *
 * Already covered elsewhere (not repeated here):
 * - resolveToken alone: unknown, garbage, expired, used, purpose mismatch
 *   (booking-tokens.test.ts:98-132); consumeTokenAtomic's count-0 race (:152).
 * - booking-service.test.ts mocks booking-tokens entirely: a concurrently
 *   consumed token (:673, :852), a freshly re-read CANCELED booking (:686,
 *   :862), a forced count-0 guarded update (:724, :882), and an owner cancel
 *   of a RESCHEDULED booking (:1040, cancelBookingAsOwner, not the token path).
 * Not covered before this file: the real token checks through the two token
 * services, the sibling link after a real reschedule, and a still-unused link
 * to a RESCHEDULED booking on the token path.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  seq: 0,
  tokens: [] as Array<Record<string, unknown>>,
  bookings: [] as Array<Record<string, unknown>>,
  committed: [] as string[],
  rolledBack: [] as string[],
}));
const write = (label: string) => s.committed.push(label);

const BOOKING_TYPE = {
  id: "bt-1",
  organizationId: ORG,
  ownerId: OWNER,
  slug: "intro-call",
  name: "Intro call",
  durationMinutes: 60,
  durationOptions: [60],
  locationType: "VIDEO",
  location: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxWindowDays: 60,
  requiresConsent: true,
  confirmationMessage: null,
  isActive: true,
  deletedAt: null,
};
const ORGANIZATION = { id: ORG, name: "Synthetic", slug: "acme", logoUrl: null };

const tx = {
  $executeRaw: vi.fn(async () => 0),
  // Eligibility locks: the owner is a member and the type is bookable.
  // Pausing and owner removal are covered in booking-type-pause.test.ts and
  // booking-owner-removal.test.ts.
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FROM organization_members")) return [{ role: "MEMBER" }];
    if (sql.includes("FROM booking_types")) return [{ id: BOOKING_TYPE.id }];
    throw new Error(`unexpected raw query: ${sql}`);
  }),
  bookingToken: {
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      write("bookingToken.consume");
      const t = s.tokens.find((x) => x.id === where.id && x.usedAt === null);
      if (t) Object.assign(t, data);
      return { count: t ? 1 : 0 };
    }),
  },
  booking: {
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
      const b = s.bookings.find((x) => x.id === where.id);
      if (!b) throw new Error("P2025");
      return { ...b, bookingType: { ...BOOKING_TYPE } };
    }),
    // Honours the status guard, as the database would.
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      write("booking.updateMany");
      const excluded = (where.status as { notIn: string[] }).notIn;
      const open = (x: Row) => !excluded.includes(x.status as string);
      const b = s.bookings.find((x) => x.id === where.id && open(x));
      if (b) Object.assign(b, data);
      return { count: b ? 1 : 0 };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      write("booking.create");
      const row = { id: `bk-${++s.seq}`, status: "CONFIRMED", ...data };
      s.bookings.push(row);
      return row;
    }),
  },
  calendarEvent: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async ({ data }: { data: Row }) => {
      write("calendarEvent.create");
      return { id: `evt-${++s.seq}`, ...data };
    }),
    update: vi.fn(async () => {
      write("calendarEvent.update");
      return {};
    }),
  },
  reminder: {
    updateMany: vi.fn(async () => {
      write("reminder.updateMany");
      return { count: 0 };
    }),
  },
  eventAttendee: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => {
      write("eventAttendee.create");
      return {};
    }),
  },
  activity: {
    create: vi.fn(async () => {
      write("activity.create");
      return {};
    }),
  },
};

const db = {
  bookingToken: {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const t = s.tokens.find((x) => x.tokenHash === where.tokenHash);
      if (!t) return null;
      const b = s.bookings.find((x) => x.id === t.bookingId)!;
      return { ...t, booking: { ...b, bookingType: { ...BOOKING_TYPE }, event: null } };
    }),
    // invalidateBookingTokens
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      write("bookingToken.invalidate");
      const rows = s.tokens.filter((x) => x.bookingId === where.bookingId && x.usedAt === null);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    }),
    // issueToken
    create: vi.fn(async ({ data }: { data: Row }) => {
      write("bookingToken.create");
      const row = { id: `tok-${++s.seq}`, usedAt: null, ...data };
      s.tokens.push(row);
      return row;
    }),
  },
  bookingType: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      if (where.id !== undefined && where.id !== BOOKING_TYPE.id) return null;
      if (where.slug !== undefined && where.slug !== BOOKING_TYPE.slug) return null;
      return { ...BOOKING_TYPE, schedule: null, organization: { ...ORGANIZATION } };
    }),
  },
  organizationMember: { findFirst: vi.fn(async () => ({ id: "m-owner" })) },
  availabilitySchedule: { findFirst: vi.fn(async () => null) },
  calendarEvent: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
    const tokens = s.tokens.map((t) => ({ ...t }));
    const bookings = s.bookings.map((b) => ({ ...b }));
    const mark = s.committed.length;
    try {
      return await fn(tx);
    } catch (e) {
      s.tokens = tokens;
      s.bookings = bookings;
      s.rolledBack.push(...s.committed.splice(mark));
      throw e;
    }
  }),
};

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: vi.fn(),
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: vi.fn(async () => undefined),
}));

import { cancelBookingViaToken, rescheduleBookingViaToken } from "@/server/services/booking";
import { BookingTokenError, hashToken } from "@/server/services/booking-tokens";

// "Now" is Sunday 2026-02-01; the booking is Monday 09:00 Helsinki (07:00Z).
const START = "2026-02-02T07:00:00.000Z";
// Tuesday 2026-02-03, 10:00 Helsinki = 08:00Z (winter).
const NEW_START = "2026-02-03T08:00:00.000Z";

// Synthetic raw links, all within resolveToken's accepted length.
const RAW = {
  live: "synthetic-live-manage-link-0000001",
  sibling: "synthetic-sibling-manage-link-0002",
  unknown: "synthetic-unknown-manage-link-0003",
  expired: "synthetic-expired-manage-link-0004",
  used: "synthetic-used-manage-link-00000005",
};

function storeToken(id: string, raw: string, overrides: Row = {}) {
  s.tokens.push({
    id,
    bookingId: "bk-old",
    tokenHash: hashToken(raw),
    purpose: "MANAGE",
    expiresAt: new Date("2026-03-01T00:00:00Z"),
    usedAt: null,
    ...overrides,
  });
}

const bookingRow = (id: string) => s.bookings.find((b) => b.id === id)!;
const tokenRow = (id: string) => s.tokens.find((t) => t.id === id)!;

const attempts = {
  reschedule: (raw: string) => rescheduleBookingViaToken(raw, NEW_START),
  cancel: (raw: string) => cancelBookingViaToken(raw, "synthetic reason"),
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

// Every Prisma write either token service can reach.
const WRITES = [
  tx.bookingToken.updateMany,
  tx.booking.updateMany,
  tx.booking.create,
  tx.calendarEvent.create,
  tx.calendarEvent.update,
  tx.reminder.updateMany,
  tx.eventAttendee.create,
  tx.activity.create,
  db.bookingToken.updateMany,
  db.bookingToken.create,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-01T10:00:00Z"));
  s.seq = 0;
  s.committed = [];
  s.rolledBack = [];
  s.tokens = [];
  s.bookings = [
    {
      id: "bk-old",
      organizationId: ORG,
      bookingTypeId: BOOKING_TYPE.id,
      eventId: "evt-old",
      status: "CONFIRMED",
      guestName: "Synthetic Guest",
      guestEmail: "guest@example.test",
      guestPhone: null,
      guestCompany: null,
      guestNotes: null,
      guestTimezone: "Europe/Helsinki",
      guestLocale: "EN",
      consentAt: new Date("2026-01-01T00:00:00Z"),
      startsAt: new Date(START),
      endsAt: new Date("2026-02-02T08:00:00.000Z"),
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("unknown, expired and used links are refused before any transaction", () => {
  beforeEach(() => {
    storeToken("tok-expired", RAW.expired, { expiresAt: new Date("2026-01-31T00:00:00Z") });
    storeToken("tok-used", RAW.used, { usedAt: new Date("2026-01-15T00:00:00Z") });
  });

  const cases = (["reschedule", "cancel"] as const).flatMap((action) =>
    (
      [
        ["unknown", RAW.unknown, "invalid"],
        ["expired", RAW.expired, "expired"],
        ["used", RAW.used, "used"],
      ] as const
    ).map(([label, raw, code]) => [action, label, raw, code] as const),
  );

  it.each(cases)(
    "%s with a link that is %s: BookingTokenError %s, no write",
    async (action, _label, raw, code) => {
      void _label;
      const error = await failure(attempts[action](raw));

      expect(error).toBeInstanceOf(BookingTokenError);
      expect(error).toMatchObject({ code });
      expect(db.$transaction).not.toHaveBeenCalled();
      // No slot work either: the link is checked first.
      expect(db.bookingType.findFirst).not.toHaveBeenCalled();
      for (const method of WRITES) expect(method).not.toHaveBeenCalled();
      expect(s.committed).toEqual([]);
      expect(s.rolledBack).toEqual([]);
      expect(s.bookings).toHaveLength(1);
      expect(bookingRow("bk-old").status).toBe("CONFIRMED");
    },
  );
});

describe("superseded links", () => {
  it("after a real reschedule, neither the sibling link nor the one that moved it changes anything", async () => {
    storeToken("tok-live", RAW.live);
    storeToken("tok-sibling", RAW.sibling);

    // Control: the live link moves the booking.
    const moved = await rescheduleBookingViaToken(RAW.live, NEW_START);
    expect(moved.booking).toMatchObject({ rescheduledFromId: "bk-old" });
    expect(bookingRow("bk-old").status).toBe("RESCHEDULED");
    expect(tokenRow("tok-sibling").usedAt).toBeInstanceOf(Date);
    const committedByTheMove = [...s.committed];
    vi.clearAllMocks();

    for (const raw of [RAW.sibling, RAW.live]) {
      for (const action of ["reschedule", "cancel"] as const) {
        const error = await failure(attempts[action](raw));
        expect(error).toBeInstanceOf(BookingTokenError);
        expect(error).toMatchObject({ code: "used" });
      }
    }

    expect(db.$transaction).not.toHaveBeenCalled();
    for (const method of WRITES) expect(method).not.toHaveBeenCalled();
    expect(s.committed).toEqual(committedByTheMove);
    expect(s.rolledBack).toEqual([]);
    expect(s.bookings.map((b) => [b.id, b.status])).toEqual([
      ["bk-old", "RESCHEDULED"],
      [moved.booking.id, "CONFIRMED"],
    ]);
  });

  describe("a still-unused link to a booking that is already RESCHEDULED", () => {
    // E.g. the post-commit invalidateBookingTokens() never ran for this link.
    beforeEach(() => {
      Object.assign(bookingRow("bk-old"), { status: "RESCHEDULED" });
      storeToken("tok-live", RAW.live);
    });

    it("can't cancel it: refused on the re-read status, before the guarded update; all rolled back", async () => {
      const error = await failure(cancelBookingViaToken(RAW.live, "synthetic reason"));

      expect(error).toMatchObject({ name: "BookingError", code: "already_canceled" });
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
      for (const method of [
        tx.calendarEvent.update,
        tx.reminder.updateMany,
        tx.activity.create,
        db.bookingToken.updateMany,
      ]) {
        expect(method).not.toHaveBeenCalled();
      }
      // The only write attempted was the token claim, and it was rolled back.
      expect(s.rolledBack).toEqual(["bookingToken.consume"]);
      expect(s.committed).toEqual([]);
      expect(tokenRow("tok-live").usedAt).toBeNull();
      expect(bookingRow("bk-old").status).toBe("RESCHEDULED");
    });

    it("can't move it again: the guarded claim excludes RESCHEDULED, nothing after it runs; all rolled back", async () => {
      const error = await failure(rescheduleBookingViaToken(RAW.live, NEW_START));

      expect(error).toMatchObject({ name: "BookingError", code: "already_canceled" });
      expect(tx.booking.updateMany).toHaveBeenCalledWith({
        where: { id: "bk-old", status: { notIn: ["CANCELED", "RESCHEDULED"] } },
        data: { status: "RESCHEDULED" },
      });
      for (const method of [
        tx.calendarEvent.update,
        tx.calendarEvent.create,
        tx.reminder.updateMany,
        tx.eventAttendee.create,
        tx.booking.create,
        tx.activity.create,
        db.bookingToken.updateMany,
        db.bookingToken.create,
      ]) {
        expect(method).not.toHaveBeenCalled();
      }
      // The token claim and the guarded update (which matched no row) were
      // attempted inside the transaction; neither survived it.
      expect(s.rolledBack).toEqual(["bookingToken.consume", "booking.updateMany"]);
      expect(s.committed).toEqual([]);
      expect(tokenRow("tok-live").usedAt).toBeNull();
      expect(s.bookings).toHaveLength(1);
      expect(bookingRow("bk-old").status).toBe("RESCHEDULED");
    });
  });
});
