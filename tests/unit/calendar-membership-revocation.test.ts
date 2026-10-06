import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Removing a member ends their calendar's access to the organization (#73
 * residual R1): no new imports, no restored credentials, and in-flight OAuth,
 * token refresh and sync work that started before the removal persists
 * nothing after it.
 *
 * A stateful in-memory fake of the tables involved, with a mocked provider.
 * Concurrency here is **mocked sequencing**: a provider call is held open
 * while the removal runs, then released. That proves the authorization is
 * re-evaluated at persist time, after the network call. It does not prove
 * Postgres blocking semantics; the real-database race (FOR SHARE vs the
 * removal's DELETE) is in tests/integration/calendar-membership-race-concurrency.sh.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  seq: 0,
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
  deletedOrgs: new Set<string>(),
  connections: [] as Array<Record<string, unknown>>,
  calendars: [] as Array<Record<string, unknown>>,
  syncStates: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  attendees: [] as Array<Record<string, unknown>>,
  /** A pending provider call, released by the test. */
  gates: {} as Record<string, Promise<void> | undefined>,
}));

const id = (prefix: string) => `${prefix}-${++s.seq}`;
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date) && "in" in (v as Row)) {
      return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
    }
    if (v && typeof v === "object" && !(v instanceof Date) && "not" in (v as Row)) {
      return row[k] !== (v as { not: unknown }).not;
    }
    if (v && typeof v === "object" && !(v instanceof Date)) return true; // relation filters
    return row[k] === v;
  });

const db = {
  organizationMember: {
    count: vi.fn(
      async ({ where }: { where: Row }) =>
        s.members.filter((m) => m.organizationId === where.organizationId).length,
    ),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const m = s.members.find(
        (x) => x.organizationId === where.organizationId && x.userId === where.userId,
      );
      if (!m || s.deletedOrgs.has(m.organizationId)) return null;
      return { id: m.id, role: m.role };
    }),
    delete: vi.fn(async ({ where }: { where: Row }) => {
      const i = s.members.findIndex(
        (m) => m.id === where.id && m.organizationId === where.organizationId,
      );
      if (i < 0) throw new Error("P2025");
      return s.members.splice(i, 1)[0];
    }),
  },
  // Removal also disables the member's booking types (booking-owner-removal.test.ts).
  bookingType: { updateMany: vi.fn(async () => ({ count: 0 })) },
  calendarConnection: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      return s.connections.find((c) => matches(c, where)) ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      s.connections.filter((c) => matches(c, where)),
    ),
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const key = where.organizationId_userId_provider as Row;
      const existing = s.connections.find(
        (c) =>
          c.organizationId === key.organizationId &&
          c.userId === key.userId &&
          c.provider === key.provider,
      );
      if (existing) {
        for (const [k, v] of Object.entries(update)) if (v !== undefined) existing[k] = v;
        return existing;
      }
      const row = { id: id("conn"), ...create };
      s.connections.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = s.connections.find((c) => c.id === where.id);
      if (!row) throw new Error("P2025");
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = s.connections.filter((c) => matches(c, where));
      for (const r of rows)
        for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
      return { count: rows.length };
    }),
  },
  externalCalendar: {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const cal = s.calendars.find((c) => c.id === where.id);
      if (!cal || s.deletedOrgs.has(cal.organizationId as string)) return null;
      return {
        ...cal,
        connection: s.connections.find((c) => c.id === cal.connectionId),
        syncState: s.syncStates.find((x) => x.externalCalendarId === cal.id) ?? null,
      };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const key = where.connectionId_externalId as Row;
      const existing = s.calendars.find(
        (c) => c.connectionId === key.connectionId && c.externalId === key.externalId,
      );
      if (existing) return Object.assign(existing, update);
      const row = { id: id("cal"), syncEnabled: false, ...create };
      s.calendars.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = s.calendars.filter((c) => matches(c, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    }),
  },
  calendarSyncState: {
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const existing = s.syncStates.find((x) => x.externalCalendarId === where.externalCalendarId);
      if (existing) return Object.assign(existing, update);
      const row = { ...create };
      s.syncStates.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = s.syncStates.find((x) => x.externalCalendarId === where.externalCalendarId);
      if (!row) throw new Error("P2025");
      return Object.assign(row, data);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = s.syncStates.filter((x) => x.externalCalendarId === where.externalCalendarId);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    }),
    deleteMany: vi.fn(
      async ({ where }: { where: { externalCalendar: { connectionId: { in: string[] } } } }) => {
        const calIds = s.calendars
          .filter((c) => where.externalCalendar.connectionId.in.includes(c.connectionId as string))
          .map((c) => c.id);
        const before = s.syncStates.length;
        s.syncStates = s.syncStates.filter((x) => !calIds.includes(x.externalCalendarId));
        return { count: before - s.syncStates.length };
      },
    ),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      return (
        s.syncStates.find((x) => x.webhookSubscriptionId === where.webhookSubscriptionId) ?? null
      );
    }),
  },
  calendarEvent: {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const key = where.externalCalendarId_externalId as Row;
      return (
        s.events.find(
          (e) => e.externalCalendarId === key.externalCalendarId && e.externalId === key.externalId,
        ) ?? null
      );
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: id("evt"), deletedAt: null, ...data };
      s.events.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        s.events.find((e) => e.id === where.id)!,
        data,
      ),
    ),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  eventAttendee: {
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      s.attendees.push(...data);
      return { count: data.length };
    }),
  },
  // The lock helpers' SQL (src/server/calendar/locks.ts), evaluated on the fake.
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FROM organization_members")) {
      const [orgId, userId] = values as string[];
      const m = s.members.find((x) => x.organizationId === orgId && x.userId === userId);
      return m && !s.deletedOrgs.has(orgId!) ? [{ role: m.role }] : [];
    }
    if (sql.includes("FROM calendar_connections")) {
      const [connectionId, orgId, userId] = values as string[];
      const c = s.connections.find(
        (x) =>
          x.id === connectionId &&
          x.organizationId === orgId &&
          x.userId === userId &&
          x.status !== "DISCONNECTED" &&
          x.accessTokenEnc,
      );
      return c ? [{ id: c.id }] : [];
    }
    throw new Error(`unexpected raw query: ${sql}`);
  }),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
};

// Provider: deterministic tokens and events; each call can be held open.
const provider = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  refreshTokens: vi.fn(),
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  subscribeWebhook: vi.fn(),
  unsubscribeWebhook: vi.fn(),
  revoke: vi.fn(),
  isConfigured: () => true,
  getAuthUrl: () => "https://provider.test/auth",
}));

vi.mock("@/server/db/tenant", () => ({
  // Read at call time: vi.mock is hoisted above the fake's definition.
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
      // Used by the pre-fix removeMember (membership row only).
      delete: async ({ where }: { where: Row }) => {
        const i = s.members.findIndex((x) => x.id === where.id && x.organizationId === orgId);
        if (i < 0) throw new Error("P2025");
        return s.members.splice(i, 1)[0];
      },
    },
  }),
}));
vi.mock("@/server/integrations/calendar", () => ({ getProviderAdapter: () => provider }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseAdmin: vi.fn() }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  // Seats are not what these tests exercise: room for everyone.
  getEntitlements: vi.fn(async () => ({ maxSeats: Number.MAX_SAFE_INTEGER, readOnly: false })),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));

import { removeMember } from "@/server/services/members";
import { decryptToken } from "@/server/integrations/calendar/crypto";
import {
  buildOAuthState,
  completeConnection,
  getFreshTokens,
  markConnectionStatus,
} from "@/server/services/calendar-connections";
import {
  ensureWebhookSubscription,
  handleProviderWebhook,
  syncExternalCalendar,
} from "@/server/services/calendar-sync";

const remote = (externalId: string) => ({
  externalId,
  etag: `etag-${externalId}`,
  title: `Synthetic ${externalId}`,
  startsAt: new Date("2026-11-02T09:00:00Z"),
  endsAt: new Date("2026-11-02T10:00:00Z"),
  allDay: false,
  status: "confirmed" as const,
  attendees: [{ email: "guest@example.test", name: "Synthetic Guest" }],
});

/** Holds the next call of `fn` open until the returned release() is called. */
function hold(fn: ReturnType<typeof vi.fn>, result: () => unknown) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  fn.mockImplementationOnce(async () => {
    started();
    await gate;
    return result();
  });
  return { release, started: startedP };
}

const ctxA = { orgId: ORG_A, userId: ADMIN, role: "ADMIN" } as never;
const memberCtxA = { orgId: ORG_A, userId: MEMBER, role: "ADMIN" } as never;
const memberCtxB = { orgId: ORG_B, userId: MEMBER, role: "ADMIN" } as never;

async function connect(ctx: never) {
  const state = buildOAuthState(ctx, "GOOGLE");
  return completeConnection({ provider: "GOOGLE", code: "synthetic-code", state });
}
const memberIdIn = (orgId: string) =>
  s.members.find((m) => m.organizationId === orgId && m.userId === MEMBER)!.id;
const calendarOf = (connectionId: string) =>
  s.calendars.find((c) => c.connectionId === connectionId)!;
const eventsIn = (orgId: string) => s.events.filter((e) => e.organizationId === orgId);

beforeEach(() => {
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.CALENDAR_OAUTH_STATE_SECRET = "synthetic-state-secret-for-tests";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  s.seq = 0;
  s.members = [
    { id: "m-admin-a", organizationId: ORG_A, userId: ADMIN, role: "OWNER" },
    { id: "m-member-a", organizationId: ORG_A, userId: MEMBER, role: "ADMIN" },
    { id: "m-member-b", organizationId: ORG_B, userId: MEMBER, role: "ADMIN" },
  ];
  s.deletedOrgs = new Set();
  s.connections = [];
  s.calendars = [];
  s.syncStates = [];
  s.events = [];
  s.attendees = [];
  provider.exchangeCode.mockReset().mockImplementation(async () => ({
    accessToken: `access-${++s.seq}`,
    refreshToken: `refresh-${s.seq}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ["calendar"],
    accountEmail: "member@example.test",
  }));
  provider.refreshTokens.mockReset().mockImplementation(async () => ({
    accessToken: `refreshed-access-${++s.seq}`,
    refreshToken: `refreshed-refresh-${s.seq}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ["calendar"],
  }));
  provider.listCalendars
    .mockReset()
    .mockResolvedValue([
      { externalId: "primary", name: "Primary", isPrimary: true, timezone: "Europe/Helsinki" },
    ]);
  provider.listEvents.mockReset().mockImplementation(async () => ({
    events: [remote("e1"), remote("e2")],
    deletedExternalIds: [],
    nextCursor: "cursor-1",
    hasMore: false,
  }));
  provider.subscribeWebhook.mockReset().mockResolvedValue({
    subscriptionId: `sub-${++s.seq}`,
    resourceId: "res",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  provider.revoke.mockReset();
  provider.unsubscribeWebhook.mockReset();
});

async function connectAndEnable(ctx: never) {
  const { connectionId } = await connect(ctx);
  const cal = calendarOf(connectionId);
  cal.syncEnabled = true;
  return { connectionId, calendarId: cal.id as string };
}

describe("current members (unchanged behavior)", () => {
  it("connect, then sync: tokens stored, events imported once, cursor saved", async () => {
    const { connectionId, calendarId } = await connectAndEnable(memberCtxA);
    const conn = s.connections.find((c) => c.id === connectionId)!;
    expect(conn).toMatchObject({ status: "CONNECTED", userId: MEMBER, organizationId: ORG_A });
    expect(conn.accessTokenEnc).toBeTruthy();

    const first = await syncExternalCalendar(calendarId);
    expect(first).toMatchObject({ imported: 2 });
    expect(first.accessRevoked).toBeUndefined();
    expect(eventsIn(ORG_A)).toHaveLength(2);
    expect(s.syncStates[0]).toMatchObject({ syncCursor: "cursor-1", lastSyncStatus: "ok" });

    // Replaying the same page stays idempotent.
    expect(await syncExternalCalendar(calendarId)).toMatchObject({ imported: 0 });
    expect(eventsIn(ORG_A)).toHaveLength(2);
  });

  it("an expired token is refreshed and stored", async () => {
    const { connectionId } = await connect(memberCtxA);
    const conn = s.connections.find((c) => c.id === connectionId)!;
    conn.tokenExpiresAt = new Date(Date.now() - 1000);
    const tokens = await getFreshTokens(connectionId, ORG_A);
    expect(tokens.accessToken).toMatch(/^refreshed-access-/);
    expect(conn.status).toBe("CONNECTED");
  });
});

describe("removal invalidates the member's calendar access in that organization", () => {
  it("connections lose local credentials, sync is off, webhook state is gone; no provider revoke", async () => {
    const { connectionId, calendarId } = await connectAndEnable(memberCtxA);
    await ensureWebhookSubscription(calendarId);
    expect(s.syncStates).toHaveLength(1);

    await removeMember(ctxA, memberIdIn(ORG_A));

    expect(s.connections.find((c) => c.id === connectionId)).toMatchObject({
      status: "DISCONNECTED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      lastError: "membership_removed",
    });
    expect(calendarOf(connectionId).syncEnabled).toBe(false);
    expect(s.syncStates).toHaveLength(0);
    // Local credentials only: the provider grant is the user's own.
    expect(provider.revoke).not.toHaveBeenCalled();
    expect(provider.unsubscribeWebhook).not.toHaveBeenCalled();
  });

  it("a removed member can't sync, refresh, or reconnect with a still-valid OAuth state", async () => {
    const { connectionId, calendarId } = await connectAndEnable(memberCtxA);
    const state = buildOAuthState(memberCtxA, "GOOGLE"); // issued before removal
    await removeMember(ctxA, memberIdIn(ORG_A));

    expect(await syncExternalCalendar(calendarId)).toMatchObject({ imported: 0 });
    await expect(getFreshTokens(connectionId, ORG_A)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      completeConnection({ provider: "GOOGLE", code: "synthetic-code", state }),
    ).rejects.toMatchObject({ code: "membership_revoked" });
    expect(s.connections.find((c) => c.id === connectionId)).toMatchObject({
      status: "DISCONNECTED",
      accessTokenEnc: null,
    });
    expect(eventsIn(ORG_A)).toHaveLength(0);
  });

  it("status writes never bring an invalidated connection back", async () => {
    const { connectionId } = await connect(memberCtxA);
    await removeMember(ctxA, memberIdIn(ORG_A));
    for (const status of ["CONNECTED", "NEEDS_REAUTH", "ERROR"] as const) {
      await markConnectionStatus(connectionId, status, "stale");
    }
    expect(s.connections.find((c) => c.id === connectionId)!.status).toBe("DISCONNECTED");
  });
});

describe("in-flight work started before the removal persists nothing after it", () => {
  it("removal while the OAuth token exchange is in progress: nothing is stored", async () => {
    const pending = hold(provider.exchangeCode, () => ({
      accessToken: "late-access",
      refreshToken: "late-refresh",
      scopes: ["calendar"],
    }));
    const completing = connect(memberCtxA);
    await pending.started;
    await removeMember(ctxA, memberIdIn(ORG_A));
    pending.release();

    await expect(completing).rejects.toMatchObject({ code: "membership_revoked" });
    expect(s.connections.filter((c) => c.organizationId === ORG_A)).toHaveLength(0);
    expect(s.calendars).toHaveLength(0);
  });

  it("removal after a sync fetch starts, before its results are persisted: no events, no cursor", async () => {
    const { calendarId } = await connectAndEnable(memberCtxA);
    const pending = hold(provider.listEvents, () => ({
      events: [remote("late-1"), remote("late-2")],
      deletedExternalIds: [],
      nextCursor: "late-cursor",
      hasMore: false,
    }));
    const syncing = syncExternalCalendar(calendarId);
    await pending.started;
    await removeMember(ctxA, memberIdIn(ORG_A));
    pending.release();

    expect(await syncing).toMatchObject({ imported: 0, accessRevoked: true });
    expect(eventsIn(ORG_A)).toHaveLength(0);
    expect(s.attendees).toHaveLength(0);
    expect(s.syncStates).toHaveLength(0); // no cursor or error state recreated
  });

  it("a stale token refresh can't restore credentials or status", async () => {
    const { connectionId } = await connect(memberCtxA);
    s.connections.find((c) => c.id === connectionId)!.tokenExpiresAt = new Date(Date.now() - 1);
    const pending = hold(provider.refreshTokens, () => ({
      accessToken: "stale-refreshed-access",
      refreshToken: "stale-refreshed-refresh",
      scopes: ["calendar"],
    }));
    const refreshing = getFreshTokens(connectionId, ORG_A);
    await pending.started;
    await removeMember(ctxA, memberIdIn(ORG_A));
    pending.release();

    await expect(refreshing).rejects.toMatchObject({ code: "membership_revoked" });
    expect(s.connections.find((c) => c.id === connectionId)).toMatchObject({
      status: "DISCONNECTED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
    });
  });

  it("a stale refresh can't overwrite the tokens of a later re-connection (compare-and-swap)", async () => {
    const { connectionId } = await connect(memberCtxA);
    s.connections.find((c) => c.id === connectionId)!.tokenExpiresAt = new Date(Date.now() - 1);
    const pending = hold(provider.refreshTokens, () => ({
      accessToken: "stale-refreshed-access",
      scopes: ["calendar"],
    }));
    const refreshing = getFreshTokens(connectionId, ORG_A);
    await pending.started;
    // Removed, re-added and re-connected while the old refresh was in flight.
    await removeMember(ctxA, memberIdIn(ORG_A));
    s.members.push({ id: "m-member-a2", organizationId: ORG_A, userId: MEMBER, role: "ADMIN" });
    await connect(memberCtxA);
    const reconnectedAccess = s.connections.find((c) => c.id === connectionId)!.accessTokenEnc;
    pending.release();

    // The re-connection's tokens are kept, and returned instead of the stale ones.
    const tokens = await refreshing;
    expect(tokens.accessToken).toBe(decryptToken(reconnectedAccess as string));
    expect(s.connections.find((c) => c.id === connectionId)!.accessTokenEnc).toBe(
      reconnectedAccess,
    );
  });

  it("two concurrent refreshes for a current member (rotating refresh token): both succeed, one write", async () => {
    const { connectionId } = await connect(memberCtxA);
    s.connections.find((c) => c.id === connectionId)!.tokenExpiresAt = new Date(Date.now() - 1);
    const first = hold(provider.refreshTokens, () => ({
      accessToken: "first-access",
      refreshToken: "first-rotated-refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["calendar"],
    }));
    const second = hold(provider.refreshTokens, () => ({
      accessToken: "second-access",
      refreshToken: "second-rotated-refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["calendar"],
    }));
    const a = getFreshTokens(connectionId, ORG_A);
    const b = getFreshTokens(connectionId, ORG_A);
    await Promise.all([first.started, second.started]);
    first.release();
    expect((await a).accessToken).toBe("first-access");
    second.release();
    // The second swap misses (the refresh token rotated); it gets the stored tokens.
    expect((await b).accessToken).toBe("first-access");
    expect(s.connections.find((c) => c.id === connectionId)).toMatchObject({ status: "CONNECTED" });
  });
});

describe("queued jobs and retries after removal", () => {
  it("a webhook ping, a subscription renewal and a retried sync do nothing", async () => {
    const { calendarId } = await connectAndEnable(memberCtxA);
    await ensureWebhookSubscription(calendarId);
    const subscriptionId = s.syncStates[0]!.webhookSubscriptionId as string;
    provider.subscribeWebhook.mockClear();
    provider.listEvents.mockClear();

    await removeMember(ctxA, memberIdIn(ORG_A));

    expect(
      await handleProviderWebhook({ provider: "GOOGLE", subscriptionId, presentedSecret: "x" }),
    ).toBe(false);
    expect(await ensureWebhookSubscription(calendarId)).toBe("skipped");
    for (let i = 0; i < 2; i++) {
      expect(await syncExternalCalendar(calendarId)).toMatchObject({ imported: 0 });
    }
    expect(provider.subscribeWebhook).not.toHaveBeenCalled();
    expect(provider.listEvents).not.toHaveBeenCalled();
    expect(eventsIn(ORG_A)).toHaveLength(0);
  });

  it("a member removed before this fix (connection still CONNECTED, sync on): no fetch, no import, no subscription", async () => {
    const { connectionId, calendarId } = await connectAndEnable(memberCtxA);
    // The old removeMember deleted only the membership row.
    s.members = s.members.filter((m) => m.id !== memberIdIn(ORG_A));
    provider.listEvents.mockClear();

    expect(await syncExternalCalendar(calendarId)).toMatchObject({
      imported: 0,
      accessRevoked: true,
    });
    expect(await ensureWebhookSubscription(calendarId)).toBe("skipped");
    expect(provider.listEvents).not.toHaveBeenCalled();
    expect(provider.subscribeWebhook).not.toHaveBeenCalled();
    expect(eventsIn(ORG_A)).toHaveLength(0);
    // Not cleaned up retroactively: no live-data change beyond refusing access.
    expect(s.connections.find((c) => c.id === connectionId)!.status).toBe("CONNECTED");
  });
});

describe("isolation", () => {
  it("removal from org A leaves the same user's org B connection connected and syncing", async () => {
    const a = await connectAndEnable(memberCtxA);
    const b = await connectAndEnable(memberCtxB);

    await removeMember(ctxA, memberIdIn(ORG_A));

    expect(s.connections.find((c) => c.id === a.connectionId)!.status).toBe("DISCONNECTED");
    expect(s.connections.find((c) => c.id === b.connectionId)).toMatchObject({
      status: "CONNECTED",
      organizationId: ORG_B,
    });
    expect(calendarOf(b.connectionId).syncEnabled).toBe(true);
    expect(await syncExternalCalendar(b.calendarId)).toMatchObject({ imported: 2 });
    expect(eventsIn(ORG_B)).toHaveLength(2);
    expect(eventsIn(ORG_A)).toHaveLength(0);
  });

  it("other members' connections in the same org are untouched", async () => {
    const admin = await connectAndEnable(ctxA);
    await connectAndEnable(memberCtxA);
    await removeMember(ctxA, memberIdIn(ORG_A));
    expect(s.connections.find((c) => c.id === admin.connectionId)!.status).toBe("CONNECTED");
    expect(await syncExternalCalendar(admin.calendarId)).toMatchObject({ imported: 2 });
  });
});

describe("inactive (soft-deleted) organizations", () => {
  it("no imports, no refresh, no new connection", async () => {
    const { connectionId, calendarId } = await connectAndEnable(memberCtxA);
    const state = buildOAuthState(memberCtxA, "GOOGLE");
    s.deletedOrgs.add(ORG_A);
    provider.listEvents.mockClear();

    expect(await syncExternalCalendar(calendarId)).toMatchObject({ imported: 0 });
    await expect(getFreshTokens(connectionId, ORG_A)).rejects.toMatchObject({
      code: "membership_revoked",
    });
    await expect(
      completeConnection({ provider: "GOOGLE", code: "synthetic-code", state }),
    ).rejects.toMatchObject({ code: "membership_revoked" });
    expect(provider.listEvents).not.toHaveBeenCalled();
    expect(eventsIn(ORG_A)).toHaveLength(0);
  });

  it("organization deleted after a sync fetch starts: the fetched page isn't stored", async () => {
    const { calendarId } = await connectAndEnable(memberCtxA);
    const pending = hold(provider.listEvents, () => ({
      events: [remote("late")],
      deletedExternalIds: [],
      nextCursor: "c",
      hasMore: false,
    }));
    const syncing = syncExternalCalendar(calendarId);
    await pending.started;
    s.deletedOrgs.add(ORG_A);
    pending.release();
    expect(await syncing).toMatchObject({ imported: 0, accessRevoked: true });
    expect(eventsIn(ORG_A)).toHaveLength(0);
  });
});
