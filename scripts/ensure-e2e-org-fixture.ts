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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ensure-e2e-org-fixture: missing required env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const email = requireEnv("E2E_USER_EMAIL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const prisma = new PrismaClient();
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
      select: { organizationId: true },
    });
    if (existingMembership) {
      console.log(
        `ensure-e2e-org-fixture: ${email} already has an organization (${existingMembership.organizationId}) -- no-op.`,
      );
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
