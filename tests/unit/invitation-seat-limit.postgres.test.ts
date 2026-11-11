import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { auditLogData as AuditLogData } from "@/server/services/audit";

/**
 * The real acceptInvitation() service path against a real Postgres with the
 * full migration history: real Prisma queries, the real advisory lock, the
 * real membership INSERT and unique constraints. Only external effects are
 * mocked (email, Supabase admin, audit) and the plan lookup (maxSeats 2).
 *
 * The app's Prisma pool is max 1 per serverless instance, so two acceptances
 * in one process would be serialized by the pool, not the lock. This test
 * uses a 4-connection pool to stand in for separate instances.
 *
 * Skipped unless SEAT_LIMIT_PG_URL points at a scratch database prepared as
 * in CI: tests/migrations/supabase-compatibility.sql, then
 * `prisma migrate deploy`. Not run in CI.
 */

const PG_URL = process.env.SEAT_LIMIT_PG_URL;

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  // When set, the join's audit row is given this organization id instead of
  // the invitation's. An id that matches no organization makes the real
  // INSERT into audit_logs fail on its foreign key, inside the transaction.
  auditOrganizationId: null as string | null,
  brokenAuditRows: 0,
}));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by acceptInvitation");
  },
}));
vi.mock("@/server/services/billing/entitlements", async (importActual) => ({
  ...(await importActual<object>()),
  getEntitlements: vi.fn(async () => ({ maxSeats: 2, readOnly: false })),
}));
// auditLogData stays real: the join's audit row is written inside the join's
// transaction, against this database.
vi.mock("@/server/services/audit", async (importActual) => {
  const actual = await importActual<{ auditLogData: typeof AuditLogData }>();
  return {
    ...actual,
    audit: vi.fn(async () => undefined),
    // Real unless a test sets holder.auditOrganizationId (see there).
    auditLogData: async (...args: Parameters<typeof actual.auditLogData>) => {
      const data = await actual.auditLogData(...args);
      if (!holder.auditOrganizationId) return data;
      holder.brokenAuditRows += 1;
      return { ...data, organizationId: holder.auditOrganizationId };
    },
  };
});
vi.mock("next/headers", () => ({
  headers: async () => {
    throw new Error("no request");
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: vi.fn(async () => ({})) } } }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));

type AuditRow = {
  organizationId: string;
  actorId: string | null;
  action: string;
  resourceId: string | null;
};

type Db = {
  organization: {
    create: (a: object) => Promise<{ id: string }>;
    update: (a: object) => Promise<unknown>;
  };
  user: { create: (a: object) => Promise<{ id: string; email: string }> };
  organizationMember: {
    create: (a: object) => Promise<unknown>;
    count: (a: object) => Promise<number>;
  };
  invitation: {
    create: (a: object) => Promise<{ token: string }>;
    findFirst: (a: object) => Promise<{ status: string } | null>;
  };
  auditLog: { findMany: (a: object) => Promise<AuditRow[]> };
  $disconnect: () => Promise<void>;
};

describe.skipIf(!PG_URL)("acceptInvitation on real Postgres (service path)", () => {
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

  /** An organization with one member and `invitees` pending invitations. */
  async function seed(invitees: number) {
    const org = await db.organization.create({
      data: { name: "Synthetic seat test", slug: `seat-test-${randomUUID()}` },
    });
    const owner = await db.user.create({
      data: { id: randomUUID(), email: `owner-${randomUUID()}@example.test` },
    });
    await db.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: "OWNER" },
    });
    const joiners = [];
    for (let i = 0; i < invitees; i++) {
      const user = await db.user.create({
        data: { id: randomUUID(), email: `joiner-${randomUUID()}@example.test` },
      });
      const invitation = await db.invitation.create({
        data: {
          organizationId: org.id,
          email: user.email,
          role: "MEMBER",
          invitedById: owner.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      // `session` is the signed-in identity the action passes from Supabase Auth.
      joiners.push({
        userId: user.id,
        token: invitation.token,
        session: { id: user.id, email: user.email },
      });
    }
    return { orgId: org.id, joiners };
  }

  const members = (orgId: string) =>
    db.organizationMember.count({ where: { organizationId: orgId } });
  const memberships = (orgId: string, userId: string) =>
    db.organizationMember.count({ where: { organizationId: orgId, userId } });
  /** The join audit rows stored in audit_logs, read back from the database. */
  const joinAudits = (where: { organizationId: string } | { actorId: string }) =>
    db.auditLog.findMany({
      where: { ...where, action: "member.join" },
      select: { organizationId: true, actorId: true, action: true, resourceId: true },
    });

  it("lets exactly one of two concurrent acceptances take the last seat", async () => {
    const { acceptInvitation, InvitationAcceptError } = await import("@/server/services/members");
    const { orgId, joiners } = await seed(2);

    const results = await Promise.allSettled(
      joiners.map((j) => acceptInvitation(j.token, j.session)),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvitationAcceptError);
    expect(rejected[0]!.reason).toMatchObject({ code: "seat_limit" });
    await expect(members(orgId)).resolves.toBe(2);

    // The refused invitation is left pending; nothing of it was written.
    const loser = joiners[results.findIndex((r) => r.status === "rejected")]!;
    const invitation = await db.invitation.findFirst({ where: { token: loser.token } });
    expect(invitation?.status).toBe("PENDING");

    // One audit row per join that committed: as many as memberships created
    // (the seeded owner's membership is not a join), and it is the winner's.
    const winner = joiners[results.findIndex((r) => r.status === "fulfilled")]!;
    const joined = (await members(orgId)) - 1;
    const audits = await joinAudits({ organizationId: orgId });
    expect(audits).toHaveLength(joined);
    expect(audits).toEqual([
      {
        organizationId: orgId,
        actorId: winner.userId,
        action: "member.join",
        resourceId: winner.userId,
      },
    ]);
    await expect(memberships(orgId, winner.userId)).resolves.toBe(1);
    // The refused acceptance left no membership and no audit row anywhere.
    await expect(memberships(orgId, loser.userId)).resolves.toBe(0);
    await expect(joinAudits({ actorId: loser.userId })).resolves.toEqual([]);
  });

  it("rolls the join back when its audit row can't be written", async () => {
    const { acceptInvitation, InvitationAcceptError } = await import("@/server/services/members");
    const { orgId, joiners } = await seed(1);
    const joiner = joiners[0]!;

    // No organization has this id, so audit_logs_organization_id_fkey rejects
    // the INSERT. By then the membership INSERT and the invitation UPDATE have
    // already run in the same transaction; the database has to undo them.
    holder.brokenAuditRows = 0;
    holder.auditOrganizationId = randomUUID();
    let failure: unknown;
    try {
      await acceptInvitation(joiner.token, joiner.session);
    } catch (error) {
      failure = error;
    } finally {
      holder.auditOrganizationId = null;
    }

    expect(failure).toBeInstanceOf(Error);
    // Not one of the refusals decided before any write (seat limit, invalid…).
    expect(failure).not.toBeInstanceOf(InvitationAcceptError);
    // The acceptance reached the audit write, which is the last statement.
    expect(holder.brokenAuditRows).toBe(1);

    await expect(memberships(orgId, joiner.userId)).resolves.toBe(0);
    await expect(members(orgId)).resolves.toBe(1);
    const pending = await db.invitation.findFirst({ where: { token: joiner.token } });
    expect(pending?.status).toBe("PENDING");
    await expect(joinAudits({ organizationId: orgId })).resolves.toEqual([]);
    await expect(joinAudits({ actorId: joiner.userId })).resolves.toEqual([]);

    // Nothing of the failed attempt is left behind: the same invitation is
    // accepted normally once the audit row can be written.
    await expect(acceptInvitation(joiner.token, joiner.session)).resolves.toBe(orgId);
    await expect(memberships(orgId, joiner.userId)).resolves.toBe(1);
    await expect(joinAudits({ organizationId: orgId })).resolves.toEqual([
      {
        organizationId: orgId,
        actorId: joiner.userId,
        action: "member.join",
        resourceId: joiner.userId,
      },
    ]);
  });

  it("refuses to join a soft-deleted organization", async () => {
    const { acceptInvitation, InvitationAcceptError } = await import("@/server/services/members");
    const { orgId, joiners } = await seed(1);
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });

    const refused = acceptInvitation(joiners[0]!.token, joiners[0]!.session);
    await expect(refused).rejects.toBeInstanceOf(InvitationAcceptError);
    await expect(refused).rejects.toMatchObject({ code: "invalid" });
    await expect(members(orgId)).resolves.toBe(1);
  });
});
