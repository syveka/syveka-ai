import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";

/**
 * Pausing a booking type (Active unticked) while its owner is still a current
 * member. booking-owner-removal.test.ts covers the removed-owner case; here
 * membership is intact, so only the `isActive` filters can refuse:
 * - the pause itself goes through the real action, guard, permission map and
 *   saveBookingType (the session, write limit, audit, next/cache and the
 *   database are faked), and a role without booking:manage changes nothing;
 * - the public page, availability, booking and moving a booking into the type
 *   are refused with the same not-found as an unknown link;
 * - an existing booking of the paused type can still be canceled.
 *
 * A stateful in-memory fake, as in booking-owner-removal.test.ts. Its
 * bookingType.findFirst filters on `isActive` only when the query asks for
 * it, and its booking_types lock filters only while the SQL says `is_active`,
 * so these tests fail if the service stops asking for active types.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const MANAGER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  seq: 0,
  ctx: null as Record<string, unknown> | null,
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
  types: [] as Array<Record<string, unknown>>,
  bookings: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  // A type id to pause while the owner's busy times are read (after the
  // public lookup passed, before the booking transaction).
  pauseDuringSlots: null as string | null,
}));
const nextId = (p: string) => `${p}-${++s.seq}`;

const fx = vi.hoisted(() => ({
  audit: vi.fn(async (..._args: unknown[]) => {
    void _args;
  }),
  writeLimit: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return null;
  }),
}));

const { AuthError } = vi.hoisted(() => ({
  AuthError: class AuthError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403 = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  },
}));

const typeRow = (id: string) => s.types.find((t) => t.id === id)!;
const bookingRow = (id: string) => s.bookings.find((b) => b.id === id)!;

const tx = {
  $executeRaw: vi.fn(async () => 0),
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FROM organization_members")) {
      const [orgId, userId] = values as string[];
      const m = s.members.find((x) => x.organizationId === orgId && x.userId === userId);
      return m ? [{ role: m.role }] : [];
    }
    if (sql.includes("FROM booking_types")) {
      const [id, orgId, ownerId] = values as string[];
      const activeOnly = /\bis_active\b/.test(sql);
      const t = s.types.find(
        (x) =>
          x.id === id &&
          x.organizationId === orgId &&
          x.ownerId === ownerId &&
          !x.deletedAt &&
          (!activeOnly || x.isActive),
      );
      return t ? [{ id: t.id }] : [];
    }
    throw new Error(`unexpected raw query: ${sql}`);
  }),
  calendarEvent: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: nextId("evt"), ...data };
      s.events.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        s.events.find((e) => e.id === where.id)!,
        data,
      ),
    ),
  },
  contact: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Row }) => ({ id: nextId("contact"), ...data })),
  },
  eventAttendee: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
  booking: {
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
      const b = bookingRow(where.id as string);
      return { ...b, bookingType: { ...typeRow(b.bookingTypeId as string) } };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const excluded = (where.status as { notIn: string[] }).notIn;
      const b = s.bookings.find((x) => x.id === where.id && !excluded.includes(String(x.status)));
      if (b) Object.assign(b, data);
      return { count: b ? 1 : 0 };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: nextId("bk"), status: "CONFIRMED", ...data };
      s.bookings.push(row);
      return row;
    }),
  },
  reminder: { updateMany: vi.fn(async () => ({ count: 0 })) },
  activity: { create: vi.fn(async () => ({})) },
};

const db = {
  bookingType: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const org = where.organization as { slug: string } | undefined;
      const t = s.types.find((x) => {
        if (where.id !== undefined && x.id !== where.id) return false;
        if (where.slug !== undefined && x.slug !== where.slug) return false;
        // Only when the query asks for active types.
        if (where.isActive === true && !x.isActive) return false;
        if (where.deletedAt === null && x.deletedAt) return false;
        if (org && org.slug !== "org-a") return false;
        return true;
      });
      if (!t) return null;
      return {
        ...t,
        schedule: null,
        organization: { id: ORG_A, name: "Synthetic", slug: "org-a", logoUrl: null },
      };
    }),
  },
  organizationMember: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const m = s.members.find(
        (x) => x.organizationId === where.organizationId && x.userId === where.userId,
      );
      return m ? { id: m.id } : null;
    }),
  },
  availabilitySchedule: { findFirst: vi.fn(async () => null) },
  calendarEvent: {
    // The owner's busy times: none. Optionally pauses a type mid-request.
    findMany: vi.fn(async () => {
      if (s.pauseDuringSlots) {
        typeRow(s.pauseDuringSlots).isActive = false;
        s.pauseDuringSlots = null;
      }
      return [];
    }),
  },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};

const tenantTypeUpdate = vi.fn(async (orgId: string, args: { where: Row; data: Row }) =>
  Object.assign(
    s.types.find((t) => t.id === args.where.id && t.organizationId === orgId)!,
    args.data,
  ),
);

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: (orgId: string) => ({
    bookingType: {
      findFirst: async ({ where }: { where: Row }) =>
        s.types.find((t) => t.id === where.id && t.organizationId === orgId && !t.deletedAt) ??
        null,
      update: (args: { where: Row; data: Row }) => tenantTypeUpdate(orgId, args),
    },
    availabilitySchedule: { findFirst: async () => null },
  }),
}));
vi.mock("@/server/auth/session", () => ({
  AuthError,
  getTenantContext: vi.fn(async () => {
    if (!s.ctx) throw new AuthError("Not signed in", 401);
    return s.ctx;
  }),
}));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
// The write limit is covered by rate-limit-write-actions.test.ts; here it always allows.
vi.mock("@/server/security/rate-limit", () => ({ actionWriteLimitError: fx.writeLimit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/booking-tokens", () => ({
  issueToken: vi.fn(async () => "synthetic-manage-token"),
  invalidateBookingTokens: vi.fn(async () => undefined),
  resolveToken: vi.fn(),
  consumeTokenAtomic: vi.fn(async () => undefined),
}));

import { saveBookingTypeAction } from "@/actions/booking-types";
import {
  cancelBookingViaToken,
  createPublicBooking,
  getPublicBookingType,
  getPublicSlots,
  rescheduleBookingViaToken,
} from "@/server/services/booking";
import { consumeTokenAtomic, resolveToken } from "@/server/services/booking-tokens";

// Monday 2026-02-02 09:00 Helsinki = 07:00Z; "now" is the day before.
const START = "2026-02-02T07:00:00.000Z";
const NOT_FOUND = { name: "BookingError", code: "not_found" };

function type(id: string, slug: string) {
  return {
    id,
    organizationId: ORG_A,
    ownerId: OWNER,
    slug,
    name: `Type ${slug}`,
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
    deletedAt: null as Date | null,
  };
}

const guest = (o: Partial<PublicBookingInput> = {}) =>
  ({
    startsAt: START,
    timezone: "Europe/Helsinki",
    name: "Synthetic Guest",
    email: "guest@example.test",
    consent: true,
    ...o,
  }) as PublicBookingInput;
const book = (typeSlug: string) =>
  createPublicBooking({ orgSlug: "org-a", typeSlug, input: guest() });
const slotsFor = (typeSlug: string) =>
  getPublicSlots({
    orgSlug: "org-a",
    typeSlug,
    from: new Date("2026-02-02T00:00:00Z"),
    to: new Date("2026-02-03T00:00:00Z"),
  });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

/** The guest's link to the existing booking of the paused type. */
function linkToExistingBooking() {
  vi.mocked(resolveToken).mockResolvedValue({
    id: "token-1",
    purpose: "MANAGE",
    booking: { ...bookingRow("bk-existing") },
  } as never);
}

const pause = () => {
  typeRow("bt-paused").isActive = false;
};
const ownerIsMember = () => s.members.some((m) => m.userId === OWNER);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-01T10:00:00Z"));
  s.seq = 0;
  s.ctx = null;
  s.pauseDuringSlots = null;
  s.members = [
    { id: "m-manager", organizationId: ORG_A, userId: MANAGER, role: "MANAGER" },
    { id: "m-owner", organizationId: ORG_A, userId: OWNER, role: "MEMBER" },
  ];
  s.types = [type("bt-paused", "paused-call"), type("bt-live", "live-call")];
  s.events = [{ id: "evt-existing", organizationId: ORG_A, status: "CONFIRMED" }];
  s.bookings = [
    {
      id: "bk-existing",
      organizationId: ORG_A,
      bookingTypeId: "bt-paused",
      eventId: "evt-existing",
      status: "CONFIRMED",
      guestName: "Synthetic Guest",
      guestEmail: "guest@example.test",
      guestPhone: null,
      guestCompany: null,
      guestNotes: null,
      guestTimezone: "Europe/Helsinki",
      guestLocale: "EN",
      consentAt: new Date("2026-01-01T00:00:00Z"),
      startsAt: new Date("2026-02-03T07:00:00Z"),
      endsAt: new Date("2026-02-03T08:00:00Z"),
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pausing through saveBookingTypeAction", () => {
  // Mirrors booking-types-manager.tsx with the Active box unticked (submits nothing).
  function pausedForm(): FormData {
    const fd = new FormData();
    fd.set("slug", "paused-call");
    fd.set("name", "Type paused-call");
    fd.set("durationMinutes", "60");
    fd.set("requiresConsent", "true");
    return fd;
  }

  const ctxFor = (role: string, userId = MANAGER) => ({
    orgId: ORG_A,
    userId,
    email: "synthetic.user@example.test",
    role,
    locale: "en",
  });

  it("a role with booking:manage saves isActive false; the owner stays a member and the page goes away", async () => {
    s.ctx = ctxFor("MANAGER");

    expect(await saveBookingTypeAction("bt-paused", {}, pausedForm())).toEqual({
      message: "saved",
    });

    expect(tenantTypeUpdate).toHaveBeenCalledTimes(1);
    expect(tenantTypeUpdate).toHaveBeenCalledWith(ORG_A, {
      where: { id: "bt-paused" },
      data: expect.objectContaining({ isActive: false }),
    });
    expect(typeRow("bt-paused").isActive).toBe(false);
    expect(ownerIsMember()).toBe(true);
    expect(await getPublicBookingType("org-a", "paused-call")).toBeNull();
  });

  it.each(["MEMBER", "VIEWER"])(
    "a %s (no booking:manage) is refused with 403 before anything is saved or counted",
    async (role) => {
      s.ctx = ctxFor(role, OWNER);

      const error = await failure(saveBookingTypeAction("bt-paused", {}, pausedForm()));

      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({ status: 403 });
      expect(tenantTypeUpdate).not.toHaveBeenCalled();
      expect(fx.writeLimit).not.toHaveBeenCalled();
      expect(typeRow("bt-paused").isActive).toBe(true);
      // The real guard records the denial.
      expect(fx.audit).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_A, userId: OWNER }),
        expect.objectContaining({ action: "authz.denied", resourceId: "booking:manage" }),
      );
    },
  );
});

describe("a paused type whose owner is still a current member", () => {
  beforeEach(() => {
    pause();
    expect(ownerIsMember()).toBe(true);
  });

  it("control: the same owner's active type still has a page, slots and takes bookings", async () => {
    expect(await getPublicBookingType("org-a", "live-call")).toMatchObject({ id: "bt-live" });
    expect((await slotsFor("live-call")).slots.length).toBeGreaterThan(0);
    expect((await book("live-call")).booking).toMatchObject({ bookingTypeId: "bt-live" });
  });

  it("the public page lookup returns null on the active filter, without reaching the membership check", async () => {
    expect(await getPublicBookingType("org-a", "paused-call")).toBeNull();
    expect(db.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it("availability is the generic not-found", async () => {
    await expect(slotsFor("paused-call")).rejects.toMatchObject(NOT_FOUND);
  });

  it("a new booking is the generic not-found, refused before any transaction", async () => {
    await expect(book("paused-call")).rejects.toMatchObject(NOT_FOUND);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(s.bookings).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it("moving an existing booking into it is refused before the token is claimed", async () => {
    linkToExistingBooking();

    await expect(rescheduleBookingViaToken("synthetic-token", START)).rejects.toMatchObject(
      NOT_FOUND,
    );
    expect(consumeTokenAtomic).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(s.bookings).toHaveLength(1);
    expect(bookingRow("bk-existing").status).toBe("CONFIRMED");
  });

  it("an existing booking can still be canceled (intended), without any bookability check", async () => {
    linkToExistingBooking();

    const canceled = await cancelBookingViaToken("synthetic-token", "synthetic reason");

    expect(canceled.id).toBe("bk-existing");
    expect(bookingRow("bk-existing").status).toBe("CANCELED");
    expect(s.events.find((e) => e.id === "evt-existing")).toMatchObject({ status: "CANCELED" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(typeRow("bt-paused").isActive).toBe(false);
  });
});

describe("a pause that lands after the slots were computed (mocked sequencing)", () => {
  it("a new booking is refused inside the transaction, before any write", async () => {
    s.pauseDuringSlots = "bt-paused";

    await expect(book("paused-call")).rejects.toMatchObject(NOT_FOUND);
    expect(typeRow("bt-paused").isActive).toBe(false); // the pause did land mid-request
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.calendarEvent.create).not.toHaveBeenCalled();
    expect(tx.booking.create).not.toHaveBeenCalled();
    expect(s.bookings).toHaveLength(1);
  });

  it("moving a booking into it is refused inside the transaction, before the old booking is touched", async () => {
    linkToExistingBooking();
    s.pauseDuringSlots = "bt-paused";

    await expect(rescheduleBookingViaToken("synthetic-token", START)).rejects.toMatchObject(
      NOT_FOUND,
    );
    expect(typeRow("bt-paused").isActive).toBe(false);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.calendarEvent.create).not.toHaveBeenCalled();
    expect(tx.booking.create).not.toHaveBeenCalled();
    expect(bookingRow("bk-existing").status).toBe("CONFIRMED");
  });
});
