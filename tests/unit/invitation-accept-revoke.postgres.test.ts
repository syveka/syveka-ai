import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@/server/auth/session";
import type {
  countActiveSeats as CountActiveSeats,
  lockOrgSeats as LockOrgSeats,
} from "@/server/services/billing/seats";

/**
 * Withdrawing (revokeInvitation) against accepting (acceptInvitation) the same
 * invitation, on a real Postgres with the full migration history: real Prisma
 * transactions, the real per-organization advisory lock, the real rows. Only
 * external effects are mocked (email, Supabase admin, audit) and the plan
 * lookup (maxSeats 2).
 *
 * The invariant: a withdrawal and an acceptance of one invitation can't both
 * succeed. Acceptance holds the organization's seat lock from its re-read of
 * the status to its commit; withdrawal takes the same lock, so the second
 * arrival sees the first's committed status and is refused.
 *
 * The interleaving that broke before this lock was shared is forced here:
 * acceptance is paused inside its transaction, after it re-read PENDING
 * (countActiveSeats is the next call), while a withdrawal is attempted.
 *
 * Skipped unless SEAT_LIMIT_PG_URL points at a scratch database prepared as
 * in CI: tests/migrations/supabase-compatibility.sql, then
 * `prisma migrate deploy`. A 4-connection pool stands in for separate
 * serverless instances (the app's pool is max 1 per instance).
 */

const PG_URL = process.env.SEAT_LIMIT_PG_URL;

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  // When set, acceptInvitation pauses inside its transaction (after the
  // locked re-read of the invitation) until the gate opens.
  gate: null as null | { entered: () => void; open: Promise<void> },
}));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by acceptInvitation or revokeInvitation");
  },
}));
vi.mock("@/server/services/billing/seats", async (importActual) => {
  const actual = await importActual<{
    countActiveSeats: typeof CountActiveSeats;
    lockOrgSeats: typeof LockOrgSeats;
  }>();
  return {
    ...actual,
    countActiveSeats: async (...args: Parameters<typeof actual.countActiveSeats>) => {
      if (holder.gate) {
        holder.gate.entered();
        await holder.gate.open;
      }
      return actual.countActiveSeats(...args);
    },
  };
});
vi.mock("@/server/services/billing/entitlements", async (importActual) => ({
  ...(await importActual<object>()),
  getEntitlements: vi.fn(async () => ({ maxSeats: 2, readOnly: false })),
}));
const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/server/services/audit", () => ({ audit }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: vi.fn(async () => ({})) } } }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));

type Db = {
  organization: { create: (a: object) => Promise<{ id: string }> };
  user: { create: (a: object) => Promise<{ id: string; email: string }> };
  organizationMember: {
    create: (a: object) => Promise<unknown>;
    count: (a: object) => Promise<number>;
  };
  invitation: {
    create: (a: object) => Promise<{ id: string; token: string }>;
    findUnique: (a: object) => Promise<{ status: string; token: string } | null>;
  };
  $disconnect: () => Promise<void>;
};

type Ctx = TenantContext;

describe.skipIf(!PG_URL)("withdraw vs accept on real Postgres (service path)", () => {
  let db: Db;

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
    ]);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 4 }),
    }) as unknown as Db;
    holder.client = db;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  /** An organization with its owner and one pending invitation to a joiner. */
  async function seed() {
    const org = await db.organization.create({
      data: { name: "Synthetic withdraw test", slug: `withdraw-test-${randomUUID()}` },
    });
    const owner = await db.user.create({
      data: { id: randomUUID(), email: `owner-${randomUUID()}@example.test` },
    });
    await db.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: "OWNER" },
    });
    const joiner = await db.user.create({
      data: { id: randomUUID(), email: `joiner-${randomUUID()}@example.test` },
    });
    const token = randomUUID();
    const invitation = await db.invitation.create({
      data: {
        organizationId: org.id,
        email: joiner.email,
        role: "MEMBER",
        invitedById: owner.id,
        token,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const ctx = { orgId: org.id, userId: owner.id, role: "OWNER" } as unknown as Ctx;
    return { orgId: org.id, ctx, joinerId: joiner.id, invitationId: invitation.id, token };
  }

  const members = (orgId: string) =>
    db.organizationMember.count({ where: { organizationId: orgId } });
  const memberships = (orgId: string, userId: string) =>
    db.organizationMember.count({ where: { organizationId: orgId, userId } });
  const invitation = (id: string) => db.invitation.findUnique({ where: { id } });

  /** Exactly one of the two settled operations succeeded, and the rows agree with it. */
  async function expectOneWinner(
    seeded: Awaited<ReturnType<typeof seed>>,
    accept: PromiseSettledResult<unknown>,
    revoke: PromiseSettledResult<unknown>,
  ) {
    const { MemberError, InvitationAcceptError } = await import("@/server/services/members");
    const row = await invitation(seeded.invitationId);
    expect([accept.status, revoke.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    if (accept.status === "fulfilled") {
      expect(revoke.status).toBe("rejected");
      expect((revoke as PromiseRejectedResult).reason).toBeInstanceOf(MemberError);
      expect((revoke as PromiseRejectedResult).reason.code).toBe("not_pending");
      expect(row?.status).toBe("ACCEPTED");
      expect(row?.token).toBe(seeded.token);
      await expect(memberships(seeded.orgId, seeded.joinerId)).resolves.toBe(1);
      await expect(members(seeded.orgId)).resolves.toBe(2);
    } else {
      expect(revoke.status).toBe("fulfilled");
      expect((accept as PromiseRejectedResult).reason).toBeInstanceOf(InvitationAcceptError);
      expect((accept as PromiseRejectedResult).reason.code).toBe("invalid");
      expect(row?.status).toBe("REVOKED");
      expect(row?.token).not.toBe(seeded.token);
      await expect(memberships(seeded.orgId, seeded.joinerId)).resolves.toBe(0);
      await expect(members(seeded.orgId)).resolves.toBe(1);
    }
  }

  it("a withdrawal attempted while the acceptance holds the lock after its re-read is refused; the person joins once", async () => {
    const { acceptInvitation, revokeInvitation } = await import("@/server/services/members");
    const seeded = await seed();

    let entered!: () => void;
    let open!: () => void;
    const enteredPromise = new Promise<void>((r) => (entered = r));
    holder.gate = { entered, open: new Promise<void>((r) => (open = r)) };
    try {
      const accept = acceptInvitation(seeded.token, seeded.joinerId);
      await enteredPromise; // acceptance has re-read PENDING under the lock and is paused
      const revoke = revokeInvitation(seeded.ctx, seeded.invitationId);

      // The withdrawal must not complete while the acceptance is in flight:
      // it is waiting for the same lock.
      const during = await Promise.race([
        revoke.then(
          () => "revoked",
          () => "refused",
        ),
        new Promise<string>((r) => setTimeout(() => r("waiting"), 400)),
      ]);
      expect(during).toBe("waiting");

      open();
      const [a, r] = await Promise.allSettled([accept, revoke]);
      await expectOneWinner(seeded, a, r);
      expect(a.status).toBe("fulfilled");
    } finally {
      holder.gate = null;
    }
  });

  it("withdraw first, then accept: the link is dead, nobody joins", async () => {
    const { acceptInvitation, revokeInvitation, InvitationAcceptError } =
      await import("@/server/services/members");
    const seeded = await seed();

    await revokeInvitation(seeded.ctx, seeded.invitationId);
    await expect(acceptInvitation(seeded.token, seeded.joinerId)).rejects.toBeInstanceOf(
      InvitationAcceptError,
    );
    const row = await invitation(seeded.invitationId);
    expect(row?.status).toBe("REVOKED");
    expect(row?.token).not.toBe(seeded.token);
    await expect(memberships(seeded.orgId, seeded.joinerId)).resolves.toBe(0);
    expect(audit).toHaveBeenCalledWith(
      seeded.ctx,
      expect.objectContaining({ action: "member.invite_revoke", resourceId: seeded.invitationId }),
    );
  });

  it("accept first, then withdraw: refused as not pending, the member stays", async () => {
    const { acceptInvitation, revokeInvitation } = await import("@/server/services/members");
    const seeded = await seed();

    await acceptInvitation(seeded.token, seeded.joinerId);
    await expect(revokeInvitation(seeded.ctx, seeded.invitationId)).rejects.toMatchObject({
      code: "not_pending",
    });
    expect((await invitation(seeded.invitationId))?.status).toBe("ACCEPTED");
    await expect(memberships(seeded.orgId, seeded.joinerId)).resolves.toBe(1);
  });

  it("two concurrent withdrawals: exactly one succeeds, the token changes once", async () => {
    const { revokeInvitation } = await import("@/server/services/members");
    const seeded = await seed();
    audit.mockClear();

    const results = await Promise.allSettled([
      revokeInvitation(seeded.ctx, seeded.invitationId),
      revokeInvitation(seeded.ctx, seeded.invitationId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.code).toBe("not_pending");
    const row = await invitation(seeded.invitationId);
    expect(row?.status).toBe("REVOKED");
    expect(row?.token).not.toBe(seeded.token);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("simultaneous accept and withdraw, repeated: never both, and the rows agree with the winner", async () => {
    const { acceptInvitation, revokeInvitation } = await import("@/server/services/members");
    for (let i = 0; i < 6; i++) {
      const seeded = await seed();
      const [a, r] = await Promise.allSettled([
        acceptInvitation(seeded.token, seeded.joinerId),
        revokeInvitation(seeded.ctx, seeded.invitationId),
      ]);
      await expectOneWinner(seeded, a, r);
    }
  });
});
