import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plan's seat limit is enforced where a seat is actually taken: accepting
 * an invitation. Joins to one organization are serialized by a per-org
 * advisory lock, faked here as a real per-organization queue, so concurrent
 * acceptances can't all pass the same count. Inviting also counts pending,
 * unexpired invitations to other addresses.
 */

type Row = Record<string, unknown>;

const s = vi.hoisted(() => ({
  orgs: new Map<string, { deletedAt: Date | null }>(),
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
  invitations: [] as Array<Record<string, unknown>>,
  locks: new Map<string, Promise<void>>(),
  lockCalls: [] as string[],
  seq: 0,
  ent: { maxSeats: 2, readOnly: false },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const yieldNow = () => new Promise((r) => setTimeout(r, 0));
const membersOf = (orgId: string) =>
  s.orgs.get(orgId)?.deletedAt ? [] : s.members.filter((m) => m.organizationId === orgId);

function makeTx(held: string[]) {
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
      held.push(orgId);
      (held as unknown as { release?: Array<() => void> }).release ??= [];
      (held as unknown as { release: Array<() => void> }).release.push(release);
      return 0;
    }),
    organization: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => s.orgs.get(where.id) ?? null,
      ),
    },
    organizationMember: {
      count: vi.fn(async ({ where }: { where: Row }) => {
        // Read, then yield before returning: like a real read that another
        // transaction can commit after. Without the seat lock, a concurrent
        // join reads the same count.
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
        // A slow insert: another transaction can commit while it runs.
        await yieldNow();
        const row = { id: `m-${++s.seq}`, role: "MEMBER", ...data } as (typeof s.members)[number];
        s.members.push(row);
        return row;
      }),
    },
    invitation: {
      findUnique: vi.fn(
        async ({ where }: { where: Row }) => s.invitations.find((i) => i.id === where.id) ?? null,
      ),
      // revokeInvitation's read: scoped by every given field, then a yield
      // (like count above) so another transaction can commit in between.
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row =
          s.invitations.find((i) =>
            Object.entries(where).every(([k, v]) => v === undefined || i[k] === v),
          ) ?? null;
        await yieldNow();
        return row ? { ...row } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(
          s.invitations.find((i) => i.id === where.id)!,
          data,
        ),
      ),
      // Like Prisma: a filter that isn't given matches every row.
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = s.invitations.filter((i) =>
          Object.entries(where).every(([k, v]) => v === undefined || i[k] === v),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    bookingType: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
}

const db = {
  invitation: {
    findUnique: vi.fn(
      async ({ where }: { where: Row }) =>
        s.invitations.find((i) => i.token === where.token) ?? null,
    ),
    update: vi.fn(async () => ({})),
    upsert: vi.fn(async ({ create }: { create: Row }) => ({
      id: "inv-new",
      token: "tok-new",
      ...create,
    })),
  },
  user: {
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => ({
      id: where.id,
      email: `${where.id as string}@example.test`,
    })),
    findUnique: vi.fn(async () => null),
  },
  organization: {
    findUniqueOrThrow: vi.fn(async () => ({ name: "Synthetic", defaultLocale: "EN" })),
  },
  organizationMember: {
    count: vi.fn(
      async ({ where }: { where: Row }) => membersOf(where.organizationId as string).length,
    ),
  },
  $transaction: vi.fn(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
    const held: string[] = [];
    try {
      return await fn(makeTx(held));
    } finally {
      for (const release of (held as unknown as { release?: Array<() => void> }).release ?? []) {
        release();
      }
    }
  }),
};

const invitationCount = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: (orgId: string) => ({
    organizationMember: {
      count: async () => membersOf(orgId).length,
      findFirst: async () => null,
    },
    invitation: { count: (args: unknown) => invitationCount(orgId, args) },
  }),
}));
const { EntitlementErrorMock, assertWithinLimitMock } = vi.hoisted(() => ({
  EntitlementErrorMock: class EntitlementError extends Error {
    constructor(
      public readonly limit: string,
      message: string,
    ) {
      super(message);
    }
  },
  assertWithinLimitMock: vi.fn(async () => ({})),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: assertWithinLimitMock,
  getEntitlements: vi.fn(async () => s.ent),
  EntitlementError: EntitlementErrorMock,
}));
const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: vi.fn(async () => ({})) } } }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));
vi.mock("@/env", () => ({
  getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.test" }),
}));

import {
  acceptInvitation,
  InvitationAcceptError,
  inviteMember,
  MemberError,
  revokeInvitation,
} from "@/server/services/members";
import type { TenantContext } from "@/server/auth/session";

function invite(orgId: string, userId: string) {
  const token = `tok-${userId}`;
  s.invitations.push({
    id: `inv-${userId}`,
    organizationId: orgId,
    email: `${userId}@example.test`,
    role: "MEMBER",
    token,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return token;
}

function seed(orgId: string, members: number) {
  for (let i = 0; i < members; i++) {
    s.members.push({
      id: `m-${++s.seq}`,
      organizationId: orgId,
      userId: `seed-${s.seq}`,
      role: "MEMBER",
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  s.orgs = new Map([
    [ORG_A, { deletedAt: null }],
    [ORG_B, { deletedAt: null }],
  ]);
  s.members = [];
  s.invitations = [];
  s.locks = new Map();
  s.lockCalls = [];
  s.ent = { maxSeats: 2, readOnly: false };
  invitationCount.mockResolvedValue(0);
});

describe("acceptInvitation seat limit", () => {
  it("joins while a seat is free, under the organization's seat lock", async () => {
    seed(ORG_A, 1);
    await expect(acceptInvitation(invite(ORG_A, "u1"), "u1")).resolves.toBe(ORG_A);
    expect(membersOf(ORG_A)).toHaveLength(2);
    expect(s.lockCalls).toEqual([ORG_A]);
    expect(auditMock).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: "u1" },
      expect.objectContaining({
        action: "member.join",
        after: expect.objectContaining({ activeSeats: 2 }),
      }),
    );
  });

  it("refuses a join that would exceed the plan, and changes nothing", async () => {
    seed(ORG_A, 2);
    const token = invite(ORG_A, "u1");
    await expect(acceptInvitation(token, "u1")).rejects.toEqual(
      new InvitationAcceptError("seat_limit"),
    );
    expect(membersOf(ORG_A)).toHaveLength(2);
    expect(s.invitations[0]!.status).toBe("PENDING");
  });

  it("lets exactly one of two concurrent acceptances take the last seat", async () => {
    seed(ORG_A, 1);
    const results = await Promise.allSettled([
      acceptInvitation(invite(ORG_A, "u1"), "u1"),
      acceptInvitation(invite(ORG_A, "u2"), "u2"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvitationAcceptError);
    expect((rejected[0]!.reason as InvitationAcceptError).code).toBe("seat_limit");
    expect(membersOf(ORG_A)).toHaveLength(2);
  });

  it("counts only its own organization's members (cross-tenant)", async () => {
    seed(ORG_B, 40);
    seed(ORG_A, 1);
    await expect(acceptInvitation(invite(ORG_A, "u1"), "u1")).resolves.toBe(ORG_A);
    expect(membersOf(ORG_B)).toHaveLength(40);
  });

  it("refuses to join a deleted organization", async () => {
    s.orgs.set(ORG_A, { deletedAt: new Date() });
    await expect(acceptInvitation(invite(ORG_A, "u1"), "u1")).rejects.toMatchObject({
      code: "invalid",
    });
    expect(s.members).toHaveLength(0);
  });

  it("refuses to join a read-only (long past-due) workspace", async () => {
    s.ent = { maxSeats: 50, readOnly: true };
    await expect(acceptInvitation(invite(ORG_A, "u1"), "u1")).rejects.toMatchObject({
      code: "read_only",
    });
    expect(s.members).toHaveLength(0);
  });

  it("an existing member gets already_member, not a seat or database error", async () => {
    seed(ORG_A, 2); // full: the seat check must not be what answers
    const token = invite(ORG_A, "u1");
    s.members.push({ id: "m-existing", organizationId: ORG_A, userId: "u1", role: "MEMBER" });
    await expect(acceptInvitation(token, "u1")).rejects.toMatchObject({ code: "already_member" });
    expect(s.invitations[0]!.status).toBe("PENDING");
  });

  it("the same invitation accepted twice at once: one joins, the other is a safe invalid", async () => {
    seed(ORG_A, 0);
    const token = invite(ORG_A, "u1");
    const results = await Promise.allSettled([
      acceptInvitation(token, "u1"),
      acceptInvitation(token, "u1"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected[0]!.reason).toBeInstanceOf(InvitationAcceptError);
    expect((rejected[0]!.reason as InvitationAcceptError).code).toBe("invalid");
    expect(membersOf(ORG_A).filter((m) => m.userId === "u1")).toHaveLength(1);
    expect(s.invitations[0]!.status).toBe("ACCEPTED");
  });
});

describe("inviteMember seat check", () => {
  const ctx = {
    orgId: ORG_A,
    userId: "admin",
    email: "admin@example.test",
    role: "OWNER",
    locale: "en",
  } as const;

  it("counts pending, unexpired invitations to other addresses as taken seats", async () => {
    seed(ORG_A, 1);
    invitationCount.mockResolvedValue(1);
    await inviteMember(ctx as never, { email: "new@example.test", role: "MEMBER" });

    expect(assertWithinLimitMock).toHaveBeenCalledWith(ORG_A, { kind: "seats", current: 2 });
    const [orgId, args] = invitationCount.mock.calls[0]!;
    expect(orgId).toBe(ORG_A);
    expect(args).toEqual({
      where: {
        status: "PENDING",
        expiresAt: { gt: expect.any(Date) },
        NOT: { email: "new@example.test" },
      },
    });
  });
});

describe("withdrawal and acceptance are serialized by the same per-organization lock", () => {
  const ctx = { orgId: ORG_A, userId: "owner-1", role: "OWNER" } as unknown as TenantContext;

  /** One seated member, one pending invitation to "joiner" (token tok-joiner). */
  function pendingInvitation() {
    seed(ORG_A, 1);
    const token = invite(ORG_A, "joiner");
    return { token, id: "inv-joiner", userId: "joiner" };
  }

  /** Exactly one of the two succeeded, and the rows agree with the one that did. */
  function expectOneWinner(
    id: string,
    userId: string,
    accept: PromiseSettledResult<unknown>,
    revoke: PromiseSettledResult<unknown>,
  ) {
    const row = s.invitations.find((i) => i.id === id)!;
    const joined = s.members.filter((m) => m.organizationId === ORG_A && m.userId === userId);
    expect([accept, revoke].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    if (accept.status === "fulfilled") {
      const refused = (revoke as PromiseRejectedResult).reason;
      expect(refused).toBeInstanceOf(MemberError);
      expect(refused.code).toBe("not_pending");
      expect(row.status).toBe("ACCEPTED");
      expect(row.token).toBe("tok-joiner");
      expect(joined).toHaveLength(1);
      expect(auditMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "member.invite_revoke" }),
      );
    } else {
      const refused = (accept as PromiseRejectedResult).reason;
      expect(refused).toBeInstanceOf(InvitationAcceptError);
      expect(refused.code).toBe("invalid");
      expect(row.status).toBe("REVOKED");
      expect(row.token).not.toBe("tok-joiner");
      expect(joined).toHaveLength(0);
    }
  }

  it("a withdrawal arriving while the acceptance, past its re-read, holds the lock waits and is refused", async () => {
    const { token, id, userId } = pendingInvitation();
    const accept = acceptInvitation(token, userId);
    // The acceptance now holds the lock, has re-read PENDING and is inside the
    // seat count. Before the lock was shared, a withdrawal here committed
    // REVOKED and the acceptance then overwrote it with ACCEPTED.
    await yieldNow();
    expect(s.lockCalls).toEqual([ORG_A]);
    const revoke = revokeInvitation(ctx, id);

    const [a, r] = await Promise.allSettled([accept, revoke]);
    expectOneWinner(id, userId, a, r);
    expect(a.status).toBe("fulfilled");
    expect(s.lockCalls).toEqual([ORG_A, ORG_A]);
  });

  it("an acceptance arriving while the withdrawal, past its read, holds the lock waits and finds the invitation withdrawn", async () => {
    const { token, id, userId } = pendingInvitation();
    const revoke = revokeInvitation(ctx, id);
    await yieldNow(); // the withdrawal holds the lock and has read the row
    const accept = acceptInvitation(token, userId);

    const [a, r] = await Promise.allSettled([accept, revoke]);
    expectOneWinner(id, userId, a, r);
    expect(r.status).toBe("fulfilled");
    expect(s.lockCalls).toEqual([ORG_A, ORG_A]);
  });

  it("two concurrent withdrawals: one succeeds, the other is refused, the token changes once", async () => {
    const { id } = pendingInvitation();
    const results = await Promise.allSettled([
      revokeInvitation(ctx, id),
      revokeInvitation(ctx, id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code,
    ).toBe("not_pending");
    const row = s.invitations.find((i) => i.id === id)!;
    expect(row.status).toBe("REVOKED");
    expect(row.token).not.toBe("tok-joiner");
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("sequentially: accept then withdraw is refused; withdraw then accept finds a dead link", async () => {
    const first = pendingInvitation();
    await acceptInvitation(first.token, first.userId);
    await expect(revokeInvitation(ctx, first.id)).rejects.toMatchObject({ code: "not_pending" });
    expect(s.invitations.find((i) => i.id === first.id)!.status).toBe("ACCEPTED");

    const token = invite(ORG_A, "second");
    await revokeInvitation(ctx, "inv-second");
    await expect(acceptInvitation(token, "second")).rejects.toMatchObject({ code: "invalid" });
    expect(s.members.filter((m) => m.userId === "second")).toHaveLength(0);
  });
});
