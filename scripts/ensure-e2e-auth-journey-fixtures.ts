/**
 * Staging-only fixtures for the opt-in auth journey E2E spec
 * (tests/e2e/auth-journeys.spec.ts). Touches exactly two test identities:
 *
 * - The existing staging E2E account (E2E_USER_EMAIL): its password is set
 *   back to the E2E_USER_PASSWORD secret, because the password-recovery
 *   journey deliberately changes it. Run with `prepare` before the journey
 *   and `restore` after it (always), so a failed run cannot leave the shared
 *   E2E account with an unknown password.
 * - A dedicated no-membership account, derived from E2E_USER_EMAIL as a
 *   `+no-org` sub-address. Created on first use (email pre-confirmed, so no
 *   email is sent), given a fresh random password on every `prepare`, and
 *   required to have zero organization memberships -- it proves a genuine
 *   new user still gets onboarding. If it ever has a membership, this script
 *   fails closed rather than deleting anything.
 *
 * Never logs an email, user id, password or token. Values handed to later
 * workflow steps are masked with `::add-mask::` before being written to
 * $GITHUB_ENV.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

const LOG_PREFIX = "ensure-e2e-auth-journey-fixtures";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${LOG_PREFIX}: missing required env var ${name}`);
  return value;
}

function subAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    throw new Error(`${LOG_PREFIX}: E2E_USER_EMAIL is not a valid email address`);
  }
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

function exportMasked(name: string, value: string): void {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) throw new Error(`${LOG_PREFIX}: GITHUB_ENV is not set`);
  console.log(`::add-mask::${value}`);
  appendFileSync(githubEnv, `${name}=${value}\n`, { encoding: "utf8" });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "prepare" && mode !== "restore") {
    throw new Error(`${LOG_PREFIX}: usage: ensure-e2e-auth-journey-fixtures.ts prepare|restore`);
  }

  const e2eEmail = requireEnv("E2E_USER_EMAIL");
  const e2ePassword = requireEnv("E2E_USER_PASSWORD");
  const noOrgEmail = subAddress(e2eEmail, "no-org");
  const admin = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const db = new Client({ connectionString: requireEnv("DIRECT_URL") });
  await db.connect();

  try {
    const findUserId = async (email: string): Promise<string | null> => {
      const { rows } = await db.query<{ id: string }>(
        "select id from auth.users where lower(email) = lower($1)",
        [email],
      );
      if (rows.length > 1) throw new Error(`${LOG_PREFIX}: ambiguous auth user lookup`);
      return rows[0]?.id ?? null;
    };

    const e2eUserId = await findUserId(e2eEmail);
    if (!e2eUserId) throw new Error(`${LOG_PREFIX}: the staging E2E auth user does not exist`);
    const restored = await admin.auth.admin.updateUserById(e2eUserId, { password: e2ePassword });
    if (restored.error) throw new Error(`${LOG_PREFIX}: failed to restore the E2E user password`);
    console.log(`${LOG_PREFIX}: E2E user password set to the configured secret.`);

    if (mode === "restore") return;

    const noOrgPassword = randomBytes(24).toString("base64url");
    let noOrgUserId = await findUserId(noOrgEmail);
    if (noOrgUserId) {
      const updated = await admin.auth.admin.updateUserById(noOrgUserId, {
        password: noOrgPassword,
      });
      if (updated.error) throw new Error(`${LOG_PREFIX}: failed to rotate the no-org password`);
    } else {
      const created = await admin.auth.admin.createUser({
        email: noOrgEmail,
        password: noOrgPassword,
        email_confirm: true,
        app_metadata: { e2e_fixture: "no-membership" },
      });
      if (created.error || !created.data.user) {
        throw new Error(`${LOG_PREFIX}: failed to create the no-org test user`);
      }
      noOrgUserId = created.data.user.id;
      console.log(`${LOG_PREFIX}: created the dedicated no-membership test user.`);
    }

    const { rows } = await db.query<{ memberships: number }>(
      "select count(*)::int as memberships from public.organization_members where user_id = $1",
      [noOrgUserId],
    );
    if ((rows[0]?.memberships ?? 0) !== 0) {
      throw new Error(
        `${LOG_PREFIX}: the no-org test user has an organization membership; refusing to ` +
          "continue (it must stay membership-free to prove onboarding). Nothing was deleted.",
      );
    }

    exportMasked("E2E_NO_ORG_USER_EMAIL", noOrgEmail);
    exportMasked("E2E_NO_ORG_USER_PASSWORD", noOrgPassword);
    exportMasked("E2E_RECOVERY_USER_ID", e2eUserId);
    console.log(`${LOG_PREFIX}: fixtures ready.`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  // Messages above are fixed strings; anything else is reduced to its name.
  const message =
    error instanceof Error && error.message.startsWith(LOG_PREFIX)
      ? error.message
      : `${LOG_PREFIX}: unexpected ${error instanceof Error ? error.name : "error"}`;
  console.error(message);
  process.exit(1);
});
