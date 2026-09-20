/**
 * READ-ONLY staging diagnostic, scoped to exactly one account:
 * Ehabkia62@gmail.com. Investigates the "redirected to Create your
 * organization after authentication" regression by comparing Supabase
 * Auth state against this app's own public.users / organization_members /
 * organizations tables -- the same tables getTenantContext() (see
 * src/server/auth/session.ts) reads at request time.
 *
 * Performs NO writes of any kind: no user/org/membership creation, update,
 * or deletion; no app_metadata changes; no password resets; no
 * organization creation (contrast scripts/ensure-e2e-org-fixture.ts, which
 * repairs -- this script only reports).
 *
 * Prints only UUIDs, booleans, timestamps, and the single
 * app_metadata.last_active_org claim value (itself just a UUID or null) --
 * never tokens, passwords, connection strings, service-role keys, or any
 * other Supabase Auth metadata field.
 */
import { PrismaClient } from "../src/generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "@supabase/supabase-js";

const DIAGNOSTIC_EMAIL = "Ehabkia62@gmail.com";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`diagnose-staging-auth-membership: missing required env var ${name}`);
  return value;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * This is a one-off, read-only admin script, not the deployed serverless
 * app -- see ensure-e2e-org-fixture.ts's identical rationale for requiring
 * the direct/session connection rather than the app's transaction-pooler
 * DATABASE_URL.
 */
function requireDirectConnection(): string {
  const databaseUrl = requireEnv("DATABASE_URL");
  const directUrl = requireEnv("DIRECT_URL");
  if (databaseUrl !== directUrl) {
    throw new Error(
      "diagnose-staging-auth-membership: DATABASE_URL and DIRECT_URL must be the same " +
        "direct/session connection for this script.",
    );
  }
  return databaseUrl;
}

async function main(): Promise<void> {
  const requestedEmail = requireEnv("DIAGNOSTIC_EMAIL");
  if (normalizeEmail(requestedEmail) !== normalizeEmail(DIAGNOSTIC_EMAIL)) {
    throw new Error(
      "diagnose-staging-auth-membership: DIAGNOSTIC_EMAIL does not match the single " +
        "account this script is scoped to inspect. Refusing to run against a different account.",
    );
  }
  const normalizedEmail = normalizeEmail(DIAGNOSTIC_EMAIL);

  const databaseUrl = requireDirectConnection();
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // ── B) public.users ──
    const publicUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });

    // ── A) Supabase Auth ──
    let authUserId: string | null = null;
    let authEmail: string | null = null;
    let lastActiveOrg: string | null = null;
    let authUserFound = false;

    if (publicUser) {
      const { data, error } = await admin.auth.admin.getUserById(publicUser.id);
      if (error) {
        console.error(`diagnose-staging-auth-membership: getUserById failed (${error.name})`);
      } else if (data.user) {
        authUserFound = true;
        authUserId = data.user.id;
        authEmail = data.user.email ?? null;
        lastActiveOrg =
          ((data.user.app_metadata as Record<string, unknown> | null)?.last_active_org as
            string | undefined) ?? null;
      }
    } else {
      // No public.users row to derive the auth id from -- bounded,
      // best-effort scan by email instead. This Supabase JS version has no
      // getUserByEmail; capped at one page so this never turns into an
      // unbounded full-table dump.
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) {
        console.error(`diagnose-staging-auth-membership: listUsers failed (${error.name})`);
      } else {
        const match = data.users.find((u) => normalizeEmail(u.email ?? "") === normalizedEmail);
        if (match) {
          authUserFound = true;
          authUserId = match.id;
          authEmail = match.email ?? null;
          lastActiveOrg =
            ((match.app_metadata as Record<string, unknown> | null)?.last_active_org as
              string | undefined) ?? null;
        }
      }
    }

    // ── C) organization_members ──
    const memberships = authUserId
      ? await prisma.organizationMember.findMany({
          where: { userId: authUserId },
          select: { organizationId: true, role: true, joinedAt: true },
        })
      : [];

    // ── D) organizations referenced by either a membership or the claim ──
    const referencedOrgIds = [
      ...new Set([
        ...memberships.map((m) => m.organizationId),
        ...(lastActiveOrg ? [lastActiveOrg] : []),
      ]),
    ];
    const organizations = referencedOrgIds.length
      ? await prisma.organization.findMany({
          where: { id: { in: referencedOrgIds } },
          select: { id: true, deletedAt: true },
        })
      : [];
    const orgById = new Map(organizations.map((o) => [o.id, o] as const));

    // ── E) classification ──
    const authUserVerdict = authUserFound ? "OK" : "MISSING";

    const publicUserVerdict = !publicUser
      ? "MISSING"
      : authUserId && publicUser.id !== authUserId
        ? "ID_MISMATCH"
        : "OK";

    const activeMemberships = memberships.filter((m) => orgById.get(m.organizationId));
    const membershipVerdict =
      memberships.length === 0
        ? "MISSING"
        : activeMemberships.length < memberships.length
          ? "INVALID"
          : "OK";

    const anyOrgSoftDeleted = memberships.some((m) => orgById.get(m.organizationId)?.deletedAt);
    const organizationVerdict =
      memberships.length === 0
        ? "MISSING"
        : anyOrgSoftDeleted
          ? "DELETED"
          : activeMemberships.length === memberships.length
            ? "OK"
            : "MISSING";

    const claimResolvesToUsableMembership = Boolean(
      lastActiveOrg &&
      memberships.some((m) => m.organizationId === lastActiveOrg) &&
      !orgById.get(lastActiveOrg)?.deletedAt,
    );
    const lastActiveOrgVerdict = !lastActiveOrg
      ? "MISSING"
      : claimResolvesToUsableMembership
        ? "OK"
        : "STALE";

    console.log("=== diagnose-staging-auth-membership ===");
    console.log(`account: ${normalizedEmail}`);
    console.log("");
    console.log(`AUTH USER: ${authUserVerdict}`);
    if (authUserId) console.log(`  auth.users.id: ${authUserId}`);
    if (authEmail)
      console.log(
        `  auth email normalized match: ${normalizeEmail(authEmail) === normalizedEmail}`,
      );
    console.log(`  app_metadata.last_active_org: ${lastActiveOrg ?? "null"}`);
    console.log("");

    console.log(`PUBLIC USER: ${publicUserVerdict}`);
    if (publicUser) {
      console.log(`  public.users.id: ${publicUser.id}`);
      console.log(
        `  public email normalized match: ${normalizeEmail(publicUser.email) === normalizedEmail}`,
      );
    }
    console.log("");

    console.log(`MEMBERSHIP: ${membershipVerdict}`);
    for (const m of memberships) {
      console.log(
        `  organizationId=${m.organizationId} role=${m.role} joinedAt=${m.joinedAt.toISOString()}`,
      );
    }
    if (memberships.length === 0) console.log("  (none)");
    console.log("");

    console.log(`ORGANIZATION: ${organizationVerdict}`);
    for (const o of organizations) {
      console.log(
        `  id=${o.id} state=${o.deletedAt ? `deleted@${o.deletedAt.toISOString()}` : "active"}`,
      );
    }
    if (organizations.length === 0) console.log("  (none referenced)");
    console.log("");

    console.log(`LAST_ACTIVE_ORG: ${lastActiveOrgVerdict}`);
    console.log("");

    console.log("=== cross-check ===");
    console.log(
      `auth.users.id === public.users.id: ${
        authUserId && publicUser ? String(authUserId === publicUser.id) : "n/a"
      }`,
    );
    console.log(
      `last_active_org resolves to a usable, active membership: ${
        lastActiveOrg ? String(claimResolvesToUsableMembership) : "n/a (no claim set)"
      }`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "diagnose-staging-auth-membership: unknown error",
  );
  process.exit(1);
});
