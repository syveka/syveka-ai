import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";

/**
 * Public booking links of removed members: a removed member's booking types
 * stop taking new bookings (page, availability and every booking-creating
 * path), existing bookings and events are untouched, and nothing turns the
 * types back on when the owner rejoins.
 *
 * A stateful in-memory fake with no providers. Concurrency here is **mocked
 * sequencing** (a read before the transaction is held open while the removal
 * runs); the Postgres locking itself is verified in
 * tests/integration/booking-owner-removal-race-concurrency.sh.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  seq: 0,
  orgs: [] as Array<{ id: string; slug: string; deletedAt: Date | null }>,
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
  types: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  bookings: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  hold: null as null | { started: () => void; gate: Promise<void> },
}));
const nextId = (p: string) => `${p}-${++s.seq}`;
const orgDeleted = (id: string) => s.orgs.find((o) => o.id === id)?.deletedAt != null;

const tx = {
  $executeRaw: vi.fn(async () => 0),
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FROM organization_members")) {
      const [orgId, userId] = values as string[];
      const m = s.members.find((x) => x.organizationId === orgId && x.userId === userId);
      return m && !orgDeleted(orgId!) ? [{ role: m.role }] : [];
    }
    if (sql.includes("FROM booking_types")) {
      const [id, orgId, ownerId] = values as string[];
      const t = s.types.find(
        (x) =>
          x.id === id &&
          x.organizationId === orgId &&
          x.ownerId === ownerId &&
          x.isActive &&
          !x.deletedAt,
      );
      return t ? [{ id: t.id }] : [];
    }
    throw new Error(`unexpected raw query: ${sql}`);
  }),
  organizationMember: {
    delete: vi.fn(async ({ where }: { where: Row }) => {
      const i = s.members.findIndex(
        (m) => m.id === where.id && m.organizationId === where.organizationId,
      );
      if (i < 0) throw new Error("P2025");
      return s.members.splice(i, 1)[0];
    }),
  },
  bookingType: {
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = s.types.filter(
        (t) =>
          t.organizationId === where.organizationId &&
          t.ownerId === where.ownerId &&
          t.isActive === where.isActive &&
          !t.deletedAt,
      );
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    }),
  },
  calendarConnection: { findMany: vi.fn(async () => []) },
  calendarEvent: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: nextId("evt"), ...data };
      s.events.push(row);
      return row;
    }),
  },
  contact: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: nextId("contact"), ...data };
      s.contacts.push(row);
      return row;
    }),
  },
  eventAttendee: { create: vi.fn(async () => ({})) },
  booking: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: nextId("bk"), status: "CONFIRMED", ...data };
      s.bookings.push(row);
      return row;
    }),
  },
  activity: { create: vi.fn(async () => ({})) },
};

const invitations: Array<Record<string, unknown>> = [];
/**
 * Like a PrismaPromise: the query runs only when awaited, so a batch
 * $transaction([...]) can snapshot state first and roll back on failure.
 */
function lazyFn<A, T>(impl: (args: A) => T) {
  return vi.fn((args: A) => {
    let p: Promise<T> | undefined;
    return {
      then: <R1, R2>(ok?: (v: T) => R1, err?: (e: unknown) => R2) =>
        (p ??= Promise.resolve().then(() => impl(args))).then(ok, err),
    };
  });
}
const db = {
  invitation: {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      return invitations.find((i) => i.token === where.token) ?? null;
    }),
    update: lazyFn(({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        invitations.find((i) => i.id === where.id)!,
        data,
      ),
    ),
  },
  user: {
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => ({
      id: where.id,
      email: `${where.id as string}@example.test`,
    })),
  },
  bookingType: {
    updateMany: lazyFn(({ where, data }: { where: Row; data: Row }) => {
      const rows = s.types.filter(
        (t) =>
          t.organizationId === where.organizationId &&
          t.ownerId === where.ownerId &&
          t.isActive === where.isActive &&
          !t.deletedAt,
      );
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const org = where.organization as { slug: string; deletedAt: null } | undefined;
      const t = s.types.find((x) => {
        if (where.id !== undefined && x.id !== where.id) return false;
        if (where.slug !== undefined && x.slug !== where.slug) return false;
        if (where.isActive === true && !x.isActive) return false;
        if (x.deletedAt) return false;
        if (org) {
          const o = s.orgs.find((y) => y.id === x.organizationId)!;
          if (o.slug !== org.slug || o.deletedAt) return false;
        }
        return true;
      });
      if (!t) return null;
      const o = s.orgs.find((y) => y.id === t.organizationId)!;
      return { ...t, schedule: null, organization: { id: o.id, name: "Synthetic", slug: o.slug } };
    }),
  },
  organizationMember: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const m = s.members.find(
        (x) => x.organizationId === where.organizationId && x.userId === where.userId,
      );
      return m && !orgDeleted(m.organizationId) ? { id: m.id } : null;
    }),
    create: lazyFn(({ data }: { data: Row }) => {
      if (
        s.members.some((m) => m.organizationId === data.organizationId && m.userId === data.userId)
      ) {
        throw new Error("P2002");
      }
      const row = { id: nextId("m"), role: "MEMBER", ...data } as (typeof s.members)[number];
      s.members.push(row);
      return row;
    }),
  },
  availabilitySchedule: { findFirst: vi.fn(async () => null) },
  calendarEvent: {
    // Owner busy times; optionally held open to sequence a concurrent removal.
    findMany: vi.fn(async () => {
      const h = s.hold;
      if (h) {
        s.hold = null;
        h.started();
        await h.gate;
      }
      return [];
    }),
  },
  // Interactive (callback) and batch (array) forms. A failed batch rolls back,
  // as a real transaction does.
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (t: typeof tx) => unknown)(tx);
    const types = s.types.map((t) => ({ ...t }));
    const members = s.members.map((m) => ({ ...m }));
    const results = await Promise.allSettled(arg as unknown[]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      s.types.forEach((t, i) => Object.assign(t, types[i]));
      s.members = members;
      throw (failed as PromiseRejectedResult).reason;
    }
    return results.map((r) => (r as PromiseFulfilledResult<unknown>).value);
  }),
};

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: (orgId: string) => ({
    organizationMember: {
      findFirstOrThrow: async ({ where }: { where: Row }) => {
        const m = s.members.find((x) => x.id === where.id && x.organizationId === orgId);
        if (!m) throw new Error("P2025");
        return m;
      },
    },
    bookingType: {
      findFirst: async ({ where }: { where: Row }) =>
        s.types.find((t) => t.id === where.id && t.organizationId === orgId && !t.deletedAt) ??
        null,
      update: async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(
          s.types.find((t) => t.id === where.id && t.organizationId === orgId)!,
          data,
        ),
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("bt"), deletedAt: null, ...data };
        s.types.push(row);
        return row;
      },
    },
    availabilitySchedule: { findFirst: async () => null },
  }),
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: vi.fn(async () => {}) }));
vi.mock("@/server/services/booking-tokens", () => ({
  issueToken: vi.fn(async () => "synthetic-manage-token"),
  invalidateBookingTokens: vi.fn(async () => undefined),
  resolveToken: vi.fn(),
  consumeTokenAtomic: vi.fn(async () => undefined),
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: vi.fn(async () => ({})) } } }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));

import {
  BookingError,
  createPublicBooking,
  getPublicBookingType,
  getPublicSlots,
  rescheduleBookingViaToken,
  saveBookingType,
} from "@/server/services/booking";
import { acceptInvitation, removeMember } from "@/server/services/members";
import { resolveToken } from "@/server/services/booking-tokens";

// Monday 2026-02-02 09:00 Helsinki = 07:00Z; "now" is the day before.
const START = "2026-02-02T07:00:00.000Z";
const guest = (o: Partial<PublicBookingInput> = {}) =>
  ({
    startsAt: START,
    timezone: "Europe/Helsinki",
    name: "Synthetic Guest",
    email: "guest@example.test",
    consent: true,
    ...o,
  }) as PublicBookingInput;

function type(id: string, organizationId: string, ownerId: string, slug: string) {
  return {
    id,
    organizationId,
    ownerId,
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

const adminCtx = { orgId: ORG_A, userId: ADMIN, role: "ADMIN" } as never;
const book = (orgSlug: string, typeSlug: string) =>
  createPublicBooking({ orgSlug, typeSlug, input: guest() });
const slotsFor = (orgSlug: string, typeSlug: string) =>
  getPublicSlots({
    orgSlug,
    typeSlug,
    from: new Date("2026-02-02T00:00:00Z"),
    to: new Date("2026-02-03T00:00:00Z"),
  });
const NOT_FOUND = { name: "BookingError", code: "not_found" };
const typeInput = (slug: string, isActive: boolean) =>
  ({
    slug,
    name: `Type ${slug}`,
    durationMinutes: 60,
    durationOptions: [60],
    locationType: "VIDEO",
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxWindowDays: 60,
    collectPhone: false,
    collectCompany: false,
    requiresConsent: true,
    isActive,
  }) as never;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-01T10:00:00Z"));
  s.seq = 0;
  s.hold = null;
  s.orgs = [
    { id: ORG_A, slug: "org-a", deletedAt: null },
    { id: ORG_B, slug: "org-b", deletedAt: null },
  ];
  s.members = [
    { id: "m-admin", organizationId: ORG_A, userId: ADMIN, role: "OWNER" },
    { id: "m-owner-a", organizationId: ORG_A, userId: OWNER, role: "MEMBER" },
    { id: "m-other-a", organizationId: ORG_A, userId: OTHER, role: "MEMBER" },
    { id: "m-owner-b", organizationId: ORG_B, userId: OWNER, role: "MEMBER" },
  ];
  s.types = [
    type("bt-owner-a", ORG_A, OWNER, "owner-call"),
    type("bt-other-a", ORG_A, OTHER, "other-call"),
    type("bt-owner-b", ORG_B, OWNER, "owner-call"),
  ];
  // Existing data that removal must not touch.
  s.events = [{ id: "evt-imported", organizationId: ORG_A, ownerId: OWNER, source: "GOOGLE" }];
  s.bookings = [
    {
      id: "bk-existing",
      organizationId: ORG_A,
      bookingTypeId: "bt-owner-a",
      status: "CONFIRMED",
      startsAt: new Date("2026-02-03T07:00:00Z"),
    },
  ];
  s.contacts = [];
  invitations.length = 0;
});

/** Rejoining through the only rejoin path: a fresh invitation, accepted. */
async function rejoin(orgId: string, userId: string) {
  invitations.push({
    id: nextId("inv"),
    token: `token-${s.seq}`,
    organizationId: orgId,
    email: `${userId}@example.test`,
    role: "MEMBER",
    status: "PENDING",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
  return acceptInvitation(invitations.at(-1)!.token as string, userId);
}
afterEach(() => {
  vi.useRealTimers();
});

describe("a current member's active booking type works normally", () => {
  it("page, availability and booking", async () => {
    expect(await getPublicBookingType("org-a", "owner-call")).toMatchObject({ id: "bt-owner-a" });
    expect((await slotsFor("org-a", "owner-call")).slots.length).toBeGreaterThan(0);
    const result = await book("org-a", "owner-call");
    expect(result.booking).toMatchObject({ bookingTypeId: "bt-owner-a", organizationId: ORG_A });
  });
});

describe("removal stops the removed member's public booking links", () => {
  it("removal disables their types in that org; page, availability and booking are unavailable", async () => {
    await removeMember(adminCtx, "m-owner-a");
    expect(s.types.find((t) => t.id === "bt-owner-a")!.isActive).toBe(false);

    expect(await getPublicBookingType("org-a", "owner-call")).toBeNull();
    await expect(slotsFor("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);
    await expect(book("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);
    expect(s.bookings.filter((b) => b.bookingTypeId === "bt-owner-a")).toHaveLength(1); // pre-existing only
  });

  it("the response is the same generic not-found as an unknown link", async () => {
    await removeMember(adminCtx, "m-owner-a");
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as BookingError,
      );
    const removed = await failure(book("org-a", "owner-call"));
    const unknown = await failure(book("org-a", "no-such-link"));
    expect(removed).toBeInstanceOf(BookingError);
    expect([removed?.code, removed?.message]).toEqual([unknown?.code, unknown?.message]);
  });

  it("a member removed before this change (type still active): every path is blocked, no backfill needed", async () => {
    // The old removeMember deleted only the membership row.
    s.members = s.members.filter((m) => m.id !== "m-owner-a");
    expect(s.types.find((t) => t.id === "bt-owner-a")!.isActive).toBe(true);

    expect(await getPublicBookingType("org-a", "owner-call")).toBeNull();
    await expect(slotsFor("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);
    await expect(book("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);
    // Nothing was rewritten.
    expect(s.types.find((t) => t.id === "bt-owner-a")!.isActive).toBe(true);
  });

  it("moving an existing booking to a new time is refused (it would create a new booking)", async () => {
    vi.mocked(resolveToken).mockResolvedValue({
      id: "token-1",
      booking: {
        id: "bk-existing",
        organizationId: ORG_A,
        bookingTypeId: "bt-owner-a",
        status: "CONFIRMED",
        startsAt: new Date("2026-02-03T07:00:00Z"),
        endsAt: new Date("2026-02-03T08:00:00Z"),
        eventId: null,
      },
    } as never);
    await removeMember(adminCtx, "m-owner-a");
    await expect(rescheduleBookingViaToken("synthetic-token", START)).rejects.toMatchObject(
      NOT_FOUND,
    );
    expect(s.bookings).toHaveLength(1);
  });
});

describe("concurrent removal and booking creation (mocked sequencing)", () => {
  it("a booking request that passed every pre-check before the removal commits nothing after it", async () => {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const gate = new Promise<void>((r) => (release = r));
    // Hold the request inside its slot computation, after the eligibility
    // lookup passed, until the removal has committed.
    s.hold = { started, gate };
    const booking = book("org-a", "owner-call");
    await startedP;
    await removeMember(adminCtx, "m-owner-a");
    release();

    await expect(booking).rejects.toMatchObject(NOT_FOUND);
    expect(s.bookings.filter((b) => b.bookingTypeId === "bt-owner-a")).toHaveLength(1);
    expect(s.events.filter((e) => e.source === "BOOKING")).toHaveLength(0);
    expect(s.contacts).toHaveLength(0);
  });

  it("the transaction locks the owner's membership before the booking type, before any write", async () => {
    const order: string[] = [];
    tx.$queryRaw.mockImplementationOnce(async (strings: TemplateStringsArray) => {
      order.push(strings.join("?").includes("organization_members") ? "member" : "?");
      return [{ role: "MEMBER" }];
    });
    tx.$queryRaw.mockImplementationOnce(async (strings: TemplateStringsArray) => {
      order.push(strings.join("?").includes("booking_types") ? "booking_type" : "?");
      return [{ id: "bt-owner-a" }];
    });
    tx.calendarEvent.create.mockImplementationOnce(async ({ data }: { data: Row }) => {
      order.push("write");
      const row = { id: nextId("evt"), ...data };
      s.events.push(row);
      return row;
    });
    await book("org-a", "owner-call");
    expect(order).toEqual(["member", "booking_type", "write"]);
  });
});

describe("legacy removal (before removal-time deactivation), then rejoin", () => {
  it("the stored-active booking type does not become bookable again when the owner rejoins", async () => {
    // Exactly the legacy state: the old removeMember deleted only the
    // membership row; the type is still stored as ACTIVE.
    s.members = s.members.filter((m) => m.id !== "m-owner-a");
    const legacy = s.types.find((t) => t.id === "bt-owner-a")!;
    expect(legacy.isActive).toBe(true);
    await expect(book("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND); // blocked while absent

    await rejoin(ORG_A, OWNER);

    expect(s.members.some((m) => m.organizationId === ORG_A && m.userId === OWNER)).toBe(true);
    expect(legacy.isActive).toBe(false);
    expect(await getPublicBookingType("org-a", "owner-call")).toBeNull();
    await expect(slotsFor("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);
    await expect(book("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);
    expect(s.bookings).toHaveLength(1); // the pre-existing booking only, unchanged
  });

  it("after the rejoin, an admin can explicitly reactivate it", async () => {
    s.members = s.members.filter((m) => m.id !== "m-owner-a");
    await rejoin(ORG_A, OWNER);
    await saveBookingType(adminCtx, typeInput("owner-call", true), "bt-owner-a");
    expect((await book("org-a", "owner-call")).booking.bookingTypeId).toBe("bt-owner-a");
  });

  it("joining affects only the joining user's types in that organization", async () => {
    s.members = s.members.filter((m) => m.id !== "m-owner-a");
    await rejoin(ORG_A, OWNER);
    expect(s.types.find((t) => t.id === "bt-other-a")!.isActive).toBe(true);
    expect(s.types.find((t) => t.id === "bt-owner-b")!.isActive).toBe(true);
    expect((await book("org-b", "owner-call")).booking.bookingTypeId).toBe("bt-owner-b");
  });

  it("a brand-new member (no earlier types) joins normally; accepting again for an existing member fails as before", async () => {
    const NEW_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await rejoin(ORG_A, NEW_USER);
    expect(s.members.some((m) => m.userId === NEW_USER)).toBe(true);
    expect(s.types.every((t) => t.ownerId !== NEW_USER)).toBe(true);
    // An existing member can't accept a second invitation (unique membership).
    await expect(rejoin(ORG_A, OTHER)).rejects.toThrow();
    expect(s.types.find((t) => t.id === "bt-other-a")!.isActive).toBe(true);
  });
});

describe("rejoining doesn't reactivate", () => {
  it("re-added owner: links stay unavailable; an admin can turn them back on explicitly", async () => {
    await removeMember(adminCtx, "m-owner-a");
    // Before rejoining, an admin can't reactivate it either.
    await expect(
      saveBookingType(adminCtx, typeInput("owner-call", true), "bt-owner-a"),
    ).rejects.toMatchObject({ code: "owner_not_member" });

    s.members.push({ id: "m-owner-a2", organizationId: ORG_A, userId: OWNER, role: "MEMBER" });
    expect(s.types.find((t) => t.id === "bt-owner-a")!.isActive).toBe(false);
    await expect(book("org-a", "owner-call")).rejects.toMatchObject(NOT_FOUND);

    await saveBookingType(adminCtx, typeInput("owner-call", true), "bt-owner-a");
    expect((await book("org-a", "owner-call")).booking.bookingTypeId).toBe("bt-owner-a");
  });

  it("saving an inactive type for a removed owner is allowed (no reactivation)", async () => {
    await removeMember(adminCtx, "m-owner-a");
    await saveBookingType(adminCtx, typeInput("owner-call", false), "bt-owner-a");
    expect(s.types.find((t) => t.id === "bt-owner-a")!.isActive).toBe(false);
  });
});

describe("isolation and existing data", () => {
  it("other members' types in the org, and the same user's types in another org, keep working", async () => {
    await removeMember(adminCtx, "m-owner-a");
    expect(s.types.find((t) => t.id === "bt-other-a")!.isActive).toBe(true);
    expect(s.types.find((t) => t.id === "bt-owner-b")!.isActive).toBe(true);
    expect((await book("org-a", "other-call")).booking.bookingTypeId).toBe("bt-other-a");
    expect((await book("org-b", "owner-call")).booking.bookingTypeId).toBe("bt-owner-b");
  });

  it("existing bookings and imported events are unchanged by the removal", async () => {
    const before = JSON.stringify({ bookings: s.bookings, events: s.events });
    await removeMember(adminCtx, "m-owner-a");
    expect(JSON.stringify({ bookings: s.bookings, events: s.events })).toBe(before);
  });
});

describe("soft-deleted organizations", () => {
  it("can't take bookings, including a request already past its pre-checks", async () => {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const gate = new Promise<void>((r) => (release = r));
    s.hold = { started, gate };
    const inFlight = book("org-a", "other-call");
    await startedP;
    s.orgs.find((o) => o.id === ORG_A)!.deletedAt = new Date();
    release();
    await expect(inFlight).rejects.toMatchObject(NOT_FOUND);

    expect(await getPublicBookingType("org-a", "other-call")).toBeNull();
    await expect(book("org-a", "other-call")).rejects.toMatchObject(NOT_FOUND);
    expect(s.events.filter((e) => e.source === "BOOKING")).toHaveLength(0);
  });
});
