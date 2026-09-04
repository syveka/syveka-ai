import { PrismaClient, type Role } from "@prisma/client";

/**
 * A real browser session can't seed a second tenant or flip a role — that
 * requires direct database access. This is only available where DATABASE_URL
 * is provided (local dev today; a CI/staging job tomorrow, once someone
 * deliberately wires the secret in — see docs/DEVELOPMENT.md §13). Every spec
 * using this must call hasDbAccess() and skip cleanly when it's false, never
 * fail the run — this is new test infrastructure, not yet part of any
 * required gate.
 */
export function hasDbAccess(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

let client: PrismaClient | null = null;

export function getDbClient(): PrismaClient {
  if (!hasDbAccess()) {
    throw new Error(
      "getDbClient() called without DATABASE_URL set — guard with hasDbAccess() first.",
    );
  }
  if (!client) client = new PrismaClient();
  return client;
}

export type E2EFixtureMembership = {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: Role;
};

/** Resolves the shared E2E fixture user's current org membership row. */
export async function findE2EFixtureMembership(
  prisma: PrismaClient,
): Promise<E2EFixtureMembership> {
  const email = process.env.E2E_USER_EMAIL;
  if (!email) throw new Error("E2E_USER_EMAIL is required to resolve the E2E fixture user.");

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No public.users row for ${email}.`);

  const membership = await prisma.organizationMember.findFirst({
    where: { userId: user.id },
    orderBy: { joinedAt: "asc" },
  });
  if (!membership) throw new Error(`${email} has no organization membership.`);

  return {
    userId: user.id,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    role: membership.role,
  };
}
