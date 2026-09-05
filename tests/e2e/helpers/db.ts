import { PrismaClient, type Role } from "@prisma/client";
import { sanitizeConnectionString } from "../../../src/server/db/connection-string-sanitizer";

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
  // Staging run 33961238272 failed because a raw, unsanitized DATABASE_URL
  // carried a trailing newline (see connection-string-sanitizer.ts) — this
  // helper is a second, independent consumer of the same secret, alongside
  // src/server/db/prisma.ts (the deployed app) and
  // scripts/ensure-e2e-org-fixture.ts, so it needs the same sanitization.
  if (!client) {
    client = new PrismaClient({
      datasourceUrl: sanitizeConnectionString(process.env.DATABASE_URL!),
    });
  }
  return client;
}

const EXPECTED_E2E_FIXTURE_ORG_NAME = "Syveka E2E Fixture";

export type E2EFixtureMembership = {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: Role;
};

/**
 * Resolves the shared E2E fixture user's current org membership row.
 * Refuses to return a membership whose organization name doesn't exactly
 * match the fixture name scripts/ensure-e2e-org-fixture.ts creates — a
 * refuse-to-run guard so that rbac-boundary.spec.ts's role mutation (and any
 * other DB-gated mutation built on this helper) can never act on a real
 * customer organization even if DATABASE_URL/E2E_USER_EMAIL were ever
 * accidentally pointed at a non-fixture environment.
 */
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
    include: { organization: { select: { name: true } } },
  });
  if (!membership) throw new Error(`${email} has no organization membership.`);
  if (membership.organization.name !== EXPECTED_E2E_FIXTURE_ORG_NAME) {
    throw new Error(
      `Refusing to proceed: ${email}'s organization is named "${membership.organization.name}", ` +
        `not the expected E2E fixture name "${EXPECTED_E2E_FIXTURE_ORG_NAME}". This guard exists so ` +
        "a misconfigured DATABASE_URL/E2E_USER_EMAIL can never let a mutating E2E test act on a " +
        "real organization.",
    );
  }

  return {
    userId: user.id,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    role: membership.role,
  };
}
