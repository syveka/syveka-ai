import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { findE2EFixtureMembership } from "../e2e/helpers/db";

/**
 * findE2EFixtureMembership()'s refuse-to-run guard is the last line of
 * defense against a mutating E2E test (rbac-boundary.spec.ts's role flip)
 * ever acting on a real organization if DATABASE_URL/E2E_USER_EMAIL were
 * ever misconfigured to point somewhere other than the fixture environment.
 * A fake, minimally duck-typed Prisma client is enough here -- this is
 * testing the guard logic itself, not real database behavior.
 */
function fakePrisma(options: {
  user: { id: string } | null;
  membership: { id: string; organizationId: string; role: string; organizationName: string } | null;
}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(options.user),
    },
    organizationMember: {
      findFirst: vi.fn().mockResolvedValue(
        options.membership
          ? {
              id: options.membership.id,
              organizationId: options.membership.organizationId,
              role: options.membership.role,
              organization: { name: options.membership.organizationName },
            }
          : null,
      ),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("findE2EFixtureMembership", () => {
  beforeEach(() => {
    process.env.E2E_USER_EMAIL = "e2e-fixture@example.invalid";
  });

  afterEach(() => {
    delete process.env.E2E_USER_EMAIL;
  });

  it("resolves the membership when the organization is exactly the expected fixture", async () => {
    const prisma = fakePrisma({
      user: { id: "user-1" },
      membership: {
        id: "membership-1",
        organizationId: "org-1",
        role: "OWNER",
        organizationName: "Syveka E2E Fixture",
      },
    });

    const result = await findE2EFixtureMembership(prisma);
    expect(result).toEqual({
      userId: "user-1",
      organizationId: "org-1",
      membershipId: "membership-1",
      role: "OWNER",
    });
  });

  it("refuses to proceed when the organization name doesn't exactly match the fixture name", async () => {
    const prisma = fakePrisma({
      user: { id: "user-1" },
      membership: {
        id: "membership-1",
        organizationId: "org-1",
        role: "OWNER",
        organizationName: "A Real Customer Organization",
      },
    });

    await expect(findE2EFixtureMembership(prisma)).rejects.toThrow(/Refusing to proceed/);
  });

  it("throws clearly when no E2E_USER_EMAIL is set", async () => {
    delete process.env.E2E_USER_EMAIL;
    const prisma = fakePrisma({ user: null, membership: null });
    await expect(findE2EFixtureMembership(prisma)).rejects.toThrow("E2E_USER_EMAIL is required");
  });

  it("throws clearly when no public.users row exists for the email", async () => {
    const prisma = fakePrisma({ user: null, membership: null });
    await expect(findE2EFixtureMembership(prisma)).rejects.toThrow("No public.users row for");
  });

  it("throws clearly when the user has no organization membership", async () => {
    const prisma = fakePrisma({ user: { id: "user-1" }, membership: null });
    await expect(findE2EFixtureMembership(prisma)).rejects.toThrow(
      "has no organization membership",
    );
  });
});
