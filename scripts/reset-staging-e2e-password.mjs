/**
 * TEMPORARY, one-off script: rotates the password for exactly one existing
 * staging E2E test account via the Supabase Admin API, because the Supabase
 * Dashboard has no direct "set password" control and the account's normal
 * forgot-password web flow could not be used to reach it. Never creates,
 * deletes, or re-identifies the user, and never touches organization
 * membership or app_metadata.last_active_org -- only the password field is
 * included in the Admin API update payload.
 *
 * Delete this file and .github/workflows/staging-e2e-password-reset.yml once
 * the password has been rotated and handed off.
 *
 * Required env: STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 * DATABASE_URL, DIRECT_URL (same value -- see ensure-e2e-org-fixture.ts's
 * requireDirectConnection() precedent: this is a one-off admin script, not
 * the deployed app, so it must use the direct/session connection),
 * PASSWORD_OUTPUT_FILE. TARGET_EMAIL and REQUIRED_PROJECT_REF have safe
 * defaults below but may be overridden for testing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

const TARGET_EMAIL = process.env.TARGET_EMAIL ?? "ehabkia62@gmail.com";
const REQUIRED_PROJECT_REF = process.env.REQUIRED_PROJECT_REF ?? "badkselmhtqglbnszsbz";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`reset-staging-e2e-password: missing required env var ${name}`);
  return value;
}

/**
 * Fails closed before touching Prisma or the Supabase Admin client if the
 * configured URL/connection string don't identify the expected staging
 * project -- mirrors scripts/validate-staging-config.mjs's identity check.
 */
function assertStagingProject(supabaseUrl, databaseUrl) {
  let host;
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    throw new Error("reset-staging-e2e-password: STAGING_SUPABASE_URL is not a valid URL.");
  }
  const expectedHost = `${REQUIRED_PROJECT_REF}.supabase.co`;
  if (host !== expectedHost) {
    throw new Error(
      `reset-staging-e2e-password: STAGING_SUPABASE_URL host (${host}) does not match the required staging project ref ${REQUIRED_PROJECT_REF}.`,
    );
  }

  let db;
  try {
    db = new URL(databaseUrl);
  } catch {
    throw new Error("reset-staging-e2e-password: DATABASE_URL is not a valid connection string.");
  }
  const identifiesProject =
    db.hostname.includes(REQUIRED_PROJECT_REF) || db.username.includes(REQUIRED_PROJECT_REF);
  if (!identifiesProject) {
    throw new Error(
      `reset-staging-e2e-password: DATABASE_URL does not identify the required staging project ref ${REQUIRED_PROJECT_REF}.`,
    );
  }
}

async function membershipSnapshot(prisma, userId) {
  const rows = await prisma.organizationMember.findMany({
    where: { userId },
    select: { organizationId: true, role: true },
    orderBy: { organizationId: "asc" },
  });
  return JSON.stringify(rows);
}

async function main() {
  const supabaseUrl = requireEnv("STAGING_SUPABASE_URL");
  const serviceRoleKey = requireEnv("STAGING_SUPABASE_SERVICE_ROLE_KEY");
  const databaseUrl = requireEnv("DATABASE_URL");
  const passwordFile = requireEnv("PASSWORD_OUTPUT_FILE");

  // Deliberately runs before any Prisma or Supabase client is constructed --
  // a wrong target must fail before it can reach a real connection or API call.
  assertStagingProject(supabaseUrl, databaseUrl);

  const prisma = new PrismaClient();
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const user = await prisma.user.findUnique({
      where: { email: TARGET_EMAIL },
      select: { id: true },
    });
    if (!user) {
      throw new Error(
        `reset-staging-e2e-password: no public.users row for ${TARGET_EMAIL} -- refusing to create one.`,
      );
    }
    const userId = user.id;

    const { data: before, error: beforeError } = await admin.auth.admin.getUserById(userId);
    if (beforeError || !before?.user) {
      throw new Error(
        `reset-staging-e2e-password: could not load the auth user before update: ${beforeError?.message ?? "not found"}`,
      );
    }
    if (before.user.email !== TARGET_EMAIL) {
      throw new Error(
        "reset-staging-e2e-password: public.users and auth.users disagree on this id's email -- refusing to proceed.",
      );
    }
    const beforeLastActiveOrg = before.user.app_metadata?.last_active_org ?? null;
    const beforeMembership = await membershipSnapshot(prisma, userId);

    const password = crypto.randomBytes(24).toString("base64url");
    // Defensive: masks the value from raw log output even though it is never
    // deliberately printed anywhere below.
    console.log(`::add-mask::${password}`);

    const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(userId, {
      password,
    });
    if (updateError) {
      throw new Error(`reset-staging-e2e-password: updateUserById failed: ${updateError.message}`);
    }
    if (updated.user.id !== userId || updated.user.email !== TARGET_EMAIL) {
      throw new Error(
        "reset-staging-e2e-password: Supabase returned a different user id/email after update -- aborting before writing the password file.",
      );
    }

    const { data: after, error: afterError } = await admin.auth.admin.getUserById(userId);
    if (afterError || !after?.user) {
      throw new Error(
        `reset-staging-e2e-password: could not reload the auth user after update: ${afterError?.message ?? "not found"}`,
      );
    }
    const afterLastActiveOrg = after.user.app_metadata?.last_active_org ?? null;
    const afterMembership = await membershipSnapshot(prisma, userId);

    const idUnchanged = after.user.id === userId;
    const membershipUnchanged = afterMembership === beforeMembership;
    const lastActiveOrgUnchanged = afterLastActiveOrg === beforeLastActiveOrg;

    if (!idUnchanged || !membershipUnchanged || !lastActiveOrgUnchanged) {
      throw new Error(
        `reset-staging-e2e-password: post-update verification failed -- id unchanged: ${idUnchanged}, membership unchanged: ${membershipUnchanged}, last_active_org unchanged: ${lastActiveOrgUnchanged}.`,
      );
    }

    fs.writeFileSync(passwordFile, password, { mode: 0o600 });

    console.log(`user id unchanged: ${idUnchanged}`);
    console.log(`membership unchanged: ${membershipUnchanged}`);
    console.log(`last_active_org unchanged: ${lastActiveOrgUnchanged}`);
    console.log(`reset-staging-e2e-password: password reset succeeded for ${TARGET_EMAIL}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
