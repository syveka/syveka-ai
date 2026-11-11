import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Joining an organization and its `member.join` audit row are one write: the
 * row is created through the join's transaction client, so a membership can't
 * commit without it, and a failed audit write rolls the whole join back.
 *
 * A stateful in-memory fake with synthetic data only. Each fake transaction
 * keeps an undo list and runs it when its callback throws, as a rollback
 * does; the per-organization seat lock is a real per-organization queue. The
 * audit module is the real one, so a write through the global client (the
 * old, post-commit path) would show up in `globalAudits`.
 */

type Row = Record<string, unknown>;
type Member = { id: string; organizationId: string; userId: string; role: string };

const s = vi.hoisted(() => ({
  orgs: new Map<string, { deletedAt: Date | null }>(),
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
  invitations: [] as Array<Record<string, unknown>>,
  bookingTypes: [] as Array<Record<string, unknown>>,
  // Rows written through a transaction client (and kept only if it committed).
  audits: [] as Array<Record<string, unknown>>,
  // Rows written through the global client, outside any transaction.
  globalAudits: [] as Array<Record<string, unknown>>,
  auditFailure: null as Error | null,
  emails: new Map<string, string>(),
  locks: new Map<string, Promise<void>>(),
  lockCalls: [] as string[],
  seq: 0,
  ent: { maxSeats: 5, readOnly: false },
}));
const updateUserById = vi.hoisted(() => vi.fn(async () => ({})));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const yieldNow = () => new Promise((r) => setTimeout(r, 0));
const membersOf = (orgId: string) =>
  s.orgs.get(orgId)?.deletedAt ? [] : s.members.filter((m) => m.organizationId === orgId);

function makeTx(releases: Array<() => void>, undo: Array<() => void>) {
  return {
    // pg_advisory_xact_lock(hashtext(orgId), 3): held until the transaction ends.
    $executeRaw: vi.fn(async (_sql: TemplateStringsArray, orgId: string) => {
      s.lockCalls.push(orgId);
      const previous = s.locks.get(orgId) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      s.locks.set(
        orgId,
        previous.then(() => mine),
      );
      await previous;
      releases.push(release);
      return 0;
    }),
    organization: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => s.orgs.get(where.id) ?? null,
      ),
    },
    organizationMember: {
      count: vi.fn(async ({ where }: { where: Row }) => {
        const count = membersOf(where.organizationId as string).length;
        await yieldNow();
        return count;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          s.members.find(
            (m) => m.organizationId === where.organizationId && m.userId === where.userId,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        await yieldNow();
        const row = { id: `m-${++s.seq}`, ...data } as Member;
        s.members.push(row);
        undo.push(() => {
          s.members = s.members.filter((m) => m !== row);
        });
        return row;
      }),
    },
    invitation: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const row = s.invitations.find((i) => i.id === where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = s.invitations.find((i) => i.id === where.id)!;
        const previous = { ...row };
        undo.push(() => Object.assign(row, previous));
        return Object.assign(row, data);
      }),
    },
    bookingType: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = s.bookingTypes.filter(
          (t) =>
            t.organizationId === where.organizationId &&
            t.ownerId === where.ownerId &&
            t.isActive === where.isActive &&
            t.deletedAt === null,
        );
        for (const row of rows) {
          const previous = { ...row };
          undo.push(() => Object.assign(row, previous));
          Object.assign(row, data);
        }
        return { count: rows.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (s.auditFailure) throw s.auditFailure;
        s.audits.push(data);
        undo.push(() => {
          s.audits = s.audits.filter((a) => a !== data);
        });
        return data;
      }),
    },
  };
}

const db = {
  invitation: {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const row = s.invitations.find((i) => i.token === where.token);
      return row ? { ...row } : null;
    }),
    update: vi.fn(async () => ({})),
  },
  user: {
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => ({
      id: where.id,
      email: s.emails.get(where.id as string) ?? `${where.id as string}@example.test`,
    })),
  },
  // The global client: nothing about a join may be written here.
  auditLog: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      s.globalAudits.push(data);
      return data;
    }),
  },
  $transaction: vi.fn(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
    const releases: Array<() => void> = [];
    const undo: Array<() => void> = [];
    try {
      return await fn(makeTx(releases, undo));
    } catch (error) {
      // Rollback: nothing this transaction wrote survives.
      for (const revert of undo.reverse()) revert();
      throw error;
    } finally {
      for (const release of releases) release();
    }
  }),
};

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by acceptInvitation");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => {
    const requestHeaders = new Headers();
    requestHeaders.set("x-forwarded-for", "203.0.113.7, 10.0.0.1");
    requestHeaders.set("user-agent", "synthetic-agent");
    return requestHeaders;
  },
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => ({})),
  getEntitlements: vi.fn(async () => s.ent),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById } } }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));
vi.mock("@/env", () => ({
  getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.test" }),
}));

import {
  acceptInvitation,
  InvitationAcceptError,
  InvitationAccountMismatchError,
} from "@/server/services/members";

function invite(orgId: string, userId: string) {
  const token = `tok-${orgId.slice(0, 1)}-${userId}`;
  s.invitations.push({
    id: `inv-${orgId.slice(0, 1)}-${userId}`,
    organizationId: orgId,
    email: `${userId}@example.test`,
    role: "MEMBER",
    token,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return token;
}

/** The signed-in identity the action passes from Supabase Auth. */
const session = (userId: string) => ({ id: userId, email: `${userId}@example.test` });

function seedMember(orgId: string, userId: string) {
  s.members.push({ id: `m-${++s.seq}`, organizationId: orgId, userId, role: "MEMBER" });
}

/** A booking type left active from an earlier membership (disabled on rejoin). */
function seedBookingType(orgId: string, ownerId: string) {
  const row = {
    id: `bt-${++s.seq}`,
    organizationId: orgId,
    ownerId,
    isActive: true,
    deletedAt: null,
  };
  s.bookingTypes.push(row);
  return row;
}

const joinRows = (rows: Array<Record<string, unknown>>) =>
  rows.filter((r) => r.action === "member.join");

beforeEach(() => {
  vi.clearAllMocks();
  s.orgs = new Map([
    [ORG_A, { deletedAt: null }],
    [ORG_B, { deletedAt: null }],
  ]);
  s.members = [];
  s.invitations = [];
  s.bookingTypes = [];
  s.audits = [];
  s.globalAudits = [];
  s.auditFailure = null;
  s.emails = new Map();
  s.locks = new Map();
  s.lockCalls = [];
  s.seq = 0;
  s.ent = { maxSeats: 5, readOnly: false };
});

describe("the member.join audit row is part of the join", () => {
  it("audit insert fails inside the transaction: the join rolls back and the error reaches the caller", async () => {
    seedMember(ORG_A, "owner");
    const legacyType = seedBookingType(ORG_A, "u1");
    const token = invite(ORG_A, "u1");
    const auditError = Object.assign(new Error("synthetic audit insert failure"), {
      name: "AuditWriteError",
    });
    s.auditFailure = auditError;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(acceptInvitation(token, session("u1"))).rejects.toBe(auditError);

    // The transaction did run as far as the audit write, then undid everything.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(membersOf(ORG_A).map((m) => m.userId)).toEqual(["owner"]);
    expect(s.invitations[0]!.status).toBe("PENDING");
    expect(legacyType.isActive).toBe(true);
    expect(s.audits).toHaveLength(0);
    expect(s.globalAudits).toHaveLength(0);
    // Nothing after the transaction ran, and the failure wasn't swallowed
    // into a log line (the old `member_join_audit_failed` behaviour).
    expect(updateUserById).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("after a rolled-back attempt the same invitation can still be accepted, with one audit row", async () => {
    const token = invite(ORG_A, "u1");
    s.auditFailure = new Error("synthetic audit insert failure");
    await expect(acceptInvitation(token, session("u1"))).rejects.toThrow(
      "synthetic audit insert failure",
    );

    s.auditFailure = null;
    await expect(acceptInvitation(token, session("u1"))).resolves.toBe(ORG_A);
    expect(membersOf(ORG_A).map((m) => m.userId)).toEqual(["u1"]);
    expect(joinRows(s.audits)).toHaveLength(1);
  });

  it("success: exactly one member.join row, through the transaction client, for the invitation's organization", async () => {
    seedMember(ORG_B, "owner");
    seedBookingType(ORG_B, "u1");
    const token = invite(ORG_B, "u1");

    await expect(acceptInvitation(token, session("u1"))).resolves.toBe(ORG_B);

    expect(s.audits).toEqual([
      {
        organizationId: ORG_B,
        actorId: "u1",
        actorType: "user",
        action: "member.join",
        resourceType: "organization_member",
        resourceId: "u1",
        before: undefined,
        after: { bookingTypesDisabled: 1, activeSeats: 2 },
        ip: "203.0.113.7",
        userAgent: "synthetic-agent",
      },
    ]);
    // Not through the global client, before or after the commit.
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(s.globalAudits).toHaveLength(0);
    expect(membersOf(ORG_B).map((m) => m.userId)).toEqual(["owner", "u1"]);
    expect(s.invitations[0]!.status).toBe("ACCEPTED");
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(updateUserById).toHaveBeenCalledWith("u1", {
      app_metadata: { last_active_org: ORG_B },
    });
  });
});

describe("duplicate requests leave exactly one audit row", () => {
  it("a second accept of the same token after the first committed is invalid", async () => {
    const token = invite(ORG_A, "u1");
    await expect(acceptInvitation(token, session("u1"))).resolves.toBe(ORG_A);

    const second = acceptInvitation(token, session("u1"));
    await expect(second).rejects.toBeInstanceOf(InvitationAcceptError);
    await expect(second).rejects.toMatchObject({ code: "invalid" });

    expect(joinRows(s.audits)).toHaveLength(1);
    expect(s.globalAudits).toHaveLength(0);
    expect(membersOf(ORG_A).filter((m) => m.userId === "u1")).toHaveLength(1);
    expect(updateUserById).toHaveBeenCalledTimes(1);
  });

  it("two concurrent accepts: the one that re-reads under the lock sees non-PENDING and is invalid", async () => {
    const token = invite(ORG_A, "u1");

    const results = await Promise.allSettled([
      acceptInvitation(token, session("u1")),
      acceptInvitation(token, session("u1")),
    ]);

    // Both passed the first read and reached the lock; only one found PENDING there.
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(s.lockCalls).toEqual([ORG_A, ORG_A]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvitationAcceptError);
    expect((rejected[0]!.reason as InvitationAcceptError).code).toBe("invalid");

    expect(joinRows(s.audits)).toHaveLength(1);
    expect(s.globalAudits).toHaveLength(0);
    expect(membersOf(ORG_A).filter((m) => m.userId === "u1")).toHaveLength(1);
    expect(updateUserById).toHaveBeenCalledTimes(1);
  });
});

describe("authorization", () => {
  it("a signed-in user whose email doesn't match the invitation: mismatch, no membership, no audit row", async () => {
    const token = invite(ORG_A, "u1");
    s.emails.set("intruder", "intruder@example.test");

    await expect(acceptInvitation(token, session("intruder"))).rejects.toBeInstanceOf(
      InvitationAccountMismatchError,
    );

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(s.members).toHaveLength(0);
    expect(s.invitations[0]!.status).toBe("PENDING");
    expect(s.audits).toHaveLength(0);
    expect(s.globalAudits).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe("tenant isolation", () => {
  it("a member of org A joining org B: one row, for org B only, from the invitation's organization", async () => {
    seedMember(ORG_A, "owner-a");
    seedMember(ORG_A, "u1");
    seedMember(ORG_B, "owner-b");
    const typeInA = seedBookingType(ORG_A, "u1");
    // The same user also holds an untouched invitation in org A's name.
    invite(ORG_A, "u1");
    const tokenB = invite(ORG_B, "u1");

    await expect(acceptInvitation(tokenB, session("u1"))).resolves.toBe(ORG_B);

    const invitationB = s.invitations.find((i) => i.token === tokenB)!;
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({
      organizationId: invitationB.organizationId,
      actorId: "u1",
      action: "member.join",
      after: { bookingTypesDisabled: 0, activeSeats: 2 },
    });
    expect(s.audits[0]!.organizationId).toBe(ORG_B);
    expect(s.audits.filter((a) => a.organizationId !== ORG_B)).toHaveLength(0);
    expect(s.globalAudits).toHaveLength(0);

    // Org A is exactly as it was: same members, same booking type, no lock taken.
    expect(membersOf(ORG_A).map((m) => m.userId)).toEqual(["owner-a", "u1"]);
    expect(typeInA.isActive).toBe(true);
    expect(s.invitations.find((i) => i.organizationId === ORG_A)!.status).toBe("PENDING");
    expect(s.lockCalls).toEqual([ORG_B]);
    expect(membersOf(ORG_B).map((m) => m.userId)).toEqual(["owner-b", "u1"]);
  });
});

describe("refused joins write no member.join row", () => {
  it.each([
    [
      "read_only",
      () => {
        s.ent = { maxSeats: 5, readOnly: true };
      },
    ],
    [
      "seat_limit",
      () => {
        s.ent = { maxSeats: 1, readOnly: false };
      },
    ],
    [
      "already_member",
      () => {
        seedMember(ORG_A, "u1");
      },
    ],
    [
      "invalid",
      () => {
        s.orgs.set(ORG_A, { deletedAt: new Date() });
      },
    ],
  ])("%s", async (code, arrange) => {
    seedMember(ORG_A, "owner");
    const token = invite(ORG_A, "u1");
    arrange();
    const membersBefore = s.members.map((m) => m.userId);

    const refused = acceptInvitation(token, session("u1"));
    await expect(refused).rejects.toBeInstanceOf(InvitationAcceptError);
    await expect(refused).rejects.toMatchObject({ code });

    expect(s.audits).toHaveLength(0);
    expect(s.globalAudits).toHaveLength(0);
    expect(s.members.map((m) => m.userId)).toEqual(membersBefore);
    expect(s.invitations[0]!.status).toBe("PENDING");
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
