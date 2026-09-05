/**
 * Idempotent staging E2E fixture repair: ensures the E2E_USER_EMAIL account
 * has an organization membership, so authenticated Playwright specs reach
 * /dashboard instead of /onboarding. Deliberately does not touch product
 * behavior -- a real user with no organization must still land on
 * /onboarding; this only provisions the *fixture* an org for, mirroring
 * exactly what src/server/services/organizations.ts's createOrganization()
 * does (kept in sync with it manually, since standalone scripts in this repo
 * avoid `@/` path aliases -- see scripts/verify-release-chain.ts).
 *
 * Safe to run on every staging-release: no-ops immediately if the account
 * already has any organization membership.
 */
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PIPELINE_STAGES } from "../src/lib/constants";
import { sanitizeConnectionString } from "../src/server/db/connection-string-sanitizer";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ensure-e2e-org-fixture: missing required env var ${name}`);
  return value;
}

/**
 * This is a one-off admin script, not the deployed serverless app -- it
 * must run against the direct/session database connection, not a
 * transaction-pooler URL meant for the app's own runtime. PrismaClient's
 * query engine always connects via `url`/DATABASE_URL (never `directUrl`,
 * which only `prisma migrate`/`db` CLI commands use), so DATABASE_URL and
 * DIRECT_URL must be the same connection here. Caught staging-release
 * passing them as two different secrets once already (DATABASE_URL's
 * transaction-pooler credentials were rejected outright by Postgres) --
 * this check turns any future drift back into that same mistake into an
 * immediate, clear failure instead of a confusing raw Prisma auth error.
 *
 * Both are sanitized (see connection-string-sanitizer.ts) before this
 * comparison and before use -- staging run 33961238272 failed with
 * `FATAL: database "postgres\n" does not exist`, a trailing newline in the
 * raw secret value that this script's own `new PrismaClient()` call (with no
 * explicit datasourceUrl) never went through the app's own sanitizer to
 * catch, unlike src/server/db/prisma.ts's deployed runtime client.
 */
function requireDirectConnection(): string {
  const databaseUrl = sanitizeConnectionString(requireEnv("DATABASE_URL"));
  const directUrl = sanitizeConnectionString(requireEnv("DIRECT_URL"));
  if (databaseUrl !== directUrl) {
    throw new Error(
      "ensure-e2e-org-fixture: DATABASE_URL and DIRECT_URL must be the same direct/session " +
        "connection for this script -- it is a one-off admin script, not the deployed app, " +
        "and PrismaClient's runtime query engine only ever uses DATABASE_URL/`url`, never " +
        "DIRECT_URL/`directUrl`. Point both at the direct connection secret in the workflow.",
    );
  }
  return databaseUrl;
}

async function main(): Promise<void> {
  const datasourceUrl = requireDirectConnection();
  const email = requireEnv("E2E_USER_EMAIL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const prisma = new PrismaClient({ datasourceUrl });
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      throw new Error(
        `ensure-e2e-org-fixture: no public.users row for ${email} -- the Supabase Auth ` +
          "user must exist and have synced via handle_new_user() before this can run.",
      );
    }

    const existingMembership = await prisma.organizationMember.findFirst({
      where: { userId: user.id },
      select: { id: true, organizationId: true, role: true },
    });
    if (existingMembership) {
      // rbac-boundary.spec.ts temporarily sets this membership's role to
      // MEMBER and restores OWNER in a `finally` block -- but a killed
      // process, a runner cancellation, or a crash between those two points
      // would leave the shared fixture stuck as MEMBER, silently breaking
      // every other authenticated E2E test's write-permission checks on the
      // next run with no obvious cause. This repairs exactly that one field
      // rather than only reporting the org id and returning.
      if (existingMembership.role !== "OWNER") {
        await prisma.organizationMember.update({
          where: { id: existingMembership.id },
          data: { role: "OWNER" },
        });
        console.log(
          `ensure-e2e-org-fixture: ${email}'s membership role was "${existingMembership.role}", not OWNER ` +
            "-- likely a prior interrupted RBAC test run. Restored to OWNER.",
        );
      } else {
        console.log(
          `ensure-e2e-org-fixture: ${email} already has an organization (${existingMembership.organizationId}) -- no-op.`,
        );
      }
      return;
    }

    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name: "Syveka E2E Fixture",
          slug: `syveka-e2e-fixture-${Date.now()}`,
          defaultLocale: "FI",
        },
      });

      await tx.organizationMember.create({
        data: { organizationId: created.id, userId: user.id, role: "OWNER" },
      });

      await tx.subscription.create({
        data: { organizationId: created.id, plan: "FREE", status: "ACTIVE", seats: 1 },
      });

      await tx.pipeline.create({
        data: {
          organizationId: created.id,
          name: "Myyntiputki",
          isDefault: true,
          stages: { create: DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })) },
        },
      });

      return created;
    });

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { last_active_org: org.id },
    });
    if (error) {
      throw new Error(`ensure-e2e-org-fixture: failed to set last_active_org: ${error.message}`);
    }

    console.log(`ensure-e2e-org-fixture: created organization ${org.id} for ${email}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
