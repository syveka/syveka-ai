/**
 * TEMPORARY, read-mostly diagnostic: proves (or rules out) why the staging
 * E2E account's password grant is failing, without ever printing the
 * password, tokens, or any other secret.
 *
 * The only state-changing call it makes is the password-grant sign-in
 * itself (POST /auth/v1/token?grant_type=password), which Supabase treats
 * as a normal login attempt, and does not create, delete, or modify the
 * user. Everything else is read-only (GET .../admin/users/{id}, Prisma
 * reads).
 *
 * Delete this file and its workflow once the staging auth incident is
 * closed, see .github/workflows/staging-auth-diagnostic.yml.
 *
 * Required env: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,
 * STAGING_SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, E2E_USER_EMAIL,
 * E2E_USER_PASSWORD (the exact same four secret names the staging-release
 * workflow's Playwright step already uses, so this reproduces precisely
 * what CI sees). REQUIRED_PROJECT_REF has a safe default but may be
 * overridden for testing.
 */
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

const REQUIRED_PROJECT_REF = process.env.REQUIRED_PROJECT_REF ?? "badkselmhtqglbnszsbz";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`diagnose-staging-e2e-auth: missing required env var ${name}`);
  return value;
}

function assertStagingProject(supabaseUrl, databaseUrl) {
  const host = new URL(supabaseUrl).hostname;
  const expectedHost = `${REQUIRED_PROJECT_REF}.supabase.co`;
  if (host !== expectedHost) {
    throw new Error(
      `diagnose-staging-e2e-auth: STAGING_SUPABASE_URL host (${host}) does not match ${REQUIRED_PROJECT_REF}.`,
    );
  }
  const db = new URL(databaseUrl);
  const identifiesProject =
    db.hostname.includes(REQUIRED_PROJECT_REF) || db.username.includes(REQUIRED_PROJECT_REF);
  if (!identifiesProject) {
    throw new Error(
      "diagnose-staging-e2e-auth: DATABASE_URL does not identify the required staging project ref.",
    );
  }
}

/** True for any C0 control character or DEL, other than plain CR/LF. */
function hasOtherControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isCrOrLf = code === 10 || code === 13;
    if (!isCrOrLf && (code < 32 || code === 127)) return true;
  }
  return false;
}

function whitespaceShape(value) {
  return {
    length: value.length,
    hasLeadingOrTrailingWhitespace: value !== value.trim(),
    containsCRorLF: value.includes("\r") || value.includes("\n"),
    containsOtherControlChars: hasOtherControlChars(value),
  };
}

/** Direct REST call (not supabase-js) so we see the exact raw HTTP status/body Playwright's own login flow ultimately depends on. */
async function passwordGrant(supabaseUrl, anonKey, email, password) {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    ok: res.ok,
    errorCode: body.error_code ?? body.error ?? null,
    errorDescription: body.error_description ?? body.msg ?? null,
    hasSession: Boolean(body.access_token && body.refresh_token),
    userId: res.ok ? (body.user?.id ?? null) : null,
  };
}

async function main() {
  const supabaseUrl = requireEnv("STAGING_SUPABASE_URL");
  const anonKey = requireEnv("STAGING_SUPABASE_ANON_KEY");
  const serviceRoleKey = requireEnv("STAGING_SUPABASE_SERVICE_ROLE_KEY");
  const databaseUrl = requireEnv("DATABASE_URL");
  const email = requireEnv("E2E_USER_EMAIL");
  const rawPassword = requireEnv("E2E_USER_PASSWORD");

  assertStagingProject(supabaseUrl, databaseUrl);

  console.log("=== credential shape (no secret values printed) ===");
  console.log(`email length: ${email.length}`);
  console.log(`email has leading/trailing whitespace: ${email !== email.trim()}`);
  console.log("password shape:", JSON.stringify(whitespaceShape(rawPassword)));

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const prisma = new PrismaClient();

  try {
    console.log("\n=== public.users / organization membership (read-only) ===");
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      console.log("No public.users row for this email, cannot cross-check auth.users.");
    } else {
      console.log("public.users row found, id present: true");
      const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(user.id);
      if (authUserError || !authUser?.user) {
        console.log(`auth.users lookup by id FAILED: ${authUserError?.message ?? "not found"}`);
      } else {
        const u = authUser.user;
        console.log(`auth.users.email matches public.users.email: ${u.email === email}`);
        console.log(`email_confirmed_at: ${u.email_confirmed_at ?? "null (NOT CONFIRMED)"}`);
        console.log(`banned_until: ${u.banned_until ?? "null (not banned)"}`);
        console.log(`last_sign_in_at: ${u.last_sign_in_at ?? "null (never signed in)"}`);
        console.log(`updated_at: ${u.updated_at ?? "unknown"}`);
        console.log(
          `identities/providers: ${JSON.stringify((u.identities ?? []).map((i) => i.provider))}`,
        );
        console.log(
          `app_metadata keys present: ${JSON.stringify(Object.keys(u.app_metadata ?? {}))}`,
        );
        console.log(
          `app_metadata.last_active_org present: ${Boolean(u.app_metadata?.last_active_org)}`,
        );
      }

      const memberships = await prisma.organizationMember.findMany({
        where: { userId: user.id },
        select: { organizationId: true, role: true, organization: { select: { deletedAt: true } } },
      });
      console.log(`organization membership rows: ${memberships.length}`);
      for (const m of memberships) {
        console.log(
          `  - orgId present: true, role: ${m.role}, org deleted: ${Boolean(m.organization.deletedAt)}`,
        );
      }
    }

    console.log(
      "\n=== password grant: raw value from E2E_USER_PASSWORD (exactly what CI sends) ===",
    );
    const rawResult = await passwordGrant(supabaseUrl, anonKey, email, rawPassword);
    console.log(JSON.stringify(rawResult, null, 2));

    const trimmed = rawPassword.trim();
    if (trimmed !== rawPassword) {
      console.log(
        "\n=== password grant: trimmed value (whitespace-corruption hypothesis check) ===",
      );
      const trimmedResult = await passwordGrant(supabaseUrl, anonKey, email, trimmed);
      console.log(JSON.stringify(trimmedResult, null, 2));
      if (trimmedResult.ok && !rawResult.ok) {
        console.log(
          "\n*** DIAGNOSIS: the raw secret has leading/trailing whitespace that breaks the " +
            "password grant, but the trimmed value authenticates successfully. The secret's " +
            "value was corrupted during copy/paste (or similar); the underlying Supabase " +
            "password itself is fine. ***",
        );
      }
    } else {
      console.log(
        "\n(raw password already has no leading/trailing whitespace, trimmed check skipped)",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
