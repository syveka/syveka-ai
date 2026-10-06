import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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

const holder = vi.hoisted(() => ({ client: undefined as unknown }));

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
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: vi.fn(async () => ({})) } } }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));

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
      joiners.push({ userId: user.id, token: invitation.token });
    }
    return { orgId: org.id, joiners };
  }

  const members = (orgId: string) =>
    db.organizationMember.count({ where: { organizationId: orgId } });

  it("lets exactly one of two concurrent acceptances take the last seat", async () => {
    const { acceptInvitation } = await import("@/server/services/members");
    const { EntitlementError } = await import("@/server/services/billing/entitlements");
    const { orgId, joiners } = await seed(2);

    const results = await Promise.allSettled(
      joiners.map((j) => acceptInvitation(j.token, j.userId)),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(EntitlementError);
    await expect(members(orgId)).resolves.toBe(2);

    // The refused invitation is left pending; nothing of it was written.
    const loser = joiners[results.findIndex((r) => r.status === "rejected")]!;
    const invitation = await db.invitation.findFirst({ where: { token: loser.token } });
    expect(invitation?.status).toBe("PENDING");
  });

  it("refuses to join a soft-deleted organization", async () => {
    const { acceptInvitation } = await import("@/server/services/members");
    const { orgId, joiners } = await seed(1);
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });

    await expect(acceptInvitation(joiners[0]!.token, joiners[0]!.userId)).rejects.toThrow(
      "Invalid invitation",
    );
    await expect(members(orgId)).resolves.toBe(1);
  });
});
